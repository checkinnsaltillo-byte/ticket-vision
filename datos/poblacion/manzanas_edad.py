#!/usr/bin/env python3
"""Pirámide de edad por manzana (Censo 2020, INEGI): polígono + población por sexo y grupo de edad.

Entradas (descargadas del INEGI, no incluidas en el repositorio):
  - Censo de Población y Vivienda 2020, "Principales resultados por AGEB y manzana urbana" (CSV) de la entidad.
  - Manzanas del Marco Geoestadístico (05m.shp) o del Inventario Nacional de Viviendas 2020 (INV2020_IND_PVEU_MZA_19.shp), LCC ITRF2008.
Grupos (7): 0–2, 3–5, 6–11, 12–17, 18–24, 25–59 (= resto), 60 y más; cada uno por sexo (hombres, mujeres).
Salida: JSON {meta, mz:[[cvegeo, lat, lng, [dx,dy,...] contorno en decímetros respecto al centroide, [h0,m0,...h6,m6], total]]}.
Uso: python3 manzanas_edad.py <csv> <shp> <salida.json> <lat_min> <lng_min> <lat_max> <lng_max>
"""
import csv, json, math, struct, sys
CSV, SHP, OUT = sys.argv[1], sys.argv[2], sys.argv[3]; LA0, LN0, LA1, LN1 = map(float, sys.argv[4:8])
# ── proyección Lambert cónica conforme (INEGI, GRS80) ────────────────────────────────────────────────────────
A = 6378137.0; F = 1 / 298.257222101; E2 = F * (2 - F); E = math.sqrt(E2)
def _m(p): return math.cos(p) / math.sqrt(1 - E2 * math.sin(p) ** 2)
def _t(p): s = math.sin(p); return math.tan(math.pi / 4 - p / 2) / ((1 - E * s) / (1 + E * s)) ** (E / 2)
P1, P2, P0, L0, FE = map(math.radians, (17.5, 29.5, 12.0, -102.0, 0)); FE = 2500000.0
N = (math.log(_m(P1)) - math.log(_m(P2))) / (math.log(_t(P1)) - math.log(_t(P2)))
FF = _m(P1) / (N * _t(P1) ** N); RHO0 = A * FF * _t(P0) ** N
def fwd(lat, lng):
    p, l = math.radians(lat), math.radians(lng); rho = A * FF * _t(p) ** N; th = N * (l - L0)
    return FE + rho * math.sin(th), RHO0 - rho * math.cos(th)
def inv(x, y):
    x -= FE; rho = math.copysign(math.hypot(x, RHO0 - y), N); th = math.atan2(x, RHO0 - y); t = (rho / (A * FF)) ** (1 / N); p = math.pi / 2 - 2 * math.atan(t)
    for _ in range(8): s = math.sin(p); p = math.pi / 2 - 2 * math.atan(t * ((1 - E * s) / (1 + E * s)) ** (E / 2))
    return math.degrees(p), math.degrees(th / N + L0)

# ── lectura de DBF y SHP (sin librerías externas) ─────────────────────────────────────────────────────────────
def leer_dbf(ruta):
    f = open(ruta, 'rb'); h = f.read(32); n, hl, rl = struct.unpack('<IHH', h[4:12]); campos = []; f.seek(32)
    while True:
        d = f.read(32)
        if d[0] == 0x0D: break
        campos.append((d[:11].split(b'\0')[0].decode('latin-1'), d[16]))
    f.seek(hl); out = []
    for _ in range(n):
        r = f.read(rl)
        if r[0:1] == b'*': out.append(None); continue
        p = 1; reg = {}
        for nom, ln in campos: reg[nom] = r[p:p + ln].decode('latin-1').strip(); p += ln
        out.append(reg)
    return out
def leer_shp(ruta):
    d = open(ruta, 'rb').read(); p = 100; out = []
    while p < len(d):
        ln = struct.unpack('>i', d[p + 4:p + 8])[0] * 2; c = d[p + 8:p + 8 + ln]; p += 8 + ln; t = struct.unpack('<i', c[:4])[0]
        if t == 0: out.append(None); continue
        npart, npts = struct.unpack('<ii', c[36:44]); partes = list(struct.unpack('<%di' % npart, c[44:44 + 4 * npart])) + [npts]; q = 44 + 4 * npart
        pts = struct.unpack('<%dd' % (2 * npts), c[q:q + 16 * npts]); pts = [(pts[2 * i], pts[2 * i + 1]) for i in range(npts)]
        out.append([pts[partes[i]:partes[i + 1]] for i in range(npart)])
    return out


def leer_dbf(ruta):
    f = open(ruta, 'rb'); h = f.read(32); n, hl, rl = struct.unpack('<IHH', h[4:12]); campos = []; f.seek(32)
    while True:
        d = f.read(32)
        if d[0] == 0x0D: break
        campos.append((d[:11].split(b'\0')[0].decode('latin-1'), d[16]))
    f.seek(hl); out = []
    for _ in range(n):
        r = f.read(rl)
        if r[0:1] == b'*': out.append(None); continue
        p = 1; reg = {}
        for nom, ln in campos: reg[nom] = r[p:p + ln].decode('latin-1').strip(); p += ln
        out.append(reg)
    return out
def leer_shp(ruta):
    d = open(ruta, 'rb').read(); p = 100; out = []
    while p < len(d):
        ln = struct.unpack('>i', d[p + 4:p + 8])[0] * 2; c = d[p + 8:p + 8 + ln]; p += 8 + ln; t = struct.unpack('<i', c[:4])[0]
        if t == 0: out.append(None); continue
        npart, npts = struct.unpack('<ii', c[36:44]); partes = list(struct.unpack('<%di' % npart, c[44:44 + 4 * npart])) + [npts]; q = 44 + 4 * npart
        pts = struct.unpack('<%dd' % (2 * npts), c[q:q + 16 * npts]); pts = [(pts[2 * i], pts[2 * i + 1]) for i in range(npts)]
        out.append([pts[partes[i]:partes[i + 1]] for i in range(npart)])
    return out
def area_f(r): return sum(r[i][0] * r[(i + 1) % len(r)][1] - r[(i + 1) % len(r)][0] * r[i][1] for i in range(len(r))) / 2
def dp(pts, tol):   # Douglas–Peucker sobre un anillo abierto
    if len(pts) < 4: return pts
    a, b = pts[0], pts[-1]; dx, dy = b[0] - a[0], b[1] - a[1]; L = math.hypot(dx, dy) or 1e-9; k, md = 0, -1
    for i in range(1, len(pts) - 1):
        d = abs(dy * pts[i][0] - dx * pts[i][1] + b[0] * a[1] - b[1] * a[0]) / L
        if d > md: md, k = d, i
    if md > tol: return dp(pts[:k + 1], tol)[:-1] + dp(pts[k:], tol)
    return [a, b]
def num(v):
    try: return int(v)
    except Exception: return None

filas = {}
for x in csv.DictReader(open(CSV, encoding='utf-8-sig')):
    if x.get('MZA', '000') in ('000', ''): continue
    filas[x['ENTIDAD'] + x['MUN'] + x['LOC'] + x['AGEB'] + x['MZA']] = x
reg = leer_dbf(SHP.replace('.shp', '.dbf')); geo = leer_shp(SHP); assert len(reg) == len(geo)
PARES = [('P_0A2',), ('P_3A5',), ('P_6A11',), ('P_12A14', 'P_15A17'), ('P_18A24',)]
out = []; sin_csv = 0; omit = 0; tot = 0
for rg, polys in zip(reg, geo):
    if rg is None or polys is None: continue
    x = filas.get(rg.get('CVEGEO'))
    if x is None: sin_csv += 1; continue
    pt = num(x['POBTOT'])
    if not pt: omit += 1; continue
    rings = [r for r in polys]; AR = [area_f(r) for r in rings]; tA = sum(abs(a) for a in AR)
    if tA < 1: continue
    cx = sum(sum(p[0] for p in r) / len(r) * abs(a) for r, a in zip(rings, AR)) / tA; cy = sum(sum(p[1] for p in r) / len(r) * abs(a) for r, a in zip(rings, AR)) / tA
    lat, lng = inv(cx, cy)
    if not (LA0 <= lat <= LA1 and LN0 <= lng <= LN1): continue
    # grupos por sexo (h, m): los de edad conocida; 25–59 = lo que resta del total por sexo después de restar los demás y los de 60 y más
    h = [0] * 7; m = [0] * 7
    for g, ps in enumerate(PARES):
        for p in ps:
            h[g] += num(x.get(p + '_M', '')) or 0; m[g] += num(x.get(p + '_F', '')) or 0
    h[6] = num(x.get('P_60YMAS_M', '')) or 0; m[6] = num(x.get('P_60YMAS_F', '')) or 0
    pm = num(x.get('POBMAS', '')); pf = num(x.get('POBFEM', ''))
    if pm is None or pf is None: pm = pt // 2; pf = pt - pm
    h[5] = max(0, pm - sum(h[:5]) - h[6]); m[5] = max(0, pf - sum(m[:5]) - m[6])
    # contorno del anillo exterior (el de mayor área), simplificado a 2 m y expresado en decímetros respecto al centroide
    k = max(range(len(rings)), key=lambda i: abs(AR[i])); ring = rings[k][:-1] if rings[k][0] == rings[k][-1] else rings[k]
    m0 = max(range(len(ring)), key=lambda i: math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1])); s = dp(ring[:m0 + 1], 2.0)[:-1] + dp(ring[m0:] + [ring[0]], 2.0)[:-1]; poly = []
    for px, py in s: poly += [round((px - cx) * 10), round((py - cy) * 10)]
    a = []
    for g in range(7): a += [h[g], m[g]]
    out.append([rg['CVEGEO'], round(lat, 6), round(lng, 6), poly, a, pt]); tot += pt
print('manzanas', len(out), 'población', tot, 'sin CSV', sin_csv, 'sin dato de población', omit)
json.dump({'meta': {'fuente': 'INEGI · Censo de Población y Vivienda 2020 (resultados por manzana)', 'grupos': ['0 a 2', '3 a 5', '6 a 11', '12 a 17', '18 a 24', '25 a 59', '60 y más'], 'orden': 'hombres, mujeres por grupo', 'poly': 'decímetros respecto al centroide (este, norte)', 'n': len(out)}, 'mz': out}, open(OUT, 'w'), separators=(',', ':'), ensure_ascii=False)
