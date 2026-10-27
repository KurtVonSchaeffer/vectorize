// The tracer's Gaussian blur with Google Highway, native x64 (simd/native/README.md). Compiled for
// every x86 target Highway supports; the best one for this CPU is picked at run time.
#include <cstring>

#undef HWY_TARGET_INCLUDE
#define HWY_TARGET_INCLUDE "blur.cc"
#include "hwy/foreach_target.h"  // IWYU pragma: keep
#include "hwy/highway.h"

HWY_BEFORE_NAMESPACE();
namespace blur {
namespace HWY_NAMESPACE {
namespace hn = hwy::HWY_NAMESPACE;

const char* Target() { return hwy::TargetName(HWY_TARGET); }

// Same algorithm as simd/cpp-highway/blur.cc (the WebAssembly build): N outputs at a time where
// every tap is inside the row, scalar at the edges; the vertical pass does N columns at once.
void Blur(const float* src, float* out, float* tmp, int w, int h, const float* k, int r, int x0, int x1,
          int y0, int y1, int by0, int by1) {
  const hn::ScalableTag<float> d;
  const int N = static_cast<int>(hn::Lanes(d));
  memset(out, 0, sizeof(float) * w * h);
  memset(tmp, 0, sizeof(float) * w * h);
  auto clampX = [&](int x) { return x < 0 ? 0 : x > w - 1 ? w - 1 : x; };
  auto clampY = [&](int y) { return y < 0 ? 0 : y > h - 1 ? h - 1 : y; };

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

}  // namespace HWY_NAMESPACE
}  // namespace blur
HWY_AFTER_NAMESPACE();

#if HWY_ONCE
namespace blur {
HWY_EXPORT(Blur);
HWY_EXPORT(Target);

void BlurDispatch(const float* src, float* out, float* tmp, int w, int h, const float* k, int r, int x0, int x1,
                  int y0, int y1, int by0, int by1) {
  HWY_DYNAMIC_DISPATCH(Blur)(src, out, tmp, w, h, k, r, x0, x1, y0, y1, by0, by1);
}

const char* TargetDispatch() { return HWY_DYNAMIC_DISPATCH(Target)(); }
}  // namespace blur
#endif
