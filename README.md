# Vectorize one colour: CorelDRAW acceptance checklist

Files made by the app itself (production build of `integrate/one-colour` at `5861ee5`, PR #23), one folder per case. Each folder has the input image, screenshots of the app, and the five downloads:

| File | What it is |
|---|---|
| `print--…-print.pdf` | Print PDF: spot-colour plates |
| `print--…-print.svg` | Print SVG: the same artwork as the PDF |
| `cut--….svg` | Cut SVG (Cricut, Silhouette, vinyl) |
| `cut--…-cut.dxf` | Cut DXF (laser, plotter) |
| `website-master--….svg` | The editable master (website download): every shape, with the background and no gaps |

Every expected value below was measured from these exact files.

## General checks (every one-colour case, 01–09)

1. **PDF, separations:** open in CorelDRAW (or Acrobat → Output Preview → Separations). Expect exactly **one** spot plate, named as listed. No White, Cream or background plate. Paper shows through where the artwork has no ink.
2. **PDF, size:** the page is exactly the listed size (Layout → Page size; the artwork fills the page).
3. **Print SVG and cut SVG import:** Document units mm. The imported group is exactly the listed size, at 100 % with no scaling prompt or a 1:1 import. No rectangle or background object behind the artwork.
4. **DXF import:** units millimetres, scale 1:1. The size matches. One layer, named as listed. All outlines closed (they should fill or weld cleanly).
5. **Gaps:** where listed, measure the gap between neighbouring pieces with the Dimension tool. Expect the listed width (±0.1 mm). Pieces must not touch or overlap.
6. **Pieces:** Object → Break Apart (or ungroup), then count the separate pieces against the expected count. Holes (letter counters, the star) must be holes, not white-filled objects.
7. **Master SVG:** keeps the background and every former colour as shapes in one ink, with **no** gaps. It is in pixels (the website file), so its size in mm depends on CorelDRAW's px import setting. That is expected.
8. **Round trip:** export the imported cut SVG and DXF to your cutter software, or print a separation proof from the PDF, and check nothing is lost or doubled.

## Cases

### 01-two-colour-badge: Teal ring and yellow centre with a white star, on white; gap at the ring / centre edge

- **Input:** `input-1-flat-badge.png`
- **Size (all print and cut files):** 200 × 200 mm
- **PDF:** 1 plate: **Custom ink #0F8A7E**, RGB (15, 138, 126)
- **Print SVG:** `print--1-flat-badge-print.svg`, 200mm × 200mm, fill #0F8A7E only, 2 path(s)
- **Cut SVG:** `cut--1-flat-badge.svg`, 200mm × 200mm, 2 path(s) / 4 outline(s)
- **DXF:** `cut--1-flat-badge-cut.dxf`, mm, 200 × 200 mm; layer `CUSTOM_INK_0F8A7E`; 4 closed outline(s)
- **Gap:** 0.5 mm where a gap is cut
- **Cutting:** 2 pieces: the ring, and the centre with the star open as a hole. A 0.5 mm gap between ring and centre.
- **Transparency:** no background in the PDF, print SVG, cut SVG or DXF; the master SVG keeps it (#FFFFFF, #0F8A7E).
- **App note:** "2 colours drawn in the ink."; Print plate: Custom ink #0F8A7E (not matched to an ink library)

### 02-white-letters: White lettering on a teal panel: the letters must be open (holes), not white ink

- **Input:** `input-8-white-letters.png`
- **Size (all print and cut files):** 200 × 80 mm
- **PDF:** 1 plate: **Custom ink #0F8A7E**, RGB (15, 138, 126)
- **Print SVG:** `print--8-white-letters-print.svg`, 200mm × 80mm, fill #0F8A7E only, 3 path(s)
- **Cut SVG:** `cut--8-white-letters.svg`, 200mm × 80mm, 3 path(s) / 10 outline(s)
- **DXF:** `cut--8-white-letters-cut.dxf`, mm, 200 × 80 mm; layer `CUSTOM_INK_0F8A7E`; 10 closed outline(s)
- **Gap:** 0.5 mm where a gap is cut
- **Cutting:** Panel with the letters open: no white objects; letter counters (A, E…) are separate pieces.
- **Transparency:** no background in the PDF, print SVG, cut SVG or DXF; the master SVG keeps it (#FFFFFF, #0F8A7E).
- **App note:** "1 colour drawn in the ink."; Print plate: Custom ink #0F8A7E (not matched to an ink library)

### 03-transparent-png: Transparent PNG: no background anywhere

- **Input:** `input-4-transparent.png`
- **Size (all print and cut files):** 200 × 200 mm
- **PDF:** 1 plate: **Custom ink #1D3557**, RGB (29, 53, 87)
- **Print SVG:** `print--4-transparent-print.svg`, 200mm × 200mm, fill #1D3557 only, 2 path(s)
- **Cut SVG:** `cut--4-transparent.svg`, 200mm × 200mm, 2 path(s) / 3 outline(s)
- **DXF:** `cut--4-transparent-cut.dxf`, mm, 200 × 200 mm; layer `CUSTOM_INK_1D3557`; 3 closed outline(s)
- **Gap:** 0.5 mm where a gap is cut
- **Cutting:** 2 pieces (diamond, and the disc inside it with a 0.5 mm gap). No background object.
- **Transparency:** no background in the PDF, print SVG, cut SVG or DXF; the master SVG keeps it (#1D3557).
- **App note:** "2 colours drawn in the ink."; Print plate: Custom ink #1D3557 (not matched to an ink library)

### 04-gradient-feathers: Overlapping gradient feathers: no gaps inside a feather, gaps only where feathers cross

- **Input:** `input-feathers.png`
- **Size (all print and cut files):** 200 × 200 mm
- **PDF:** 1 plate: **Custom ink #4044C5**, RGB (64, 68, 197)
- **Print SVG:** `print--feathers-print.svg`, 200mm × 200mm, fill #4044C5 only, 5 path(s)
- **Cut SVG:** `cut--feathers.svg`, 200mm × 200mm, 5 path(s) / 5 outline(s)
- **DXF:** `cut--feathers-cut.dxf`, mm, 200 × 200 mm; layer `CUSTOM_INK_4044C5`; 5 closed outline(s)
- **Gap:** 0.5 mm where a gap is cut
- **Cutting:** 5 pieces. No gaps inside any feather; gaps only where one feather crosses another. One place ringed in the app (a hairline sliver taken into a gap).
- **Transparency:** no background in the PDF, print SVG, cut SVG or DXF; the master SVG keeps it (#FFFFFF, #4044C5).
- **App note:** "8 colours drawn in the ink."; Print plate: Custom ink #4044C5 (not matched to an ink library)

### 05-stripes: Red block with yellow stripes: cut into strips at the stripe edges

- **Input:** `input-9-stripes.png`
- **Size (all print and cut files):** 200 × 120 mm
- **PDF:** 1 plate: **Custom ink #E63A46**, RGB (230, 58, 70)
- **Print SVG:** `print--9-stripes-print.svg`, 200mm × 120mm, fill #E63A46 only, 12 path(s)
- **Cut SVG:** `cut--9-stripes.svg`, 200mm × 120mm, 12 path(s) / 12 outline(s)
- **DXF:** `cut--9-stripes-cut.dxf`, mm, 200 × 120 mm; layer `CUSTOM_INK_E63A46`; 12 closed outline(s)
- **Gap:** 0.5 mm where a gap is cut
- **Cutting:** 12 strips: the red block cut at each stripe edge.
- **Transparency:** no background in the PDF, print SVG, cut SVG or DXF; the master SVG keeps it (#FFFFFF, #E63A46).
- **App note:** "2 colours drawn in the ink."; Print plate: Custom ink #E63A46 (not matched to an ink library)

### 06-venn-widened-gap: Small image: the gap is widened beyond 0.5 mm, and the note says so

- **Input:** `input-7-venn.png`
- **Size (all print and cut files):** 200 × 160 mm
- **PDF:** 1 plate: **Custom ink #1D3557**, RGB (29, 53, 87)
- **Print SVG:** `print--7-venn-print.svg`, 200mm × 160mm, fill #1D3557 only, 2 path(s)
- **Cut SVG:** `cut--7-venn.svg`, 200mm × 160mm, 2 path(s) / 2 outline(s)
- **DXF:** `cut--7-venn-cut.dxf`, mm, 200 × 160 mm; layer `CUSTOM_INK_1D3557`; 2 closed outline(s)
- **Gap:** 0.6 mm (widened from 0.5 mm; the app says so)
- **Cutting:** 2 pieces (red crescent, navy disc) with a 0.6 mm gap along the curved boundary.
- **Transparency:** no background in the PDF, print SVG, cut SVG or DXF; the master SVG keeps it (#FFFFFF, #1D3557).
- **App note:** "2 colours drawn in the ink."; Print plate: Custom ink #1D3557 (not matched to an ink library)

### 07-library-ink: Ink chosen from the ink library (demo inks): plate named after it

- **Input:** `input-1-flat-badge.png`
- **Size (all print and cut files):** 200 × 200 mm
- **PDF:** 1 plate: **Demo Teal**, RGB (0, 163, 161)
- **Print SVG:** `print--1-flat-badge-print.svg`, 200mm × 200mm, fill #00A3A1 only, 2 path(s)
- **Cut SVG:** `cut--1-flat-badge.svg`, 200mm × 200mm, 2 path(s) / 4 outline(s)
- **DXF:** `cut--1-flat-badge-cut.dxf`, mm, 200 × 200 mm; layer `DEMO_TEAL`; 4 closed outline(s)
- **Gap:** 0.5 mm where a gap is cut
- **Cutting:** Same artwork as 01; only the ink and its name differ.
- **Transparency:** no background in the PDF, print SVG, cut SVG or DXF; the master SVG keeps it (#FFFFFF, #00A3A1).
- **App note:** "2 colours drawn in the ink."; Print plate: Demo Teal (a demo ink, not a real ink library)

### 08-output-300mm: Output width changed to 300 mm: every file at 300 mm

- **Input:** `input-2-lettering.jpg`
- **Size (all print and cut files):** 300 × 120 mm
- **PDF:** 1 plate: **Custom ink #2C2D42**, RGB (44, 45, 66)
- **Print SVG:** `print--2-lettering-print.svg`, 300mm × 120mm, fill #2C2D42 only, 7 path(s)
- **Cut SVG:** `cut--2-lettering.svg`, 300mm × 120mm, 7 path(s) / 14 outline(s)
- **DXF:** `cut--2-lettering-cut.dxf`, mm, 300 × 120 mm; layer `CUSTOM_INK_2C2D42`; 14 closed outline(s)
- **Gap:** 0.5 mm where a gap is cut
- **Cutting:** Lettering panel with the letters open; everything at 300 mm wide.
- **Transparency:** no background in the PDF, print SVG, cut SVG or DXF; the master SVG keeps it (#2C2D42, #FFFFFF).
- **App note:** "1 colour drawn in the ink · 1 light colour left open as negative space."; Print plate: Custom ink #2C2D42 (not matched to an ink library)

### 09-white-ink-on-navy: White ink chosen, navy garment: the white star prints, the navy does not

- **Input:** `input-12-navy-garment.png`
- **Size (all print and cut files):** 200 × 133.3 mm
- **PDF:** 1 plate: **Custom ink #FFFFFF**, RGB (255, 255, 255)
- **Print SVG:** `print--12-navy-garment-print.svg`, 200mm × 133.333mm, fill #FFFFFF only, 1 path(s)
- **Cut SVG:** `cut--12-navy-garment.svg`, 200mm × 133.333mm, 1 path(s) / 2 outline(s)
- **DXF:** `cut--12-navy-garment-cut.dxf`, mm, 200 × 133.333 mm; layer `CUSTOM_INK_FFFFFF`; 2 closed outline(s)
- **Gap:** 0.5 mm where a gap is cut
- **Cutting:** One white star (with the navy circle in its middle open). The navy garment is not printed.
- **Transparency:** no background in the PDF, print SVG, cut SVG or DXF; the master SVG keeps it (#1D3557, #FFFFFF).
- **App note:** "1 colour drawn in the ink."; Print plate: Custom ink #FFFFFF (not matched to an ink library)

### 10-legacy-silhouette: Legacy one-ink silhouette, for comparison (not size-aware: PDF 254 mm)

- **Input:** `input-1-flat-badge.png`
- **PDF:** page 254 × 254 mm (fixed 254 mm, not the chosen width); 1 plate **Demo Green** (RGB [43, 168, 74])
- **Print and cut SVG:** 800 × 800 (unitless px); 1 piece(s)
- **DXF:** 200 × 200 mm; layer `DEMO_GREEN`
- **Expected:** Legacy output for comparison: one solid silhouette, no gaps. Not size-aware. Its sizes disagree (254 mm PDF, 200 mm DXF, px SVG) because the legacy mode has no output width. It is only here for comparison.

## Record the result

For each case: pass or fail per check (1–8), the CorelDRAW version, and a screenshot of any failure (Separations, Object Manager, dimension). PR #23 stays a draft until all one-colour cases (01–09) pass.
