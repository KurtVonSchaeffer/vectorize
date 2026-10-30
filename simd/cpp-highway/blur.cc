// The tracer's Gaussian blur with Google Highway (static target: WebAssembly SIMD128). See simd/README.md.
#include <cstdlib>
#include <cstring>

#include "hwy/highway.h"

namespace hn = hwy::HWY_NAMESPACE;

extern "C" {

void* alloc(size_t bytes) { return aligned_alloc(16, (bytes + 15) & ~size_t(15)); }

void release(void* ptr, size_t) { free(ptr); }

void blur(const float* src, float* out, float* tmp, int w, int h, const float* k, int r,
          int x0, int x1, int y0, int y1, int by0, int by1) {
  const hn::ScalableTag<float> d;
  const int N = static_cast<int>(hn::Lanes(d));
  memset(out, 0, sizeof(float) * w * h);
  memset(tmp, 0, sizeof(float) * w * h);
  auto clampX = [&](int x) { return x < 0 ? 0 : x > w - 1 ? w - 1 : x; };
  auto clampY = [&](int y) { return y < 0 ? 0 : y > h - 1 ? h - 1 : y; };

  // Horizontal pass. N outputs at a time where every tap is inside the row; scalar elsewhere.
  const int lo = r > x0 ? r : x0;
  const int hi = (w - r) < (x1 + 1) ? (w - r) : (x1 + 1);  // exclusive: x + r < w
  for (int y = by0; y <= by1; y++) {
    const float* row = src + y * w;
    for (int x = x0; x <= x1;) {
      if (x >= lo && x + N <= hi) {
        auto s = hn::Zero(d);
        for (int i = 0; i <= 2 * r; i++) s = hn::MulAdd(hn::LoadU(d, row + x + i - r), hn::Set(d, k[i]), s);
        hn::StoreU(s, d, tmp + y * w + x);
        x += N;
      } else {
        float s = 0;
        for (int i = 0; i <= 2 * r; i++) s += row[clampX(x + i - r)] * k[i];
        tmp[y * w + x] = s;
        x++;
      }
    }
  }

  // Vertical pass: N neighbouring columns at once; rows clamp to the image.
  for (int y = y0; y <= y1; y++) {
    for (int x = x0; x <= x1;) {
      if (x + N <= x1 + 1) {
        auto s = hn::Zero(d);
        for (int i = 0; i <= 2 * r; i++) s = hn::MulAdd(hn::LoadU(d, tmp + clampY(y + i - r) * w + x), hn::Set(d, k[i]), s);
        hn::StoreU(s, d, out + y * w + x);
        x += N;
      } else {
        float s = 0;
        for (int i = 0; i <= 2 * r; i++) s += tmp[clampY(y + i - r) * w + x] * k[i];
        out[y * w + x] = s;
        x++;
      }
    }
  }
}

}  // extern "C"
