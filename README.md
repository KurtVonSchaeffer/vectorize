# Vectorizer

Turns raster artwork (PNG/JPG/WebP) into SVG, entirely in the browser.

```bash
npm install
npm run dev
npm test
```

## Features

Built for clients, not designers: drop an image, check the before/after, pick what it's for, download.

- **Automatic**: detects the artwork type (logo or illustration, photo, line art, pixel art), its colors, existing transparency and a plain background. No presets to choose.
- **Purpose-based downloads**:
  - *Print*: a PDF where each ink is a named spot color (Separation), plus an SVG.
  - *Website*: a stacked SVG plus a 2× PNG.
  - *Cutting*: an SVG and an R12 DXF in millimetres, one layer per color.

  Print and cut files use knockout geometry (each color covers only its own area, with a tiny spread). The on-screen result uses stacked shapes, so no seams show.
- **Simple controls**: tap a color chip to remove it (its areas take the nearest color), a transparent-background switch, and an automatic clean-up of edge smudges with Undo. "Fine-tune" has two sliders, Detail and Corners. "More options" has the artwork type, maximum colors, AI sharpening (Swin2SR) and brand colors (swatch library matching).
- **Brand colors** (Fine-tune → More options): a saved list of exact brand colors, each with a name (such as a Pantone name) and a tolerance (Very close, Close, Loose, Very loose). Modes:
  - *Snap close*: colors within tolerance become the exact brand color; others stay as traced.
  - *Only brand*: every color becomes its nearest brand color. A background is left alone unless a brand color is near it.
  - *Library*: nearest swatch from an imported .ase/.csv/.json library.

  Colors that snap to the same brand color merge into one shape with no seams. With a library loaded, typing a swatch name fills in its exact color. Brand names flow into the chips, the SVG groups and the PDF spot plates.
- **Organized SVG**: one named group per ink (`<g id="Brew_Navy">`), with every shape a separate, named path (`Brew_Navy_1`, `Brew_Navy_2`, …) instead of one compound path, and a `<desc>` listing the inks. Print PDFs and DXFs merge shapes back into one plate or layer per ink.
- **Exact shapes**: outlines that are circles, ellipses, regular stars or polygons, or any straight-edged shape, are replaced with exact geometry. A circle becomes 4 curve segments instead of a dozen wobbly ones. Star points are rebuilt where their edges meet, so tips blunted by JPEG blur come back sharp. Shapes under ~12 px (letter dots and counters) and curved letters are left alone. The client sees what was made exact and can undo it.
- **Overlapping shapes kept separate**: on screen and in the editable SVG, an outline that is really a circle and a polygon overlapping (such as a starburst behind a disc) is split into the two shapes. The hidden part of the star is rebuilt, the star is drawn whole underneath, and the circle sits on top, the way a designer would build it. Holes in the top shape (lettering cut into the disc) are refilled with the color that showed through them. Print plates and cut files still keep each color only where it's visible, because otherwise the hidden part would print or cut.
- **Smooth gradients**: linear and radial gradients in flat artwork are kept as real SVG gradients (`<linearGradient>`/`<radialGradient>` with fitted color stops) instead of color bands. One editable shape replaces dozens of stripes, the file gets smaller, and the gradient doesn't use up the color budget. Logos with gradients are detected as logos, not photos. Gradients are kept for every purpose: print PDFs fill them with a PDF shading (axial or radial, full color; flat inks stay spot plates), and cut files (DXF) cut each gradient as one shape on its own layer. The client can turn them into color bands instead. How it works (`src/palette/gradients.ts`):
  1. Neighboring pixels whose (lightly blurred) colors differ by only a few units form regions; real edges, where color jumps, separate them.
  2. A region with a wide color range is fitted as a plane (linear) and a paraboloid (radial, its vertex is the center). The colors along the chosen direction become a profile, simplified to the fewest stops within 4 sRGB units.
  3. A fit is accepted only if it reproduces the pixels closely (RMS ≤ 7, ≥ 85% of variance explained); photos and texture fail and stay with the normal tracer. Pieces cut off by other shapes (the counter of an "O" in lettering) join the gradient that explains them.
  4. Gradient pixels get fixed labels, are left out of color clustering, and their edges get sub-pixel blend values against the gradient's color at each pixel, so outlines are as smooth as flat-color ones.
- **Font identification** (Fine-tune → More options → Fonts in this artwork): reads the text with OCR (Tesseract, self-hosted, loaded only when asked) and suggests the closest fonts per line with a match score. Each letter is cut out of the artwork and compared with the same letter rendered in every candidate font (shape overlap, plus x-height and cap-height ratios). Candidates:
  - *Free*: about 130 Google Fonts families, loaded as one variable font per family where available, subset to the characters found (only the set of letters is sent, never the words or the image).
  - *Installed*, which covers commercial fonts: "Include my installed fonts" lists the fonts on this computer with the Local Font Access API (Chrome and Edge only; the browser asks permission). This is how commercial fonts a studio owns, such as Helvetica, Futura or Gotham, are matched, privately.
  - *Online* (optional, commercial fonts the user doesn't have): "Search 1 million fonts online" sends a black-and-white image of just that line's lettering (no colors, background or rest of the artwork) to WhatFontIs and lists matches marked Commercial or Free, linking to each font's page. It only appears when the server has an API key, and it runs only when the client clicks it for a line.
- **Lettering rebuilt from the font, automatically**: once flat art is traced, the text is read and matched in the background (a "Matching the lettering…" note shows meanwhile). For each line whose best free match scores at least 80%, the lettering is rebuilt from that font; the note names the font, with "Use traced letters" to undo. Each match in the Fonts panel also has "Use for lettering" to pick a different font, including installed ones. The traced letters of that line are replaced by the font's real outlines (Google Fonts via Fontsource WOFF files, or the installed font file in Chrome/Edge), read with opentype.js (loaded only when used). Per word, one size and baseline are fitted by least squares to every letter's traced top, bottom and width, and each letter is centered on its traced position, so spacing matches the artwork. A word is rebuilt only if every letter was read, the fit is within 12% of the letter height, and the placed letters overlap the artwork's ink by at least 60% (IoU); otherwise it stays traced and the client is told. Punctuation is placed too. On screen and in web SVGs, the traced letters are erased (each traced shape is removed only if it overlaps the new letters, so nearby marks stay) and the outlines are drawn on top, grouped per word (`<g id="Text_BREW" data-font="Archivo Black">`, one path per letter). Print plates and cut files can't overlap, so there the outlines' exact coverage is written into the color map and traced. Undo puts the traced letters back.
- **Fast photos**: photos are traced at their own size (never upscaled), capped at ~1250 px, or 1600 px at high detail. Switching purpose doesn't re-trace a photo, and recent results are cached.
- **Robust input**: PNG, JPG, WebP, GIF and SVG. Images over 6000 px are scaled on load. HEIC, PSD, TIFF, corrupt, tiny or fully transparent files get a clear message.

### Swatch libraries

Pantone color data is licensed, so none ships with the app. Users import their own:

- `.ase` from Illustrator or Pantone Connect (RGB, Lab, CMYK, Gray entries)
- `.csv` / `.tsv`: name plus hex, `L,a,b` (with header) or `R,G,B`
- `.json`: `[{ "name", "hex" | "rgb" | "lab" }]` or `{ "name": "#hex" }`

The imported library is saved in the browser's localStorage. A small demo palette (not Pantone) is the default.

### Hosting

The page must be served with these headers, which enable multi-threaded WASM for the AI model (dev and preview servers already send them):

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

## How it works

- `src/vectorize/image.ts` loads the image, resizes it for tracing (downscales big images, upscales small ones to smooth jaggies), and post-processes the SVG.
- `src/vectorize/worker.ts` runs [VTracer](https://github.com/visioncortex/vtracer) (via the `vtracer-wasm` package) in a Web Worker.
- `src/vectorize/tracer.ts` manages the worker. A stale job is cancelled by terminating the worker.
- `src/vectorize/params.ts` holds presets, plus `toEngineConfig`, which translates UI values into what this WASM build expects.
- `src/vectorize/background.ts` contains flat-background removal.
- `src/ai/` contains the upscaler worker (tiled Swin2SR) and its main-thread client, which caches results per image.
- `src/palette/` contains color math (Lab D50, CIEDE2000), swatch file parsers, ink quantization and SVG annotation.

Pipeline: source → AI upscale → background removal → resize → flat-color tracer (or VTracer) → SVG post-processing.

### Flat-color tracer (`src/palette/quantize.ts`, `src/trace/`)

VTracer's own color clustering turns every anti-aliased edge into extra shapes (halos), and its curve fitting follows pixel staircases. For flat artwork we do this instead:

1. **Colors**: weighted k-means in Lab at source resolution. Then we drop "blend" clusters: anti-aliasing mixes, plus JPEG chroma-subsampling mixes, where brightness comes from one color while hue bleeds toward the other (for example, brown between navy and orange) that are also thin edge fringes, and merge near-duplicates (ΔE). Final colors are averaged from pure, non-edge pixels only.
2. **Clean-up**: a noise filter and removal of specks below the speckle size.
3. **Sub-pixel edges**: each edge pixel records which two colors it blends and in what ratio. Each layer's outline is the 0.5 iso-contour (marching squares) of a lightly smoothed coverage field.
4. **Shapes**: each outline is tested against an ellipse fitted from its area moments, then against a polygon (least-squares edge lines meeting at the corners, every point checked against it). Matches that are regular get snapped to a perfect star or polygon. See `src/trace/shapes.ts`.
5. **Overlaps** (stacked output only, `src/trace/decompose.ts`): an outline that isn't a single primitive is split at corners into straight runs and arcs. A circle is found through the corners where the edges meet it (by consensus over corner triples), and the polygon's hidden corners are rebuilt where edges on either side of an arc meet. It's accepted only if every traced point lies on the circle or the polygon, the areas match, and the hidden corners really are hidden. Colors are then sampled to decide which shape is in front.
6. **Curves**: everything else is resampled, corners detected and rebuilt where their edges intersect, then fitted with error-bounded cubic Béziers (Schneider).
7. **Stacking**: layers go largest-first, and each covers the layers above it, so no seams show.

### Checks

- `npm test`: unit tests for color math, parsers, quantizer, tracer, detection, the pipeline and the PDF/DXF writers.
- `/bench/conditions.html`: 17 kinds of input, run through the app's own functions, with every download validated.
- `/bench/index.html`: quality benchmark (below).

### Online font search (WhatFontIs)

The API key stays on a server; the browser only talks to `/api/identify-font` (code in `supabase/functions/identify-font/whatfontis.ts`).

- **Local**: get a key from https://www.whatfontis.com/API-identify-fonts-from-image.html, copy `.env.example` to `.env.local`, set `WHATFONTIS_API_KEY`, restart `npm run dev`. The dev and preview servers serve the endpoint themselves.
- **Production** (Supabase edge function, deployed to the `Vectorize` project `bkctlugpzwbdzoozrncm`):
  ```
  supabase secrets set WHATFONTIS_API_KEY=... ALLOWED_ORIGINS=https://your-app.example
  supabase functions deploy identify-font --no-verify-jwt
  ```
  Then build the app with `VITE_FONT_API_URL=https://<project>.supabase.co/functions/v1/identify-font`. Only sites listed in `ALLOWED_ORIGINS` can spend the quota.

### Quality benchmark

Open `/bench/index.html` on the dev server. It rasterizes ground-truth SVGs to small JPEGs, vectorizes them, and scores the output against the original (mean error, % wrong pixels, paths, curve segments, size). Query params: `cases=logo,badge,scene,ink`, `configs=logo,illustration,lineart,spot`, `set=param:value,...`.

### Known limits

- AI background removal (BiRefNet) was tried and dropped: on Apple GPUs it exceeds WebGPU's storage-buffer limit, and on WASM it runs out of memory.
- Gradients must be linear or radial with smooth color change; conic, mesh and freeform gradients, and gradients that fade into a background of the same color, are traced as flat bands.
- Lettering rebuild needs straight, horizontal text in a font that was matched: arched, rotated, outlined, hand-drawn or heavily distorted lettering doesn't line up and stays traced. Online (WhatFontIs) matches can't be used for it, since their font files aren't available.
- Without the online search, font identification only knows fonts that are free on Google Fonts or installed on this computer. WhatFontIs allows 200 searches a day per key by default, and is free for personal use only (with a link to WhatFontIs, which the panel shows); commercial use needs an agreement with them. Script and heavily distorted lettering (arched, outlined, textured) match poorly, and in Safari and Firefox only free fonts are compared.
- Very small text (under ~15 px tall in the source) still loses detail; AI upscaling first helps.
- A luma-guided chroma repair for JPEGs (the standard imaging fix for chroma subsampling) was tried and rejected. It smears adjacent colors of similar brightness in flat artwork (scene error 1.01 → 1.73), so fringes are handled during color clustering instead.

### vtracer-wasm quirks (handled in `toEngineConfig`)

This build differs from VTracer's CLI docs:

| Param | CLI meaning | What this build expects |
|---|---|---|
| `colorPrecision` | significant bits (1–8) | precision *loss* (`8 − bits`); 8 panics |
| `filterSpeckle` | side length (px) | area (px²) |
| `cornerThreshold`, `spliceThreshold` | degrees | radians |
