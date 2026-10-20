// Runs in Chromium. window.audit({truth, upload, svg, pdf, w, h, scale, truthBg}) -> metrics + images.
// scale: reference pixels per upload pixel (distances are reported in upload pixels).
;(() => {
  const load = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('load ' + src.slice(0, 40))); i.src = src })
  const svgUrl = (t) => URL.createObjectURL(new Blob([t], { type: 'image/svg+xml' }))
  const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c }
  function pixels(img, w, h, bg, sx = 0, sy = 0, sw, sh) {
    const c = canvas(w, h), g = c.getContext('2d', { willReadFrequently: true })
    if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h) }
    if (sw) g.drawImage(img, sx, sy, sw, sh, 0, 0, w, h)
    else g.drawImage(img, 0, 0, w, h)
    return { c, d: g.getImageData(0, 0, w, h).data }
  }
  // sRGB -> Lab (D65), cached per colour.
  const cache = new Map()
  function lab(r, g, b) {
    const k = (r << 16) | (g << 8) | b
    let v = cache.get(k)
    if (v) return v
    const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
    const R = f(r), G = f(g), B = f(b)
    const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047, Y = 0.2126 * R + 0.7152 * G + 0.0722 * B, Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883
    const t = (x) => (x > 0.008856 ? Math.cbrt(x) : 7.787 * x + 16 / 116)
    v = [116 * t(Y) - 16, 500 * (t(X) - t(Y)), 200 * (t(Y) - t(Z))]
    cache.set(k, v)
    return v
  }
  function de2000([L1, a1, b1], [L2, a2, b2]) {
    const rad = Math.PI / 180, C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2
    const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)))
    const ap1 = (1 + G) * a1, ap2 = (1 + G) * a2, Cp1 = Math.hypot(ap1, b1), Cp2 = Math.hypot(ap2, b2)
    let h1 = Math.atan2(b1, ap1) / rad; if (h1 < 0) h1 += 360
    let h2 = Math.atan2(b2, ap2) / rad; if (h2 < 0) h2 += 360
    const dL = L2 - L1, dC = Cp2 - Cp1
    let dh = 0
    if (Cp1 * Cp2) { dh = h2 - h1; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360 }
    const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh / 2) * rad)
    const Lb = (L1 + L2) / 2, Cpb = (Cp1 + Cp2) / 2
    let hb = h1 + h2
    if (Cp1 * Cp2) { if (Math.abs(h1 - h2) > 180) hb += h1 + h2 < 360 ? 360 : -360; hb /= 2 }
    const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad)
    const Sl = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2), Sc = 1 + 0.045 * Cpb, Sh = 1 + 0.015 * Cpb * T
    const Rt = -2 * Math.sqrt(Cpb ** 7 / (Cpb ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hb - 275) / 25) ** 2)) * rad)
    return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh))
  }
  const deAt = (A, B, i) => de2000(lab(A[i], A[i + 1], A[i + 2]), lab(B[i], B[i + 1], B[i + 2]))
  const pct = (a, b) => +((100 * a) / Math.max(1, b)).toFixed(2)
  const quant = (arr, q) => { if (!arr.length) return 0; const s = Float32Array.from(arr).sort(); return +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(2) }
  function edgesOf(D, w, h) {
    const e = new Uint8Array(w * h)
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        let m = 0
        for (let c = 0; c < 3; c++) {
          const p = (o) => D[(o) * 4 + c]
          const i = y * w + x
          const gx = -p(i - w - 1) - 2 * p(i - 1) - p(i + w - 1) + p(i - w + 1) + 2 * p(i + 1) + p(i + w + 1)
          const gy = -p(i - w - 1) - 2 * p(i - w) - p(i - w + 1) + p(i + w - 1) + 2 * p(i + w) + p(i + w + 1)
          m = Math.max(m, Math.hypot(gx, gy))
        }
        if (m > 160) e[y * w + x] = 1
      }
    return e
  }
  // Chamfer (3-4) distance to the nearest set pixel, in pixels.
  function dist(mask, w, h) {
    const INF = 1e9, d = new Float32Array(w * h)
    for (let i = 0; i < w * h; i++) d[i] = mask[i] ? 0 : INF
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 3)
      if (y > 0) { d[i] = Math.min(d[i], d[i - w] + 3); if (x > 0) d[i] = Math.min(d[i], d[i - w - 1] + 4); if (x < w - 1) d[i] = Math.min(d[i], d[i - w + 1] + 4) }
    }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x
      if (x < w - 1) d[i] = Math.min(d[i], d[i + 1] + 3)
      if (y < h - 1) { d[i] = Math.min(d[i], d[i + w] + 3); if (x < w - 1) d[i] = Math.min(d[i], d[i + w + 1] + 4); if (x > 0) d[i] = Math.min(d[i], d[i + w - 1] + 4) }
    }
    for (let i = 0; i < w * h; i++) d[i] /= 3
    return d
  }
  function components(mask, w, h, minArea) {
    const seen = new Uint8Array(w * h), out = []
    for (let s = 0; s < w * h; s++) {
      if (!mask[s] || seen[s]) continue
      const st = [s]; seen[s] = 1
      let n = 0, x0 = w, y0 = h, x1 = 0, y1 = 0, px = []
      while (st.length) {
        const p = st.pop(), x = p % w, y = (p / w) | 0
        n++; px.push(p)
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
          const q = yy * w + xx
          if (mask[q] && !seen[q]) { seen[q] = 1; st.push(q) }
        }
      }
      if (n >= minArea) out.push({ n, x0, y0, x1, y1, px })
    }
    return out.sort((a, b) => b.n - a.n)
  }
  function toImg(D, w, h) { const c = canvas(w, h); const g = c.getContext('2d'); const im = g.createImageData(w, h); im.data.set(D); g.putImageData(im, 0, 0); return c }
  function shrink(c, maxW) { const k = Math.min(1, maxW / c.width); const o = canvas(Math.round(c.width * k), Math.round(c.height * k)); o.getContext('2d').drawImage(c, 0, 0, o.width, o.height); return o }
  function row(cs, labels, maxW) {
    const sc = cs.map((c) => shrink(c, maxW)), H = Math.max(...sc.map((c) => c.height)) + 22, W = sc.reduce((t, c) => t + c.width + 8, 8)
    const o = canvas(W, H), g = o.getContext('2d')
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.fillStyle = '#222'; g.font = '13px sans-serif'
    let x = 8
    sc.forEach((c, k) => { g.fillStyle = '#e8e8e8'; g.fillRect(x, 20, c.width, c.height); g.drawImage(c, x, 20); g.fillStyle = '#222'; g.fillText(labels[k], x, 14); x += c.width + 8 })
    return o.toDataURL('image/png')
  }
  function stats(T, V, w, h, fg) {
    const all = [], inFg = []
    let over5 = 0, over10 = 0
    for (let p = 0, i = 0; p < w * h; p++, i += 4) {
      const d = deAt(T, V, i)
      all.push(d)
      if (fg[p]) inFg.push(d)
      if (d > 5) over5++
      if (d > 10) over10++
    }
    const mean = (a) => +(a.reduce((s, x) => s + x, 0) / Math.max(1, a.length)).toFixed(2)
    return { meanAll: mean(all), p95All: quant(all, 0.95), meanArt: mean(inFg), p95Art: quant(inFg, 0.95), pctOver5: pct(over5, w * h), pctOver10: pct(over10, w * h), all }
  }

  // Tolerant mismatch: a pixel of A is wrong when no pixel of B within r has a colour within dE76 15
  // (so a 1 px shift or anti-aliasing is not an error, a missing or wrongly coloured detail is). Then a
  // 3x3 opening drops one-pixel fringes along edges; what remains is genuinely missing or extra.
  function mismatch(A, B, w, h, r, care) {
    const LA = new Float32Array(w * h * 3), LB = new Float32Array(w * h * 3)
    for (let p = 0, i = 0; p < w * h; p++, i += 4) { LA.set(lab(A[i], A[i + 1], A[i + 2]), p * 3); LB.set(lab(B[i], B[i + 1], B[i + 2]), p * 3) }
    const bad = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x
      if (care && !care[p]) continue
      let ok = false
      for (let dy = -r; dy <= r && !ok; dy++) for (let dx = -r; dx <= r && !ok; dx++) {
        const xx = x + dx, yy = y + dy
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
        const q = (yy * w + xx) * 3
        const d = Math.hypot(LA[p * 3] - LB[q], LA[p * 3 + 1] - LB[q + 1], LA[p * 3 + 2] - LB[q + 2])
        if (d < 15) ok = true
      }
      if (!ok) bad[p] = 1
    }
    const er = new Uint8Array(w * h), op = new Uint8Array(w * h)
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { let all = 1; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) all &= bad[(y + dy) * w + x + dx]; er[y * w + x] = all }
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) if (er[y * w + x]) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) op[(y + dy) * w + x + dx] = 1
    return op
  }
  window.mismatchStats = (T, V, w, h, scale, care, artPx) => {
    const r = Math.max(1, Math.round(scale))
    const miss = mismatch(T, V, w, h, r, care), extra = mismatch(V, T, w, h, r, null)
    let nm = 0, ne = 0
    const both = new Uint8Array(w * h)
    for (let p = 0; p < w * h; p++) { nm += miss[p]; ne += extra[p]; both[p] = miss[p] | extra[p] }
    const comps = components(both, w, h, Math.max(2 * scale * scale, 4))
    return {
      missingPctOfArt: pct(nm, artPx), extraPctOfArt: pct(ne, artPx),
      blobs: comps.length,
      top: comps.slice(0, 10).map((c) => ({ areaUploadPx: +(c.n / scale / scale).toFixed(1), box: [c.x0, c.y0, c.x1, c.y1].map((v) => Math.round(v / scale)) })),
      mask: both, comps,
    }
  }
  // Stage scoring: one candidate raster or SVG (src) against the reference, same measures as audit().
  window.score = async ({ truth, src, w, h, scale, truthBg, regions }) => {
    const T = pixels(await load(truth), w, h, truthBg ?? '#fff'), X = pixels(await load(src), w, h, '#fff')
    const care = new Uint8Array(w * h).fill(1)
    const st = stats(T.d, X.d, w, h, care); delete st.all
    const eT = edgesOf(T.d, w, h), eX = edgesOf(X.d, w, h), dX = dist(eX, w, h)
    let n = 0, hit = 0
    for (let p = 0; p < w * h; p++) if (eT[p]) { n++; if (dX[p] / scale <= 1) hit++ }
    const mm = window.mismatchStats(T.d, X.d, w, h, scale, null, w * h)
    const reg = {}
    for (const [name, box] of Object.entries(regions ?? {})) {
      const [bx0, by0, bx1, by1] = box.map((v) => Math.round(v * scale))
      let rn = 0, rh = 0, rw = 0, rp = 0
      for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) { const p = y * w + x; rp++; rw += mm.mask[p]; if (eT[p]) { rn++; if (dX[p] / scale <= 1) rh++ } }
      reg[name] = { edgeRecall1px: pct(rh, rn), wrongPct: pct(rw, rp) }
    }
    return { meanDE: st.meanAll, p95DE: st.p95All, edgeRecall1px: pct(hit, n), wrongPct: pct(mm.mask.reduce((a, b) => a + b, 0), w * h), blobs: mm.blobs, regions: reg }
  }
  window.loadPixels = async (src, w, h, bg) => pixels(await load(src), w, h, bg).d
  window.audit = async ({ truth, upload, svg, pdf, w, h, scale, truthBg, regions }) => {
    const out = { images: {} }
    const tImg = await load(truth), uImg = await load(upload), vUrl = svgUrl(svg), vImg = await load(vUrl)
    const T = pixels(tImg, w, h, truthBg ?? '#fff'), Ta = pixels(tImg, w, h, null)
    const V = pixels(vImg, w, h, '#fff'), Va = pixels(vImg, w, h, null)
    // Foreground: opaque pixels for transparent artwork; otherwise pixels away from the border colour.
    let transparent = false
    for (let i = 3; i < Ta.d.length; i += 4) if (Ta.d[i] < 250) { transparent = true; break }
    if (truthBg) transparent = false
    const border = new Map()
    for (let x = 0; x < w; x++) for (const y of [0, h - 1]) { const i = (y * w + x) * 4; const k = (T.d[i] << 16) | (T.d[i + 1] << 8) | T.d[i + 2]; border.set(k, (border.get(k) ?? 0) + 1) }
    const bgk = [...border.entries()].sort((a, b) => b[1] - a[1])[0][0], bgLab = lab(bgk >> 16, (bgk >> 8) & 255, bgk & 255)
    const borderShare = border.get(bgk) / (2 * w)
    const fgOf = (D, Da) => {
      const f = new Uint8Array(w * h)
      for (let p = 0, i = 0; p < w * h; p++, i += 4) f[p] = transparent && !truthBg ? (Da[i + 3] > 128 ? 1 : 0) : de2000(lab(D[i], D[i + 1], D[i + 2]), bgLab) > 10 ? 1 : 0
      return f
    }
    const fT = fgOf(T.d, Ta.d), fV = fgOf(V.d, Va.d)
    let inter = 0, uni = 0
    for (let p = 0; p < w * h; p++) { inter += fT[p] & fV[p]; uni += fT[p] | fV[p] }
    out.shape = { transparent, background: '#' + bgk.toString(16).padStart(6, '0'), borderShare: +borderShare.toFixed(2), iou: borderShare > 0.6 || transparent ? +(inter / Math.max(1, uni)).toFixed(4) : null, artPx: fT.reduce((s, x) => s + x, 0) }
    const union = new Uint8Array(w * h)
    for (let p = 0; p < w * h; p++) union[p] = fT[p] | fV[p]
    const st = stats(T.d, V.d, w, h, union)
    const dE = st.all; delete st.all
    out.colour = st
    // Edges: share of the reference's edges with a result edge within 1 / 2 upload px, and vice versa.
    const eT = edgesOf(T.d, w, h), eV = edgesOf(V.d, w, h), dV = dist(eV, w, h), dT = dist(eT, w, h)
    let nT = 0, t1 = 0, t2 = 0, sumT = 0, nV = 0, v1 = 0
    for (let p = 0; p < w * h; p++) {
      if (eT[p]) { nT++; const d = dV[p] / scale; sumT += Math.min(d, 20); if (d <= 1) t1++; if (d <= 2) t2++ }
      if (eV[p]) { nV++; if (dT[p] / scale <= 1) v1++ }
    }
    out.edges = { truthEdgePx: nT, truthWithin1: pct(t1, nT), truthWithin2: pct(t2, nT), meanDist: +(sumT / Math.max(1, nT)).toFixed(2), vectorWithin1: pct(v1, nV) }
    // Defects: clear colour differences away from the reference's edges (anti-aliasing excluded).
    const bad = new Uint8Array(w * h)
    for (let p = 0; p < w * h; p++) if (dE[p] > 20 && dT[p] > 1.5 * scale) bad[p] = 1
    const comps = components(bad, w, h, Math.max(3 * scale * scale, Math.round(w * h * 0.00005)))
    out.defects = comps.slice(0, 12).map((c) => {
      let miss = 0, extra = 0
      for (const p of c.px) { if (fT[p] && !fV[p]) miss++; else if (!fT[p] && fV[p]) extra++ }
      return { areaUploadPx: +(c.n / scale / scale).toFixed(1), box: [c.x0, c.y0, c.x1, c.y1].map((v) => Math.round(v / scale)), kind: miss > c.n / 2 ? 'missing' : extra > c.n / 2 ? 'extra' : 'wrong colour' }
    })
    out.defectAreaPct = pct(comps.reduce((s, c) => s + c.n, 0), w * h)
    const mm = window.mismatchStats(T.d, V.d, w, h, scale, union, out.shape.artPx || w * h)
    out.mismatch = { missingPctOfArt: mm.missingPctOfArt, extraPctOfArt: mm.extraPctOfArt, blobs: mm.blobs, top: mm.top }
    // The heat map's worst region is where the largest mismatch blob is.
    if (mm.comps.length) comps.unshift(mm.comps[0])
    // Images: upload | result | difference heat map | overlay (reference edges in magenta on the result).
    const heat = new Uint8ClampedArray(w * h * 4), over = new Uint8ClampedArray(w * h * 4)
    for (let p = 0, i = 0; p < w * h; p++, i += 4) {
      const g = 0.3 * T.d[i] + 0.59 * T.d[i + 1] + 0.11 * T.d[i + 2], d = Math.min(1, dE[p] / 25)
      heat[i] = g * 0.35 + 255 * d; heat[i + 1] = g * 0.35 + 200 * Math.max(0, d - 0.5) * 2 * (d < 1 ? 1 : 0); heat[i + 2] = g * 0.35; heat[i + 3] = 255
      if (eT[p]) { over[i] = 230; over[i + 1] = 0; over[i + 2] = 200 } else { over[i] = V.d[i] * 0.55 + 115; over[i + 1] = V.d[i + 1] * 0.55 + 115; over[i + 2] = V.d[i + 2] * 0.55 + 115 }
      over[i + 3] = 255
    }
    const upC = pixels(uImg, w, h, '#fff').c
    const wrong = new Uint8ClampedArray(w * h * 4)
    for (let p = 0, i = 0; p < w * h; p++, i += 4) {
      const g = 0.3 * V.d[i] + 0.59 * V.d[i + 1] + 0.11 * V.d[i + 2]
      if (mm.mask[p]) { wrong[i] = 235; wrong[i + 1] = 20; wrong[i + 2] = 20 } else { wrong[i] = wrong[i + 1] = wrong[i + 2] = 150 + g * 0.4 }
      wrong[i + 3] = 255
    }
    out.images.compare = row([upC, V.c, toImg(heat, w, h), toImg(over, w, h), toImg(wrong, w, h)], ['Upload (as sent)', 'Vector result', 'Colour difference (ΔE, red = 25+)', 'Reference edges on result', 'Wrong beyond 1 px (red)'], 340)
    // Detail: 4x crop at the largest defect (or the busiest edge area): reference vs vector re-rendered at 4x.
    const cw = Math.max(24, Math.round(Math.min(w, h) / 5)), ch = cw
    let cx, cy
    if (comps.length) { cx = (comps[0].x0 + comps[0].x1) / 2; cy = (comps[0].y0 + comps[0].y1) / 2 }
    else {
      let best = -1
      for (let y = 0; y + ch <= h; y += Math.round(ch / 2)) for (let x = 0; x + cw <= w; x += Math.round(cw / 2)) {
        let s = 0
        for (let yy = y; yy < y + ch; yy += 2) for (let xx = x; xx < x + cw; xx += 2) s += dE[yy * w + xx]
        if (s > best) { best = s; cx = x + cw / 2; cy = y + ch / 2 }
      }
    }
    const x0 = Math.max(0, Math.min(w - cw, Math.round(cx - cw / 2))), y0 = Math.max(0, Math.min(h - ch, Math.round(cy - ch / 2)))
    const Z = 4
    const zt = canvas(cw * Z, ch * Z), gt = zt.getContext('2d'); gt.imageSmoothingEnabled = false; gt.drawImage(T.c, x0, y0, cw, ch, 0, 0, cw * Z, ch * Z)
    const zu = canvas(cw * Z, ch * Z), gu = zu.getContext('2d'); gu.imageSmoothingEnabled = false; gu.drawImage(upC, x0, y0, cw, ch, 0, 0, cw * Z, ch * Z)
    const zv = canvas(cw * Z, ch * Z), gv = zv.getContext('2d'); gv.fillStyle = '#fff'; gv.fillRect(0, 0, cw * Z, ch * Z); gv.drawImage(vImg, -x0 * Z, -y0 * Z, w * Z, h * Z)
    const zh = canvas(cw * Z, ch * Z), gh = zh.getContext('2d'); gh.imageSmoothingEnabled = false; gh.drawImage(toImg(heat, w, h), x0, y0, cw, ch, 0, 0, cw * Z, ch * Z)
    out.detailBox = [x0, y0, cw, ch].map((v) => Math.round(v / scale))
    out.images.detail = row([zu, zt, zv, zh], ['Upload, 4×', 'Reference, 4×', 'Vector, re-rendered at 4×', 'Difference'], 300)

    // ---------- Named regions (lettering, emblem): the same measures inside the region, and 4x crops ----------
    out.regions = {}
    for (const [name, box] of Object.entries(regions ?? {})) {
      const [bx0, by0, bx1, by1] = box.map((v) => Math.round(v * scale))
      let n = 0, hit = 0, wrongPx = 0, px = 0
      for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) {
        const p = y * w + x
        px++
        if (mm.mask[p]) wrongPx++
        if (eT[p]) { n++; if (dV[p] / scale <= 1) hit++ }
      }
      out.regions[name] = { box, edgeRecall1px: pct(hit, n), wrongPct: pct(wrongPx, px) }
      const rw = bx1 - bx0, rh = by1 - by0, Zr = Math.max(2, Math.min(6, Math.round(900 / rw)))
      const mk = (draw) => { const c = canvas(rw * Zr, rh * Zr), g = c.getContext('2d'); g.imageSmoothingEnabled = false; g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); draw(g); return c }
      const a = mk((g) => g.drawImage(upC, bx0, by0, rw, rh, 0, 0, rw * Zr, rh * Zr))
      const t2 = mk((g) => g.drawImage(T.c, bx0, by0, rw, rh, 0, 0, rw * Zr, rh * Zr))
      const v2 = mk((g) => g.drawImage(vImg, -bx0 * Zr, -by0 * Zr, w * Zr, h * Zr))
      out.images['region-' + name] = row([a, t2, v2], [`Upload (${name})`, 'Reference', 'Vector, re-rendered'], 600)
    }
    // ---------- Editability ----------
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const root = doc.documentElement
    const vb = (root.getAttribute('viewBox') || `0 0 ${root.getAttribute('width')} ${root.getAttribute('height')}`).split(/[\s,]+/).map(Number)
    const kx = w / vb[2], ky = h / vb[3]
    const paths = [...doc.getElementsByTagName('path')]
    const transforms = [...doc.querySelectorAll('[transform]')].length
    const fillOf = (el) => { for (let e = el; e && e.getAttribute; e = e.parentNode) { const f = e.getAttribute('fill'); if (f) return f } return '#000' }
    const idc = canvas(w, h), ig = idc.getContext('2d', { willReadFrequently: true })
    ig.setTransform(kx, 0, 0, ky, -vb[0] * kx, -vb[1] * ky)
    const shift = (p) => { const m = /translate\(\s*([-\d.e]+)[\s,]+([-\d.e]+)/.exec(p.getAttribute('transform') || ''); return m ? [+m[1], +m[2]] : [0, 0] }
    paths.forEach((p, k) => { const n = k + 1, [tx, ty] = shift(p); ig.setTransform(kx, 0, 0, ky, (tx - vb[0]) * kx, (ty - vb[1]) * ky); ig.fillStyle = `rgb(${n & 255},${(n >> 8) & 255},${(n >> 16) & 255})`; ig.fill(new Path2D(p.getAttribute('d') || ''), p.getAttribute('fill-rule') === 'evenodd' ? 'evenodd' : 'nonzero') })
    const ID = ig.getImageData(0, 0, w, h).data
    const vis = new Uint32Array(paths.length + 2)
    for (let i = 0; i < ID.length; i += 4) { const n = ID[i] | (ID[i + 1] << 8) | (ID[i + 2] << 16); if (n && n <= paths.length) vis[n]++ }
    let hidden = 0, tinyHidden = 0
    paths.forEach((p, k) => {
      if (vis[k + 1]) return
      const c = canvas(w, h), g = c.getContext('2d', { willReadFrequently: true })
      const [tx, ty] = shift(p); g.setTransform(kx, 0, 0, ky, (tx - vb[0]) * kx, (ty - vb[1]) * ky); g.fill(new Path2D(p.getAttribute('d') || ''))
      const D = g.getImageData(0, 0, w, h).data
      let a = 0
      for (let i = 3; i < D.length; i += 4) if (D[i] > 128) a++
      if (a / scale / scale > 4) hidden++
      else tinyHidden++
    })
    // Recolour the largest visible object: every pixel that changes must become the new colour.
    let big = 1
    for (let k = 1; k <= paths.length; k++) if (vis[k] > vis[big]) big = k
    let recolourPure = null, changedOutside = null, changed = 0
    if (paths.length) {
      const was = paths[big - 1].getAttribute('fill')
      paths[big - 1].setAttribute('fill', '#FF00FF')
      const R = pixels(await load(svgUrl(new XMLSerializer().serializeToString(doc))), w, h, '#fff').d
      paths[big - 1].setAttribute('fill', was ?? '')
      let pure = 0, outside = 0
      const mag = lab(255, 0, 255)
      for (let p = 0, i = 0; p < w * h; p++, i += 4) {
        if (deAt(R, V.d, i) < 2) continue
        changed++
        if (de2000(lab(R[i], R[i + 1], R[i + 2]), mag) < 3) pure++
        const n = ID[i] | (ID[i + 1] << 8) | (ID[i + 2] << 16)
        if (n !== big) outside++
      }
      recolourPure = pct(pure, changed); changedOutside = pct(outside, changed)
      out.recolourObjectPx = vis[big]
    }
    // Resolution independence: share of anti-aliasing pixels (not within dE 3 of a fill) at 1x and 8x, same area.
    const fills = [...new Set(paths.map(fillOf))].filter((f) => /^#[0-9a-f]{6}$/i.test(f)).map((f) => lab(parseInt(f.slice(1, 3), 16), parseInt(f.slice(3, 5), 16), parseInt(f.slice(5, 7), 16)))
    fills.push(lab(255, 255, 255))
    const aaShare = (D) => { let n = 0, a = 0; for (let i = 0; i < D.length; i += 4) { n++; const L = lab(D[i], D[i + 1], D[i + 2]); if (!fills.some((f) => Math.hypot(f[0] - L[0], f[1] - L[1], f[2] - L[2]) < 3)) a++ } return pct(a, n) }
    const qx = Math.round(w / 4), qy = Math.round(h / 4), qw = Math.round(w / 2), qh = Math.round(h / 2)
    const one = canvas(qw, qh), g1 = one.getContext('2d', { willReadFrequently: true }); g1.fillStyle = '#fff'; g1.fillRect(0, 0, qw, qh); g1.drawImage(vImg, -qx, -qy, w, h)
    const eight = canvas(qw * 8, qh * 8), g8 = eight.getContext('2d', { willReadFrequently: true }); g8.fillStyle = '#fff'; g8.fillRect(0, 0, qw * 8, qh * 8); g8.drawImage(vImg, -qx * 8, -qy * 8, w * 8, h * 8)
    const hasGrad = /Gradient/.test(svg)
    out.edit = {
      paths: paths.length, groups: doc.getElementsByTagName('g').length, transforms, textElements: doc.getElementsByTagName('text').length,
      visibleObjects: [...vis].slice(1, paths.length + 1).filter((v) => v > 0).length, hiddenPaths: hidden, hiddenTiny: tinyHidden,
      recolourPure, changedOutside, recolourChangedPx: changed,
      aa1: hasGrad ? null : aaShare(g1.getImageData(0, 0, qw, qh).data), aa8: hasGrad ? null : aaShare(g8.getImageData(0, 0, qw * 8, qh * 8).data),
    }
    // ---------- Print PDF (rendered by poppler) vs the reference and vs the SVG ----------
    if (pdf) {
      const P = pixels(await load(pdf), w, h, '#fff').d
      const s2 = stats(T.d, P, w, h, union); delete s2.all
      const s3 = stats(V.d, P, w, h, union); delete s3.all
      out.pdf = { meanAll: s2.meanAll, p95All: s2.p95All, vsSvgMean: s3.meanAll, vsSvgPctOver10: s3.pctOver10 }
    }
    URL.revokeObjectURL(vUrl)
    return out
  }
})()
