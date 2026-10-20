# Clean geometry: no shape drawn twice

Behind the `clean-geometry` flag (`src/quality/flags.ts`), off for everyone by default:

| `VITE_CLEAN_GEOMETRY` | Effect |
| --- | --- |
| unset (production today) | Off. `?clean-geometry=on` in the address is ignored. |
| `preview` | Off unless the address has `?clean-geometry=on`. Set it only for Vercel's Preview environment. |
| `on` | On for everyone using that build: a release decision. |

The local dev server also honours `?clean-geometry=on`. With the flag off, every file is made exactly
as before (`src/vectorize/__tests__/fidelity/golden.test.ts`).

## The defect (RC8)

The master SVG is *stacked*: colours are layered largest first, and each layer covers its own area
plus every layer drawn above it, so neighbouring colours never show a hairline seam. But a layer
also covered higher shapes it never touches. In Docker's logo, the light-blue whale layer drew a
complete hidden copy of the darker "docker" lettering underneath it; in Brazil's flag, the blue and
yellow layers each drew the white counters of "ORDEM E PROGRESSO" again (islands inside the green
letters). Each copy is an exact duplicate outline: an extra object when the file is edited in
CorelDRAW or Illustrator, a shape a cutter would cut twice from the master SVG, and an anti-aliased
fringe of the wrong colour around the shape on top (the yellow emblem lettering on El Salvador's
flag was edged in green).

## The correction

`withoutHiddenCopies` in `src/trace/index.ts`: in stacked output, a layer drops every filled
outline whose area (inside it, outside its holes) holds none of the layer's own pixels, together
with its holes; islands inside those holes stay, still filled. Such an outline is entirely higher
layers, which draw it themselves, so nothing can disappear. A layer still runs under the higher
shapes it surrounds or touches, so shared boundaries keep their underlay and no seam opens.

Not changed: knockout output (print plates, cut files, so the print PDF and DXF), one colour (its
own engine; the option is not set for one-colour jobs), photos (VTracer), lettering rebuilt from
fonts, gradients.

## Results on the audit set (24 uploads, default settings)

`bench/clean-geometry.html?dir=…&files=…` traces each upload's master both ways and measures both
against the upload (`assessFidelity`), compares the two renders, and makes a PDF and DXF from each.

Totals: copied outlines 149 → 2, paths 559 → 378, outlines (subpaths) 764 → 571, SVG bytes −19%.
No pixel that is opaque in the upload and before became see-through after, on any upload. PDF and
DXF build from every result.

| Upload | Copies | Paths | Outlines | Bytes | Mean error vs upload | Edge recall % | Self-crossing | Verdict | Pixels changed | New transparency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| angular.png | 6 → 0 | 10 → 4 | 10 → 4 | −31% | 0.780 → 0.654 | 99.9 → 99.8 | 0 → 0 | check → ready | 0.57% | 0 |
| docker-small.jpg | 0 → 0 | 63 → 62 | 68 → 67 | −1% | 8.637 → 8.647 | 97.3 → 97.3 | 6 → 6 | check → check | 0.05% | 0 |
| docker.png | 7 → 0 | 45 → 38 | 61 → 51 | −23% | 3.775 → 3.658 | 99.7 → 99.8 | 0 → 0 | check → ready | 1.04% | 0 |
| firefox.png | 15 → 0 | 41 → 19 | 54 → 29 | −30% | 5.676 → 5.580 | 96.2 → 96.6 | 12 → 6 | check → check | 0.31% | 0 |
| flag-br.png | 16 → 0 | 55 → 39 | 100 → 84 | −12% | 0.444 → 0.446 | 99.7 → 99.7 | 0 → 0 | check → check | 0.01% | 0 |
| flag-mx.png | 16 → 2 | 73 → 44 | 104 → 74 | −17% | 1.172 → 1.152 | 88.6 → 88.4 | 19 → 15 | check → check | 0.08% | 0 |
| flag-sv.png | 43 → 0 | 102 → 57 | 120 → 72 | −30% | 1.013 → 0.929 | 91.7 → 91.4 | 1 → 1 | check → check | 0.31% | 0 |
| fluent-parrot.png | 7 → 0 | 16 → 9 | 17 → 10 | −21% | 0.271 → 0.235 | 100 → 100 | 0 → 0 | check → ready | 0.17% | 0 |
| linux.png | 16 → 0 | 37 → 20 | 43 → 26 | −15% | 3.612 → 3.595 | 86.5 → 86.3 | 1 → 1 | not suitable (both) | 0.07% | 0 |
| python-tiny.jpg | 15 → 0 | 37 → 17 | 41 → 20 | −45% | 6.043 → 5.199 | 97.0 → 95.0 | 3 → 1 | check → check | 2.74% | 0 |
| python.png | 2 → 0 | 6 → 4 | 6 → 4 | −31% | 0.613 → 0.567 | 100 → 100 | 0 → 0 | check → ready | 0.51% | 0 |
| ruby.png | 6 → 0 | 35 → 26 | 43 → 33 | −18% | 5.731 → 5.678 | 97.7 → 97.7 | 6 → 3 | not suitable (both) | 0.19% | 0 |

Byte-identical (nothing stacked separately): android, flag-br-web.jpg, github-mark, go,
javascript, kubernetes, react, rust, vue, world-thin. Photos (fluent-rocket, rocket-3d): VTracer,
unaffected.

Changed pixels are anti-aliased edges that no longer blend into a hidden copy's colour. Edge recall
falls slightly on five uploads (most on python-tiny.jpg, 97.0 → 95.0): there, seam lines drawn by
the hidden copies happened to sit on edges of the blurry upload, while the mean error still
improves (6.04 → 5.20).

**Left as is:** flag-mx keeps 2 coinciding outlines. They are underlays, not hidden copies: a brown
area inside an olive shape, where the brown layer runs under the whole olive shape so no seam shows
between them. Both layers hold their own pixels. Removing these would mean replacing the underlay
with a small bleed, a change to how seams are prevented, left for a later decision.

## In the app (dev server, `?clean-geometry=on` vs off)

- One colour: all six downloads byte-identical with and without the flag (4 uploads).
- Full colour: print PDF and DXF byte-identical (made from knockout plates); the master SVG, the
  SVGs made from it and the PNG change as above.

## Tests

`src/vectorize/__tests__/clean-geometry.test.ts`: separate lettering not copied (Docker, RC8) and a
letter's counter not copied (Brazil's motto), both shown to have copies before; rings keep their
holes, on transparency and over another colour; touching colours keep their underlay with no seam
along the shared edge; a separate shape drawn once in its own colour; rebuilt lettering, a gradient
beside flat colours, and shapes without stacked parts unchanged. Every case: no new transparency,
no colour lost, no further from the upload.

No CorelDRAW compatibility is claimed: the files are standard SVG, PDF and DXF as before, with fewer
objects.
