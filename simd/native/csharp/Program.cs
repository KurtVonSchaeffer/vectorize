// The tracer's Gaussian blur with C# + .NET SIMD (Vector<float>), and its shootout driver: the same
// steps as the C++ and Rust drivers (simd/native/README.md).
//   blur-dotnet <case.bin> <case.ref> <out file or -> <reps>
using System.Buffers.Binary;
using System.Diagnostics;
using System.Numerics;
using System.Runtime.InteropServices;

static class BlurKernel
{
    // Same algorithm as simd/cpp-highway/blur.cc: N outputs at a time where every tap is inside the
    // row, scalar at the edges; the vertical pass does N columns at once.
    public static void Blur(ReadOnlySpan<float> src, Span<float> output, Span<float> tmp, int w, int h, ReadOnlySpan<float> k, int r,
                            int x0, int x1, int y0, int y1, int by0, int by1)
    {
        int n = Vector<float>.Count;
        output.Clear();
        tmp.Clear();
        int taps = 2 * r + 1;
        Span<Vector<float>> ks = stackalloc Vector<float>[taps];
        for (int i = 0; i < taps; i++) ks[i] = new Vector<float>(k[i]);
        ref float s0 = ref MemoryMarshal.GetReference(src);
        ref float t0 = ref MemoryMarshal.GetReference(tmp);
        ref float o0 = ref MemoryMarshal.GetReference(output);

        int lo = Math.Max(r, x0);
        int hi = Math.Min(w - r, x1 + 1); // exclusive: x + r < w
        for (int y = by0; y <= by1; y++)
        {
            int row = y * w;
            for (int x = x0; x <= x1;)
            {
                if (x >= lo && x + n <= hi)
                {
                    var s = Vector<float>.Zero;
                    for (int i = 0; i < taps; i++) s = Vector.FusedMultiplyAdd(Vector.LoadUnsafe(ref s0, (nuint)(row + x + i - r)), ks[i], s);
                    s.StoreUnsafe(ref t0, (nuint)(row + x));
                    x += n;
                }
                else
                {
                    float s = 0;
                    for (int i = 0; i < taps; i++) s += src[row + Math.Clamp(x + i - r, 0, w - 1)] * k[i];
                    tmp[row + x] = s;
                    x++;
                }
            }
        }

        Span<int> rows = stackalloc int[taps];
        for (int y = y0; y <= y1; y++)
        {
            for (int i = 0; i < taps; i++) rows[i] = Math.Clamp(y + i - r, 0, h - 1) * w;
            for (int x = x0; x <= x1;)
            {
                if (x + n <= x1 + 1)
                {
                    var s = Vector<float>.Zero;
                    for (int i = 0; i < taps; i++) s = Vector.FusedMultiplyAdd(Vector.LoadUnsafe(ref t0, (nuint)(rows[i] + x)), ks[i], s);
                    s.StoreUnsafe(ref o0, (nuint)(y * w + x));
                    x += n;
                }
                else
                {
                    float s = 0;
                    for (int i = 0; i < taps; i++) s += tmp[rows[i] + x] * k[i];
                    output[y * w + x] = s;
                    x++;
                }
            }
        }
    }
}

record Call(int R, int X0, int X1, int Y0, int Y1, int By0, int By1, float[] K, float[] Src);

static class Program
{
    static int Main(string[] args)
    {
        byte[] bin = File.ReadAllBytes(args[0]);
        float[] reference = MemoryMarshal.Cast<byte, float>(File.ReadAllBytes(args[1])).ToArray();
        int reps = int.Parse(args[3]);
        if (bin[0] != 'B' || bin[1] != 'L' || bin[2] != 'R' || bin[3] != '1') return 3;
        int o = 4;
        int I32() { int v = BinaryPrimitives.ReadInt32LittleEndian(bin.AsSpan(o)); o += 4; return v; }
        float[] Floats(int count) { var f = MemoryMarshal.Cast<byte, float>(bin.AsSpan(o, count * 4)).ToArray(); o += count * 4; return f; }
        int w = I32(), h = I32(), n = I32();
        var calls = new Call[n];
        for (int c = 0; c < n; c++)
        {
            o += 8; // sigma
            int r = I32(), x0 = I32(), x1 = I32(), y0 = I32(), y1 = I32(), by0 = I32(), by1 = I32(), bx0 = I32(), bx1 = I32();
            float[] k = Floats(2 * r + 1);
            var src = new float[w * h];
            for (int y = by0; y <= by1; y++) Floats(bx1 - bx0 + 1).CopyTo(src, y * w + bx0);
            calls[c] = new Call(r, x0, x1, y0, y1, by0, by1, k, src);
        }
        var output = new float[w * h];
        var tmp = new float[w * h];
        void Run(Call c) => BlurKernel.Blur(c.Src, output, tmp, w, h, c.K, c.R, c.X0, c.X1, c.Y0, c.Y1, c.By0, c.By1);

        // Check every call against the TypeScript output, and keep this engine's output.
        double maxDiff = 0;
        long flips = 0;
        int checkedPx = 0;
        using (var save = args[2] != "-" ? File.Create(args[2]) : null)
            foreach (var c in calls)
            {
                Run(c);
                for (int y = c.Y0; y <= c.Y1; y++)
                {
                    var got = output.AsSpan(y * w + c.X0, c.X1 - c.X0 + 1);
                    foreach (float g in got)
                    {
                        float want = reference[checkedPx++];
                        maxDiff = Math.Max(maxDiff, Math.Abs((double)g - want));
                        if (g >= 0.5f != want >= 0.5f) flips++;
                    }
                    save?.Write(MemoryMarshal.AsBytes(got));
                }
            }

        // Warm-up also lets the JIT's tiered compilation reach its optimised code.
        var warm = Stopwatch.StartNew();
        for (int i = 0; i < 10 || warm.ElapsedMilliseconds < 500; i++) foreach (var c in calls) Run(c);
        var ms = new double[reps];
        for (int i = 0; i < reps; i++)
        {
            long t = Stopwatch.GetTimestamp();
            foreach (var c in calls) Run(c);
            ms[i] = Stopwatch.GetElapsedTime(t).TotalMilliseconds;
        }
        Array.Sort(ms);
        string target = Vector<float>.Count switch { 16 => "Vector512 (AVX-512)", 8 => "Vector256 (AVX2)", 4 => "Vector128 (SSE)", _ => $"{Vector<float>.Count} lanes" };
        string I(double v) => v.ToString("0.####", System.Globalization.CultureInfo.InvariantCulture);
        Console.WriteLine($"{{\"engine\":\"C# + .NET SIMD\",\"target\":\"{target}\",\"w\":{w},\"h\":{h},\"calls\":{n},\"reps\":{reps},\"median_ms\":{I(ms[reps / 2])},\"min_ms\":{I(ms[0])},\"p90_ms\":{I(ms[reps * 9 / 10])},\"max_diff\":{maxDiff.ToString("0.###e+0", System.Globalization.CultureInfo.InvariantCulture)},\"flips\":{flips},\"checked\":{checkedPx},\"peak_mb\":{I(Process.GetCurrentProcess().PeakWorkingSet64 / 1048576.0)}}}");
        return 0;
    }
}
