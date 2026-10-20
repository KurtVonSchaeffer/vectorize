"""Independent vector-integrity check of an SVG (does not use Vectorize's own validators).

Reports: element inventory, raster / disguise constructs (image, base64, data: URIs, filters,
masks, patterns, foreignObject, external refs), gradients, paths, nodes, subpaths, open contours,
duplicate paths, slivers, self-intersections, and colour "banding" (many near-identical flat fills
that imitate a gradient). Usage: svgcheck.py file.svg -> JSON on stdout.
"""
import json, math, re, sys, xml.etree.ElementTree as ET
from collections import Counter, defaultdict

NUM = re.compile(r'[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?')
TOK = re.compile(r'[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?')
ARGS = dict(M=2, L=2, H=1, V=1, C=6, S=4, Q=4, T=2, A=7, Z=0)


def parse_path(d):
    """-> list of subpaths: {'pts': flattened polyline, 'nodes': n, 'closed': bool, 'arcs': n}"""
    toks = TOK.findall(d)
    subs, cur, i = [], None, 0
    x = y = sx = sy = 0.0
    lc = None  # last control point for S/T
    cmd = None
    def bez(p0, p1, p2, p3, n=10):
        return [((1-t)**3*p0[0]+3*(1-t)**2*t*p1[0]+3*(1-t)*t*t*p2[0]+t**3*p3[0],
                 (1-t)**3*p0[1]+3*(1-t)**2*t*p1[1]+3*(1-t)*t*t*p2[1]+t**3*p3[1]) for t in (k/n for k in range(1, n+1))]
    while i < len(toks):
        if re.match(r'[A-Za-z]', toks[i]):
            cmd = toks[i]; i += 1
            if cmd in 'Zz':
                if cur: cur['closed'] = True; cur['pts'].append((sx, sy))
                x, y = sx, sy; lc = None
                continue
        if cmd is None: break
        n = ARGS[cmd.upper()]
        a = [float(t) for t in toks[i:i+n]]
        if len(a) < n: break
        i += n
        rel = cmd.islower()
        C = cmd.upper()
        if C == 'M':
            nx, ny = (x+a[0], y+a[1]) if rel else (a[0], a[1])
            cur = {'pts': [(nx, ny)], 'nodes': 1, 'closed': False, 'arcs': 0}
            subs.append(cur); x, y, sx, sy = nx, ny, nx, ny
            cmd = 'l' if rel else 'L'; lc = None
            continue
        if cur is None:
            cur = {'pts': [(x, y)], 'nodes': 1, 'closed': False, 'arcs': 0}; subs.append(cur)
        if C in 'LHVT A':
            pass
        if C == 'L': nx, ny = (x+a[0], y+a[1]) if rel else (a[0], a[1]); cur['pts'].append((nx, ny)); lc = None
        elif C == 'H': nx, ny = (x+a[0] if rel else a[0]), y; cur['pts'].append((nx, ny)); lc = None
        elif C == 'V': nx, ny = x, (y+a[0] if rel else a[0]); cur['pts'].append((nx, ny)); lc = None
        elif C == 'C':
            p = [(x+a[k], y+a[k+1]) if rel else (a[k], a[k+1]) for k in (0, 2, 4)]
            cur['pts'] += bez((x, y), p[0], p[1], p[2]); nx, ny = p[2]; lc = p[1]
        elif C == 'S':
            c1 = (2*x-lc[0], 2*y-lc[1]) if lc else (x, y)
            p = [(x+a[k], y+a[k+1]) if rel else (a[k], a[k+1]) for k in (0, 2)]
            cur['pts'] += bez((x, y), c1, p[0], p[1]); nx, ny = p[1]; lc = p[0]
        elif C == 'Q':
            q = [(x+a[k], y+a[k+1]) if rel else (a[k], a[k+1]) for k in (0, 2)]
            c1 = (x+2/3*(q[0][0]-x), y+2/3*(q[0][1]-y)); c2 = (q[1][0]+2/3*(q[0][0]-q[1][0]), q[1][1]+2/3*(q[0][1]-q[1][1]))
            cur['pts'] += bez((x, y), c1, c2, q[1]); nx, ny = q[1]; lc = None
        elif C == 'T':
            nx, ny = (x+a[0], y+a[1]) if rel else (a[0], a[1]); cur['pts'].append((nx, ny)); lc = None
        elif C == 'A':
            nx, ny = (x+a[5], y+a[6]) if rel else (a[5], a[6]); cur['pts'].append((nx, ny)); cur['arcs'] += 1; lc = None
        cur['nodes'] += 1
        x, y = nx, ny
    return subs


def area(pts):
    return 0.5 * sum(pts[k][0]*pts[k+1][1] - pts[k+1][0]*pts[k][1] for k in range(len(pts)-1))


def perimeter(pts):
    return sum(math.dist(pts[k], pts[k+1]) for k in range(len(pts)-1))


def self_intersects(pts, cell=6.0):
    """True if two non-adjacent segments of the closed polyline cross (grid-bucketed)."""
    segs = [(pts[k], pts[k+1]) for k in range(len(pts)-1) if pts[k] != pts[k+1]]
    n = len(segs)
    if n < 4: return False
    grid = defaultdict(list)
    for k, (a, b) in enumerate(segs):
        for gx in range(int(min(a[0], b[0])//cell), int(max(a[0], b[0])//cell)+1):
            for gy in range(int(min(a[1], b[1])//cell), int(max(a[1], b[1])//cell)+1):
                grid[(gx, gy)].append(k)
    def cross(p, q, r, s):
        d = (q[0]-p[0])*(s[1]-r[1]) - (q[1]-p[1])*(s[0]-r[0])
        if abs(d) < 1e-12: return False
        t = ((r[0]-p[0])*(s[1]-r[1]) - (r[1]-p[1])*(s[0]-r[0])) / d
        u = ((r[0]-p[0])*(q[1]-p[1]) - (r[1]-p[1])*(q[0]-p[0])) / d
        return 1e-6 < t < 1-1e-6 and 1e-6 < u < 1-1e-6
    seen = set()
    for bucket in grid.values():
        for ii in range(len(bucket)):
            for jj in range(ii+1, len(bucket)):
                a, b = bucket[ii], bucket[jj]
                if abs(a-b) <= 1 or {a, b} == {0, n-1} or (a, b) in seen: continue
                seen.add((a, b))
                if cross(*segs[a], *segs[b]): return True
    return False


def lab(hexc):
    r, g, b = [int(hexc[k:k+2], 16)/255 for k in (1, 3, 5)]
    lin = [c/12.92 if c <= 0.04045 else ((c+0.055)/1.055)**2.4 for c in (r, g, b)]
    X = (0.4124*lin[0]+0.3576*lin[1]+0.1805*lin[2])/0.95047
    Y = 0.2126*lin[0]+0.7152*lin[1]+0.0722*lin[2]
    Z = (0.0193*lin[0]+0.1192*lin[1]+0.9505*lin[2])/1.08883
    f = lambda t: t**(1/3) if t > 0.008856 else 7.787*t+16/116
    return (116*f(Y)-16, 500*(f(X)-f(Y)), 200*(f(Y)-f(Z)))


def check(fn):
    text = open(fn, encoding='utf8').read()
    root = ET.fromstring(text)
    tags = Counter(el.tag.split('}')[-1] for el in root.iter())
    out = {'file': fn.split('/')[-1], 'bytes': len(text.encode()), 'root': {k: root.get(k) for k in ('width', 'height', 'viewBox')}, 'elements': dict(tags)}
    raster = {
        'image elements': tags.get('image', 0),
        'base64 data': len(re.findall(r'base64,', text)),
        'data: URIs': len(re.findall(r'data:', text)),
        'filters': tags.get('filter', 0), 'masks': tags.get('mask', 0), 'patterns': tags.get('pattern', 0),
        'foreignObject': tags.get('foreignObject', 0),
        'external hrefs': len(re.findall(r'href="(?!#)[^"]+"', text)),
        'text elements': tags.get('text', 0),
    }
    out['raster_or_disguise'] = raster
    out['gradients'] = tags.get('linearGradient', 0) + tags.get('radialGradient', 0)
    out['gradient_fills'] = len(re.findall(r'fill="url\(#', text))
    paths, fills = [], []
    for el in root.iter():
        t = el.tag.split('}')[-1]
        if t != 'path': continue
        fill = el.get('fill') or ''
        if not fill:
            # inherited from a parent group
            fill = 'inherit'
        paths.append((el.get('d') or '', fill, el.get('fill-rule') or 'nonzero', el.get('stroke')))
    out['paths'] = len(paths)
    out['stroked_paths'] = sum(1 for p in paths if p[3] and p[3] != 'none')
    dup = Counter((d, f) for d, f, *_ in paths)
    out['duplicate_paths'] = sum(c-1 for c in dup.values() if c > 1)
    dup_d = Counter(d for d, *_ in paths)
    out['same_shape_different_fill'] = sum(c-1 for c in dup_d.values() if c > 1) - out['duplicate_paths']
    nodes = subs = open_ = slivers = tiny = selfx = arcs = 0
    worst = []
    for d, f, rule, _ in paths:
        for s in parse_path(d):
            subs += 1; nodes += s['nodes']; arcs += s['arcs']
            pts = s['pts']
            if not s['closed']: open_ += 1
            if len(pts) < 3: tiny += 1; continue
            if pts[0] != pts[-1]: pts = pts + [pts[0]]
            A, P = abs(area(pts)), perimeter(pts)
            width = 2*A/P if P else 0
            if A < 2: tiny += 1
            elif width < 0.5 and A < 60: slivers += 1
            if len(pts) < 4000 and self_intersects(pts): selfx += 1
            worst.append((s['nodes'], round(A, 1)))
    out.update(subpaths=subs, nodes=nodes, open_subpaths=open_, tiny_subpaths_under_2px2=tiny, slivers_under_half_px=slivers,
               self_intersecting_subpaths=selfx, arc_commands=arcs, max_nodes_in_one_subpath=max([w[0] for w in worst], default=0))
    # Colour banding: flat fills so close to each other they read as one colour stepped in bands.
    cols = sorted({f.upper() for _, f, *_ in paths if re.fullmatch(r'#[0-9A-Fa-f]{6}', f)})
    labs = {c: lab(c) for c in cols}
    adj = defaultdict(set)
    for a in cols:
        for b in cols:
            if a < b and math.dist(labs[a], labs[b]) < 6: adj[a].add(b); adj[b].add(a)
    seen, ramps = set(), []
    for c in cols:
        if c in seen: continue
        comp, st = [], [c]
        while st:
            u = st.pop()
            if u in seen: continue
            seen.add(u); comp.append(u); st += list(adj[u])
        if len(comp) >= 5: ramps.append(len(comp))
    out['flat_colours'] = len(cols)
    out['band_ramps'] = ramps  # groups of >= 5 near-identical colours (dE76 < 6 chained)
    out['verdict'] = ('raster-based' if raster['image elements'] or raster['base64 data'] else
                      'mixed / disguised' if raster['filters'] or raster['masks'] or raster['patterns'] or raster['foreignObject'] or raster['external hrefs'] else
                      'fully vector')
    return out


if __name__ == '__main__':
    print(json.dumps([check(f) for f in sys.argv[1:]], indent=1))
