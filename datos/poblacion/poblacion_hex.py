#!/usr/bin/env python3
"""Población por hexágono a partir de manzanas del INEGI (interpolación areal que conserva la masa).

Entradas (descargadas del INEGI, no incluidas en el repositorio):
  - Censo de Población y Vivienda 2020, "Principales resultados por AGEB y manzana urbana", Coahuila (CSV).
  - Marco Geoestadístico, diciembre 2022, Coahuila: 05m.shp / 05m.dbf (manzanas), proyección LCC ITRF2008.
Método: cada manzana reparte su población entre los hexágonos que cubre, en proporción al área de la intersección
(se asume población uniforme dentro de la manzana). La suma de los hexágonos es igual a la de las manzanas.
Uso: python3 poblacion_hex.py <csv> <05m.shp> <salida.json> [radio_m=200]
"""
import csv, json, math, struct, sys
from collections import defaultdict

CSV, SHP, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
R = float(sys.argv[4]) if len(sys.argv) > 4 else 200.0
MUNS = {"030": ("Saltillo", 976477), "027": ("Ramos Arizpe", 139714), "004": ("Arteaga", 1158457 - 976477 - 139714)}  # EIC 2025
LAT0 = 25.4272; LNG0 = -100.9930  # ancla de la malla (Saltillo centro)

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

def area_firmada(ring): return sum(ring[i][0] * ring[(i + 1) % len(ring)][1] - ring[(i + 1) % len(ring)][0] * ring[i][1] for i in range(len(ring))) / 2
def recorta(sujeto, clip):  # Sutherland–Hodgman: polígono cualquiera contra polígono convexo antihorario
    sal = sujeto
    for i in range(len(clip)):
        a, b = clip[i], clip[(i + 1) % len(clip)]; ent = sal; sal = []
        if not ent: break
        dentro = lambda p: (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0
        def cruce(p, q):
            x1, y1, x2, y2, x3, y3, x4, y4 = p[0], p[1], q[0], q[1], a[0], a[1], b[0], b[1]; den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
            if abs(den) < 1e-12: return q
            t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den; return (x1 + t * (x2 - x1), y1 + t * (y2 - y1))
        s = ent[-1]
        for e in ent:
            if dentro(e):
                if not dentro(s): sal.append(cruce(s, e))
                sal.append(e)
            elif dentro(s): sal.append(cruce(s, e))
            s = e
    return sal

# ── malla hexagonal (vértice arriba) en el plano LCC, anclada en LAT0/LNG0 ───────────────────────────────────────
OX, OY = fwd(LAT0, LNG0); W = math.sqrt(3) * R
def centro(q, r): return OX + W * (q + r / 2), OY + 1.5 * R * r
def hexagono(q, r):
    cx, cy = centro(q, r); return [(cx + R * math.cos(math.radians(60 * k - 30)), cy + R * math.sin(math.radians(60 * k - 30))) for k in range(6)]  # antihorario

# ── datos ────────────────────────────────────────────────────────────────────────────────────────────────────
filas = list(csv.DictReader(open(CSV, encoding='utf-8-sig')))
pob = {}; tot_mun = {}
for x in filas:
    if x['MUN'] in MUNS and x['MZA'] not in ('000', ''):
        pob[x['ENTIDAD'] + x['MUN'] + x['LOC'] + x['AGEB'] + x['MZA']] = (int(x['POBTOT']) if x['POBTOT'].isdigit() else 0, int(x['TVIVHAB']) if x.get('TVIVHAB', '').isdigit() else 0)
    if x['MUN'] in MUNS and x['LOC'] == '0000' and x['AGEB'] == '0000' and x['MZA'] == '000': tot_mun[x['MUN']] = int(x['POBTOT'])
reg = leer_dbf(SHP.replace('.shp', '.dbf')); geo = leer_shp(SHP); assert len(reg) == len(geo)
hex_pob = defaultdict(lambda: [0.0, 0.0]); contrib = defaultdict(list); hex_mun = defaultdict(lambda: defaultdict(float)); usadas = set(); sin_pob = 0; geom_sin_csv = 0; pob_geom = 0
for rg, polys in zip(reg, geo):
    if rg is None or polys is None or rg.get('CVE_MUN') not in MUNS: continue
    cve = rg['CVEGEO']; dat = pob.get(cve)
    if dat is None: geom_sin_csv += 1; continue
    usadas.add(cve); p, v = dat; pob_geom += p
    rings = [[(x, y) for x, y in r] for r in polys]; A_m = sum(area_firmada(r) for r in rings)
    if p == 0 or abs(A_m) < 1e-6: continue
    # las manzanas vienen en LCC (metros); anillos exteriores horarios (área negativa) y huecos antihorarios
    xs = [x for r in rings for x, y in r]; ys = [y for r in rings for x, y in r]; x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    r_lo, r_hi = math.floor((y0 - OY - R) / (1.5 * R)), math.ceil((y1 - OY + R) / (1.5 * R)); partes = []
    for rr in range(r_lo, r_hi + 1):
        q_lo, q_hi = math.floor((x0 - OX - R) / W - rr / 2), math.ceil((x1 - OX + R) / W - rr / 2)
        for qq in range(q_lo, q_hi + 1):
            hx = hexagono(qq, rr); a = 0.0
            for ring in rings:
                sg = area_firmada(ring); cl = recorta(ring, hx)  # anillos exteriores: área negativa (horario); huecos: positiva
                if len(cl) >= 3: a += abs(area_firmada(cl)) * (1 if sg < 0 else -1)
            if a > 1e-6: partes.append(((qq, rr), a))
    tot = sum(a for _, a in partes) or 1.0
    for k, a in partes:
        f_ = a / tot; hex_pob[k][0] += p * f_; hex_pob[k][1] += v * f_; hex_mun[k][rg['CVE_MUN']] += p * f_; contrib[k].append((cve, round(p * f_, 1), round(f_, 3)))

# ── resultado ────────────────────────────────────────────────────────────────────────────────────────────────────
esc = {m: MUNS[m][1] / tot_mun[m] for m in MUNS}; out = []
for k, (p, v) in hex_pob.items():
    if p < 0.5: continue
    la, ln = inv(*centro(*k)); mun = max(hex_mun[k].items(), key=lambda kv: kv[1])[0]
    # el factor 2025 de cada hexágono mezcla los de los municipios que aporta
    p25 = sum(pm * esc[m] for m, pm in hex_mun[k].items())
    out.append({'q': k[0], 'r': k[1], 'lat': round(la, 6), 'lng': round(ln, 6), 'p20': round(p, 1), 'p25': round(p25, 1), 'viv': round(v, 1), 'mun': mun, 'mz': sorted(contrib[k], key=lambda c: -c[1])[:4]})
meta = {'fuente': 'INEGI · Censo de Población y Vivienda 2020 (manzanas urbanas) + Marco Geoestadístico dic. 2022', 'metodo': 'interpolación areal que conserva la población (reparto proporcional al área de intersección manzana-hexágono)', 'radio_m': R, 'ancla': [LAT0, LNG0],
        'escala_2025': {m: {'municipio': MUNS[m][0], 'pob2025': MUNS[m][1], 'pob2020': tot_mun[m], 'factor': round(esc[m], 4)} for m in MUNS}, 'nota_2025': 'p25 = p20 × (población municipal EIC 2025 / población municipal Censo 2020); estimación, no dato de manzana',
        'manzanas_csv': len(pob), 'manzanas_con_geometria': len(usadas), 'geometrias_sin_dato_2020': geom_sin_csv, 'pob_csv': sum(v[0] for v in pob.values()), 'pob_con_geometria': pob_geom,
        'pob_hexagonos_2020': round(sum(h['p20'] for h in out), 1), 'pob_hexagonos_2025': round(sum(h['p25'] for h in out), 1), 'hexagonos': len(out)}
json.dump({'meta': meta, 'hex': out}, open(OUT, 'w'), ensure_ascii=False, separators=(',', ':')); print(json.dumps(meta, ensure_ascii=False, indent=1))
