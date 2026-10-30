//! The tracer's Gaussian blur with the `wide` crate (f32x4, WebAssembly SIMD). See simd/README.md.
use std::alloc::{alloc as raw_alloc, dealloc, Layout};
use std::slice;
use wide::f32x4;

#[no_mangle]
pub extern "C" fn alloc(bytes: usize) -> *mut u8 {
    unsafe { raw_alloc(Layout::from_size_align_unchecked(bytes, 16)) }
}

#[no_mangle]
pub extern "C" fn release(ptr: *mut u8, bytes: usize) {
    unsafe { dealloc(ptr, Layout::from_size_align_unchecked(bytes, 16)) }
}

#[inline(always)]
fn load(s: &[f32], i: usize) -> f32x4 {
    f32x4::from([s[i], s[i + 1], s[i + 2], s[i + 3]])
}

#[inline(always)]
fn store(d: &mut [f32], i: usize, v: f32x4) {
    d[i..i + 4].copy_from_slice(&v.to_array());
}

/// # Safety
/// Pointers must hold w*h floats (src, out, tmp) and 2r+1 floats (k), inside this module's memory.
#[no_mangle]
pub unsafe extern "C" fn blur(
    src: *const f32, out: *mut f32, tmp: *mut f32, w: i32, h: i32, k: *const f32, r: i32,
    x0: i32, x1: i32, y0: i32, y1: i32, by0: i32, by1: i32,
) {
    let (w, h, r) = (w as usize, h as usize, r as usize);
    let n = w * h;
    let src = slice::from_raw_parts(src, n);
    let out = slice::from_raw_parts_mut(out, n);
    let tmp = slice::from_raw_parts_mut(tmp, n);
    let k = slice::from_raw_parts(k, 2 * r + 1);
    out.fill(0.0);
    tmp.fill(0.0);
    let (x0, x1) = (x0 as usize, x1 as usize);
    let clamp_x = |x: isize| x.clamp(0, w as isize - 1) as usize;
    let clamp_y = |y: isize| y.clamp(0, h as isize - 1) as usize;

    // Horizontal pass. Four outputs at a time where every tap is inside the row; scalar elsewhere.
    let lo = r.max(x0);
    let hi = if w > r { (w - r).min(x1 + 1) } else { 0 }; // exclusive: x + r < w
    for y in by0 as usize..=by1 as usize {
        let row = y * w;
        let mut x = x0;
        while x <= x1 {
            if x >= lo && x + 4 <= hi {
                let mut s = f32x4::ZERO;
                for i in 0..=2 * r {
                    s += load(src, row + x + i - r) * f32x4::splat(k[i]);
                }
                store(tmp, row + x, s);
                x += 4;
            } else {
                let mut s = 0.0f32;
                for i in 0..=2 * r {
                    s += src[row + clamp_x(x as isize + i as isize - r as isize)] * k[i];
                }
                tmp[row + x] = s;
                x += 1;
            }
        }
    }

    // Vertical pass: four neighbouring columns at once; rows clamp to the image.
    for y in y0 as usize..=y1 as usize {
        let mut x = x0;
        while x <= x1 {
            if x + 4 <= x1 + 1 {
                let mut s = f32x4::ZERO;
                for i in 0..=2 * r {
                    s += load(tmp, clamp_y(y as isize + i as isize - r as isize) * w + x) * f32x4::splat(k[i]);
                }
                store(out, y * w + x, s);
                x += 4;
            } else {
                let mut s = 0.0f32;
                for i in 0..=2 * r {
                    s += tmp[clamp_y(y as isize + i as isize - r as isize) * w + x] * k[i];
                }
                out[y * w + x] = s;
                x += 1;
            }
        }
    }
}
