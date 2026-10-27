// Shootout driver for the Highway engine; the same steps as the Rust and C# drivers (README.md).
//   blur-highway <case.bin> <case.ref> <out file or -> <reps>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>
#ifdef _WIN32
#include <windows.h>
#include <psapi.h>
#else
#include <sys/resource.h>
#endif

namespace blur {
void BlurDispatch(const float* src, float* out, float* tmp, int w, int h, const float* k, int r, int x0, int x1,
                  int y0, int y1, int by0, int by1);
const char* TargetDispatch();
}  // namespace blur

struct Call {
  int r, x0, x1, y0, y1, by0, by1;
  std::vector<float> k, src;
};

static std::vector<char> ReadAll(const char* path) {
  std::ifstream f(path, std::ios::binary);
  return std::vector<char>(std::istreambuf_iterator<char>(f), {});
}

int main(int argc, char** argv) {
  if (argc < 5) return 2;
  const std::vector<char> bin = ReadAll(argv[1]), ref = ReadAll(argv[2]);
  const int reps = std::atoi(argv[4]);
  size_t o = 0;
  auto i32 = [&]() { int v; memcpy(&v, bin.data() + o, 4); o += 4; return v; };
  if (bin.size() < 16 || memcmp(bin.data(), "BLR1", 4)) return 3;
  o = 4;
  const int w = i32(), h = i32(), n = i32();
  std::vector<Call> calls(n);
  for (Call& c : calls) {
    o += 8;  // sigma
    c.r = i32(); c.x0 = i32(); c.x1 = i32(); c.y0 = i32(); c.y1 = i32(); c.by0 = i32(); c.by1 = i32();
    const int bx0 = i32(), bx1 = i32();
    c.k.resize(2 * c.r + 1);
    memcpy(c.k.data(), bin.data() + o, c.k.size() * 4);
    o += c.k.size() * 4;
    c.src.assign(size_t(w) * h, 0.f);
    for (int y = c.by0; y <= c.by1; y++, o += size_t(bx1 - bx0 + 1) * 4) memcpy(&c.src[size_t(y) * w + bx0], bin.data() + o, size_t(bx1 - bx0 + 1) * 4);
  }
  std::vector<float> out(size_t(w) * h), tmp(size_t(w) * h);
  auto pass = [&]() {
    for (const Call& c : calls) blur::BlurDispatch(c.src.data(), out.data(), tmp.data(), w, h, c.k.data(), c.r, c.x0, c.x1, c.y0, c.y1, c.by0, c.by1);
  };

  // Check every call against the TypeScript output, and keep this engine's output.
  const float* want = reinterpret_cast<const float*>(ref.data());
  double maxDiff = 0;
  long flips = 0, checked = 0;
  std::FILE* save = strcmp(argv[3], "-") ? std::fopen(argv[3], "wb") : nullptr;
  for (const Call& c : calls) {
    blur::BlurDispatch(c.src.data(), out.data(), tmp.data(), w, h, c.k.data(), c.r, c.x0, c.x1, c.y0, c.y1, c.by0, c.by1);
    for (int y = c.y0; y <= c.y1; y++) {
      const float* got = &out[size_t(y) * w + c.x0];
      for (int x = 0; x <= c.x1 - c.x0; x++, want++, checked++) {
        maxDiff = std::max(maxDiff, std::fabs(double(got[x]) - double(*want)));
        if ((got[x] >= 0.5f) != (*want >= 0.5f)) flips++;
      }
      if (save) std::fwrite(got, 4, c.x1 - c.x0 + 1, save);
    }
  }
  if (save) std::fclose(save);

  using clock = std::chrono::steady_clock;
  const auto warm = clock::now();
  for (int i = 0; i < 10 || clock::now() - warm < std::chrono::milliseconds(500); i++) pass();
  std::vector<double> ms;
  for (int i = 0; i < reps; i++) {
    const auto t0 = clock::now();
    pass();
    ms.push_back(std::chrono::duration<double, std::milli>(clock::now() - t0).count());
  }
  std::sort(ms.begin(), ms.end());
#ifdef _WIN32
  PROCESS_MEMORY_COUNTERS pmc{};
  GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof(pmc));
  const double peakMb = pmc.PeakWorkingSetSize / 1048576.0;
#else
  rusage ru{};
  getrusage(RUSAGE_SELF, &ru);
  const double peakMb = ru.ru_maxrss / 1024.0;
#endif
  std::printf("{\"engine\":\"C++ + Highway\",\"target\":\"%s\",\"w\":%d,\"h\":%d,\"calls\":%d,\"reps\":%d,\"median_ms\":%.4f,\"min_ms\":%.4f,\"p90_ms\":%.4f,\"max_diff\":%.3g,\"flips\":%ld,\"checked\":%ld,\"peak_mb\":%.1f}\n",
              blur::TargetDispatch(), w, h, n, reps, ms[ms.size() / 2], ms[0], ms[ms.size() * 9 / 10], maxDiff, flips, checked, peakMb);
  return 0;
}
