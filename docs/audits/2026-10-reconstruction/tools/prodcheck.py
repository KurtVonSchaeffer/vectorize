"""Independent checks of production exports.

PDF: decompresses every stream and looks for raster content (image XObjects, inline images, soft
masks), shadings/patterns, counts path operators, lists spot-colour separations and the page size.
DXF: units, extents, layers, entity types, closed vs open polylines, vertex counts.
Usage: prodcheck.py file.pdf|file.dxf ... -> JSON.
"""
import json, re, sys, zlib


def pdf(fn):
    data = open(fn, 'rb').read()
    streams = []
    for m in re.finditer(rb'(?<!end)stream\r?\n', data):
        start = m.end()
        end = data.find(b'endstream', start)
        raw = data[start:end]
        head = data[max(0, m.start()-400):m.start()]
        try:
            body = zlib.decompress(raw) if b'FlateDecode' in head.split(b'obj')[-1] else raw
        except Exception:
            body = raw
        streams.append(body)
    text = data.decode('latin1')
    content = b'\n'.join(streams).decode('latin1', 'replace')
    ops = re.findall(r'(?<![A-Za-z])(m|l|c|v|y|h|re|f\*?|F|B\*?|b\*?|S|s|n|sh|Do|BI|cs|scn|sc|q|Q|cm)(?![A-Za-z])', content)
    oc = {k: ops.count(k) for k in set(ops)}
    mb = re.search(r'/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]', text)
    w, h = (float(mb.group(3)) - float(mb.group(1)), float(mb.group(4)) - float(mb.group(2))) if mb else (None, None)
    seps = re.findall(r'/Separation\s*/(\S+)', text)
    return {
        'file': fn.split('/')[-1], 'bytes': len(data), 'pages': len(re.findall(r'/Type\s*/Page\b', text)),
        'page_mm': [round(w * 25.4 / 72, 1), round(h * 25.4 / 72, 1)] if w else None,
        'image_xobjects': len(re.findall(r'/Subtype\s*/Image', text)) + content.count('/Subtype /Image'),
        'inline_images': oc.get('BI', 0), 'xobject_draws': oc.get('Do', 0),
        'soft_masks': len(re.findall(r'/SMask', text)), 'shadings': oc.get('sh', 0) + len(re.findall(r'/ShadingType', text)),
        'patterns': len(re.findall(r'/PatternType', text)),
        'path_ops': {k: oc.get(k, 0) for k in ('m', 'l', 'c', 'h', 're')}, 'fill_ops': sum(oc.get(k, 0) for k in ('f', 'f*', 'F', 'B', 'B*', 'b', 'b*')),
        'stroke_ops': oc.get('S', 0) + oc.get('s', 0),
        'separations': [re.sub(r'#([0-9A-Fa-f]{2})', lambda x: chr(int(x.group(1), 16)), s) for s in seps],
        'verdict': 'raster-based' if (len(re.findall(r'/Subtype\s*/Image', text)) or oc.get('BI', 0)) else 'fully vector',
    }


def dxf(fn):
    lines = open(fn, encoding='utf8', errors='replace').read().splitlines()
    pairs = [(lines[k].strip(), lines[k+1].strip()) for k in range(0, len(lines) - 1, 2)]
    units = next((v for k, v in zip(range(len(pairs)), [p for p in pairs]) if False), None)
    hdr = {}
    for k, (c, v) in enumerate(pairs):
        if c == '9' and v in ('$INSUNITS', '$EXTMIN', '$EXTMAX', '$MEASUREMENT'):
            hdr[v] = [pairs[k+j][1] for j in range(1, 4) if k+j < len(pairs) and pairs[k+j][0] in ('70', '10', '20', '30')]
    ents = {}
    polys = []
    cur = None
    in_ent = False
    for c, v in pairs:
        if c == '2' and v == 'ENTITIES': in_ent = True
        if c == '0' and v == 'ENDSEC': in_ent = False
        if not in_ent: continue
        if c == '0':
            if cur and cur['type'] in ('POLYLINE', 'LWPOLYLINE') and v != 'VERTEX': polys.append(cur); cur = None
            if v in ('POLYLINE', 'LWPOLYLINE'):
                cur = {'type': v, 'flags': 0, 'verts': 0, 'layer': None}
            elif v == 'VERTEX' and cur: cur['verts'] += 1
            elif v == 'SEQEND' and cur: polys.append(cur); cur = None
            ents[v] = ents.get(v, 0) + 1
        elif cur is not None:
            if c == '70' and cur['verts'] == 0: cur['flags'] = int(v)
            if c == '8' and cur['layer'] is None: cur['layer'] = v
            if c == '10' and cur['type'] == 'LWPOLYLINE': cur['verts'] += 1
    layers = sorted({p['layer'] for p in polys})
    return {
        'file': fn.split('/')[-1], 'bytes': sum(len(l) + 1 for l in lines), 'units': {'4': 'mm', '1': 'inch', '0': 'unitless'}.get((hdr.get('$INSUNITS') or ['?'])[0], hdr.get('$INSUNITS')),
        'extent_mm': [round(float(hdr['$EXTMAX'][0]) - float(hdr['$EXTMIN'][0]), 2), round(float(hdr['$EXTMAX'][1]) - float(hdr['$EXTMIN'][1]), 2)] if '$EXTMAX' in hdr and '$EXTMIN' in hdr else None,
        'entities': {k: v for k, v in ents.items() if k not in ('VERTEX', 'SEQEND', 'SECTION', 'ENDSEC', 'EOF')},
        'polylines': len(polys), 'closed': sum(1 for p in polys if p['flags'] & 1), 'open': sum(1 for p in polys if not p['flags'] & 1),
        'vertices': sum(p['verts'] for p in polys), 'layers': layers,
    }


if __name__ == '__main__':
    print(json.dumps([pdf(f) if f.endswith('.pdf') else dxf(f) for f in sys.argv[1:]], indent=1))
