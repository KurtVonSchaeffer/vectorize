// The tracer's Gaussian blur with Rust + pulp, native x64, and its shootout driver: the same steps
// as the C++ and C# drivers (simd/native/README.md).
//   blur-pulp <case.bin> <case.ref> <out file or -> <reps>
use pulp::{Arch, Simd, WithSimd};
use std::io::Write;
use std::time::{Duration, Instant};

const MAX_TAPS: usize = 33;

struct Blur<'a> {
	src: &'a [f32],
	out: &'a mut [f32],
	tmp: &'a mut [f32],
	w: usize,
	h: usize,
	k: &'a [f32],
	r: usize,
	x0: usize,
	x1: usize,
	y0: usize,
	y1: usize,
	by0: usize,
	by1: usize,
}

impl WithSimd for Blur<'_> {
	type Output = ();

	// Same algorithm as simd/cpp-highway/blur.cc: N outputs at a time where every tap is inside the
	// row, scalar at the edges; the vertical pass does N columns at once.
	#[inline(always)]
	fn with_simd<S: Simd>(self, simd: S) {
		let Blur { src, out, tmp, w, h, k, r, x0, x1, y0, y1, by0, by1 } = self;
		let n = size_of::<S::f32s>() / 4;
		out.fill(0.0);
		tmp.fill(0.0);
		let clamp = |v: isize, max: usize| v.clamp(0, max as isize - 1) as usize;
		let taps = 2 * r + 1;
		// Up to r = 16 (sigma 6.4); the tracer uses r = 2. Fixed arrays keep allocation out of the kernel.
		assert!(taps <= MAX_TAPS);
		let mut ks = [simd.splat_f32s(0.0); MAX_TAPS];
		for i in 0..taps {
			ks[i] = simd.splat_f32s(k[i]);
		}

		let lo = r.max(x0);
		let hi = (w - r).min(x1 + 1); // exclusive: x + r < w
		for y in by0..=by1 {
			let row = &src[y * w..(y + 1) * w];
			let dst = &mut tmp[y * w..(y + 1) * w];
			let mut x = x0;
			while x <= x1 {
				if x >= lo && x + n <= hi {
					let mut s = simd.splat_f32s(0.0);
					for i in 0..taps {
						let v = S::as_simd_f32s(&row[x + i - r..x + i - r + n]).0[0];
						s = simd.mul_add_f32s(v, ks[i], s);
					}
					S::as_mut_simd_f32s(&mut dst[x..x + n]).0[0] = s;
					x += n;
				} else {
					let mut s = 0.0f32;
					for i in 0..taps {
						s += row[clamp(x as isize + i as isize - r as isize, w)] * k[i];
					}
					dst[x] = s;
					x += 1;
				}
			}
		}

		for y in y0..=y1 {
			let mut rows: [&[f32]; MAX_TAPS] = [&[]; MAX_TAPS];
			for i in 0..taps {
				let yy = clamp(y as isize + i as isize - r as isize, h);
				rows[i] = &tmp[yy * w..(yy + 1) * w];
			}
			let dst = &mut out[y * w..(y + 1) * w];
			let mut x = x0;
			while x <= x1 {
				if x + n <= x1 + 1 {
					let mut s = simd.splat_f32s(0.0);
					for i in 0..taps {
						s = simd.mul_add_f32s(S::as_simd_f32s(&rows[i][x..x + n]).0[0], ks[i], s);
					}
					S::as_mut_simd_f32s(&mut dst[x..x + n]).0[0] = s;
					x += n;
				} else {
					let mut s = 0.0f32;
					for i in 0..taps {
						s += rows[i][x] * k[i];
					}
					dst[x] = s;
					x += 1;
				}
			}
		}
	}
}

struct Call {
	r: usize,
	x0: usize,
	x1: usize,
	y0: usize,
	y1: usize,
	by0: usize,
	by1: usize,
	k: Vec<f32>,
	src: Vec<f32>,
}

fn i32_at(b: &[u8], o: &mut usize) -> i32 {
	let v = i32::from_le_bytes(b[*o..*o + 4].try_into().unwrap());
	*o += 4;
	v
}

fn floats(b: &[u8]) -> Vec<f32> {
	b.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect()
}

#[cfg(windows)]
fn peak_mb() -> f64 {
	#[repr(C)]
	#[derive(Default)]
	struct Counters {
		cb: u32,
		page_faults: u32,
		peak_working_set: usize,
		rest: [usize; 7],
	}
	#[link(name = "kernel32")]
	unsafe extern "system" {
		fn GetCurrentProcess() -> isize;
		fn K32GetProcessMemoryInfo(process: isize, counters: *mut Counters, cb: u32) -> i32;
	}
	let mut c = Counters { cb: size_of::<Counters>() as u32, ..Default::default() };
	unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) };
	c.peak_working_set as f64 / 1048576.0
}

#[cfg(not(windows))]
fn peak_mb() -> f64 {
	let s = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
	s.lines().find(|l| l.starts_with("VmHWM")).and_then(|l| l.split_whitespace().nth(1)?.parse::<f64>().ok()).unwrap_or(0.0) / 1024.0
}

fn main() {
	let args: Vec<String> = std::env::args().collect();
	let bin = std::fs::read(&args[1]).unwrap();
	let reference = floats(&std::fs::read(&args[2]).unwrap());
	let reps: usize = args[4].parse().unwrap();
	assert_eq!(&bin[..4], b"BLR1");
	let mut o = 4;
	let w = i32_at(&bin, &mut o) as usize;
	let h = i32_at(&bin, &mut o) as usize;
	let n = i32_at(&bin, &mut o) as usize;
	let calls: Vec<Call> = (0..n)
		.map(|_| {
			o += 8; // sigma
			let v: Vec<usize> = (0..9).map(|_| i32_at(&bin, &mut o) as usize).collect();
			let (r, bx0, bx1) = (v[0], v[7], v[8]);
			let k = floats(&bin[o..o + (2 * r + 1) * 4]);
			o += k.len() * 4;
			let mut src = vec![0f32; w * h];
			let cols = bx1 - bx0 + 1;
			for y in v[5]..=v[6] {
				src[y * w + bx0..y * w + bx1 + 1].copy_from_slice(&floats(&bin[o..o + cols * 4]));
				o += cols * 4;
			}
			Call { r, x0: v[1], x1: v[2], y0: v[3], y1: v[4], by0: v[5], by1: v[6], k, src }
		})
		.collect();

	let arch = Arch::new();
	// pulp's AVX-512 level (Arch::V4) needs its x86-v4 feature, which is off by default: with
	// defaults it dispatches up to AVX2 even on AVX-512 hardware.
	let target = match arch {
		#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
		Arch::V3(_) => "x86-v3 (AVX2+FMA)",
		_ => "scalar",
	};
	let mut out = vec![0f32; w * h];
	let mut tmp = vec![0f32; w * h];
	let mut run = |c: &Call, out: &mut [f32], tmp: &mut [f32]| {
		arch.dispatch(Blur { src: &c.src, out, tmp, w, h, k: &c.k, r: c.r, x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, by0: c.by0, by1: c.by1 })
	};

	// Check every call against the TypeScript output, and keep this engine's output.
	let (mut max_diff, mut flips, mut checked) = (0f64, 0u64, 0usize);
	let mut save = (args[3] != "-").then(|| std::io::BufWriter::new(std::fs::File::create(&args[3]).unwrap()));
	for c in &calls {
		run(c, &mut out, &mut tmp);
		for y in c.y0..=c.y1 {
			let got = &out[y * w + c.x0..=y * w + c.x1];
			for &g in got {
				let want = reference[checked];
				max_diff = max_diff.max((g as f64 - want as f64).abs());
				if (g >= 0.5) != (want >= 0.5) {
					flips += 1;
				}
				checked += 1;
			}
			if let Some(f) = save.as_mut() {
				for g in got {
					f.write_all(&g.to_le_bytes()).unwrap();
				}
			}
		}
	}
	drop(save);

	let warm = Instant::now();
	let mut i = 0;
	while i < 10 || warm.elapsed() < Duration::from_millis(500) {
		for c in &calls {
			run(c, &mut out, &mut tmp);
		}
		i += 1;
	}
	let mut ms: Vec<f64> = (0..reps)
		.map(|_| {
			let t0 = Instant::now();
			for c in &calls {
				run(c, &mut out, &mut tmp);
			}
			t0.elapsed().as_secs_f64() * 1000.0
		})
		.collect();
	ms.sort_by(f64::total_cmp);
	println!(
		"{{\"engine\":\"Rust + pulp\",\"target\":\"{target}\",\"w\":{w},\"h\":{h},\"calls\":{n},\"reps\":{reps},\"median_ms\":{:.4},\"min_ms\":{:.4},\"p90_ms\":{:.4},\"max_diff\":{:.3e},\"flips\":{flips},\"checked\":{checked},\"peak_mb\":{:.1}}}",
		ms[ms.len() / 2],
		ms[0],
		ms[ms.len() * 9 / 10],
		max_diff,
		peak_mb()
	);
}
