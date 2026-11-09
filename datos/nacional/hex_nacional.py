#!/usr/bin/env python3
"""Hexágonos de población y nivel socioeconómico (NSE) de TODO México, listos de antemano en Cloud Storage.

Por estado: lee las manzanas con geometría que ya dejó nacional.py (censo/mun/<ent>/<entmun>.json), baja el CSV del Censo 2020
(rasgos de vivienda, bienes y escolaridad) y calcula, igual que el piloto de Saltillo y Monterrey:
  · población y viviendas por hexágono de 200 m (interpolación areal que conserva la población) en una malla ÚNICA nacional (LCC INEGI, ancla 23° N / 102° O);
  · NSE por hexágono: primer componente principal de 13 rasgos (ponderado por hogares) y 4 estratos por Dalenius y Hodges.
    El índice es RELATIVO A LA ENTIDAD (no es una escala nacional ni la clasificación comercial AMAI).
Salida (Cloud Storage):
  hex/<ent>/<i>_<j>.json   celdas de 0.2° (i = piso(lat/0.2), j = piso(lng/0.2)): {"c":[i,j],"hex":[[q,r,lat,lng,p20,viv,mun],…],"nse":[null|[indice,nivel,esc,auto,inter,pc,oc,posb,ss,pt],…]}
  hex/<ent>/index.json     meta del estado (variables y cortes del NSE, celdas) y marca de «terminado»
Reanudable (salta estados con index.json; --forzar rehace). Con Cloud Run Jobs cada tarea toma los estados que le tocan.
Uso: python3 -I hex_nacional.py [--estados 05,19] [--local CARPETA_SALIDA] [--censo-local CARPETA_CON_censo/mun] [--csv RUTA.zip] [--forzar] [--trabajo /tmp/hx]
"""
import argparse, csv, glob, io, json, math, os, shutil, sys, time, zipfile
from collections import defaultdict
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nacional import baja, log, CENSO, NOMBRES, Salida
import ingreso as ING

LAT0, LNG0, R, CELDA = 23.0, -102.0, 200.0, 0.2
A = 6378137.0; F = 1 / 298.257222101; E2 = F * (2 - F); E = math.sqrt(E2)
def _m(p): return math.cos(p) / math.sqrt(1 - E2 * math.sin(p) ** 2)
def _t(p): s = math.sin(p); return math.tan(math.pi / 4 - p / 2) / ((1 - E * s) / (1 + E * s)) ** (E / 2)
P1, P2, P0, L0 = map(math.radians, (17.5, 29.5, 12.0, -102.0)); FE = 2500000.0
N = (math.log(_m(P1)) - math.log(_m(P2))) / (math.log(_t(P1)) - math.log(_t(P2)))
FF = _m(P1) / (N * _t(P1) ** N); RHO0 = A * FF * _t(P0) ** N
def fwd(lat, lng):
    p, l = math.radians(lat), math.radians(lng); rho = A * FF * _t(p) ** N; th = N * (l - L0)
    return FE + rho * math.sin(th), RHO0 - rho * math.cos(th)
def inv(x, y):
    x -= FE; rho = math.copysign(math.hypot(x, RHO0 - y), N); th = math.atan2(x, RHO0 - y); t = (rho / (A * FF)) ** (1 / N); p = math.pi / 2 - 2 * math.atan(t)
    for _ in range(8): s = math.sin(p); p = math.pi / 2 - 2 * math.atan(t * ((1 - E * s) / (1 + E * s)) ** (E / 2))
    return math.degrees(p), math.degrees(th / N + L0)
OX, OY = fwd(LAT0, LNG0); W = math.sqrt(3) * R
def centro(q, r): return OX + W * (q + r / 2), OY + 1.5 * R * r
VERT = [(R * math.cos(math.radians(60 * k - 30)), R * math.sin(math.radians(60 * k - 30))) for k in range(6)]
def hexagono(q, r): cx, cy = centro(q, r); return [(cx + dx, cy + dy) for dx, dy in VERT]   # antihorario

def area_f(ring): return sum(ring[i][0] * ring[(i + 1) % len(ring)][1] - ring[(i + 1) % len(ring)][0] * ring[i][1] for i in range(len(ring))) / 2
def recorta(sujeto, clip):   # Sutherland–Hodgman
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

def num(x):
    try: return float(x)
    except Exception: return None
# (clave, nombre, signo, numerador, denominador | None si ya es un promedio, columna de peso)
VARS = [
 ('gp', 'Grado promedio de escolaridad (años)', 1, 'GRAPROES', None, 'P_15YMAS'),
 ('pb', 'Población de 18 años y más con educación posbásica (%)', 1, 'P18YM_PB', 'P_18YMAS', 'P_18YMAS'),
 ('an', 'Población de 15 años y más analfabeta (%)', -1, 'P15YM_AN', 'P_15YMAS', 'P_15YMAS'),
 ('ss', 'Población con seguridad social, IMSS o ISSSTE (%)', 1, 'PDER_SS', 'POBTOT', 'POBTOT'),
 ('auto', 'Viviendas con automóvil (%)', 1, 'VPH_AUTOM', 'VIVPAR_HAB', 'VIVPAR_HAB'),
 ('inter', 'Viviendas con internet (%)', 1, 'VPH_INTER', 'VIVPAR_HAB', 'VIVPAR_HAB'),
 ('pc', 'Viviendas con computadora (%)', 1, 'VPH_PC', 'VIVPAR_HAB', 'VIVPAR_HAB'),
 ('stvp', 'Viviendas con televisión de paga (%)', 1, 'VPH_STVP', 'VIVPAR_HAB', 'VIVPAR_HAB'),
 ('lav', 'Viviendas con lavadora (%)', 1, 'VPH_LAVAD', 'VIVPAR_HAB', 'VIVPAR_HAB'),
 ('mic', 'Viviendas con horno de microondas (%)', 1, 'VPH_HMICRO', 'VIVPAR_HAB', 'VIVPAR_HAB'),
 ('c3', 'Viviendas con 3 o más cuartos (%)', 1, 'VPH_3YMASC', 'VIVPAR_HAB', 'VIVPAR_HAB'),
 ('oc', 'Ocupantes por cuarto (hacinamiento)', -1, 'PRO_OCUP_C', None, 'VIVPAR_HAB'),
 ('pt', 'Viviendas con piso de tierra (%)', -1, 'VPH_PISOTI', 'VIVPAR_HAB', 'VIVPAR_HAB'),
]
COLS = sorted({c for v in VARS for c in (v[3], v[4], v[5]) if c} | {'TVIVHAB', 'VIVPAR_HAB', 'POBTOT'} | set(ING.COLS_ING))

def lee_censo(ent, trabajo, csv_zip=None):
    """Devuelve {cvegeo(16): {col: float|None}} de las manzanas del CSV del Censo 2020."""
    d = os.path.join(trabajo, ent); os.makedirs(d, exist_ok=True)
    cz = csv_zip or baja(CENSO % ent, f"{d}/censo.zip")
    out = {}; tot = {}; AG = {}; LP = {}
    with zipfile.ZipFile(cz) as z:
        nom = next(n for n in z.namelist() if n.lower().endswith(".csv") and "/conjunto_de_datos/" in n.lower() and "bitacora" not in n.lower())
        with z.open(nom) as f:
            for x in csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig", errors="replace", newline="")):
                if x.get("LOC") == "0000" and x.get("AGEB") == "0000" and x.get("MZA") == "000":   # total del municipio (urbano + rural)
                    v = num(x.get("POBTOT"))
                    if v: tot[x["ENTIDAD"].zfill(2) + x["MUN"].zfill(3)] = v
                if x.get("MZA") == "000" and x.get("LOC") != "0000":   # AGEB (o localidad si AGEB = 0000): se guardan para el ingreso
                    if x.get("AGEB") == "0000": LP[x["ENTIDAD"].zfill(2) + x["MUN"].zfill(3) + x["LOC"].zfill(4)] = num(x.get("POBTOT")) or 0
                    else: AG[x["ENTIDAD"].zfill(2) + x["MUN"].zfill(3) + x["LOC"].zfill(4) + x["AGEB"]] = {c: num(x.get(c)) for c in COLS}
                if x.get("MZA", "000") in ("000", ""): continue
                out[x["ENTIDAD"].zfill(2) + x["MUN"].zfill(3) + x["LOC"].zfill(4) + x["AGEB"] + x["MZA"].zfill(3)] = {c: num(x.get(c)) for c in COLS}
    return out, tot, AG, LP

def manzanas(ent, sal, censo_local):
    """Itera (cve_mun, manzana) desde censo/mun/<ent>/*.json (local o Cloud Storage)."""
    if censo_local:
        for p in sorted(glob.glob(os.path.join(censo_local, "censo", "mun", ent, "*.json"))):
            for m in json.load(open(p))["mz"]: yield os.path.basename(p)[:-5], m
    else:
        for b in sal.b.list_blobs(prefix=f"censo/mun/{ent}/"):
            if not b.name.endswith(".json"): continue
            for m in json.loads(b.download_as_bytes())["mz"]: yield b.name.split("/")[-1][:-5], m

def carga_eic():
    """Población municipal 2025 (Encuesta Intercensal 2025, viviendas particulares habitadas): eic2025_municipal.json junto al script ({'05030': {'n':'Saltillo','p':976477}, …})."""
    return json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "eic2025_municipal.json")))

def reniveliza(ent, sal):
    """Segunda pasada: pone el nivel (quintiles de hogares del país, ingreso_calibracion.json) a manzanas, AGEB y hexágonos ya calculados."""
    idx = json.loads(sal.b.blob(f"hex/{ent}/index.json").download_as_bytes()); n = 0
    for c in idx["celdas"]:
        b = sal.b.blob(f"hex/{ent}/{c}.json"); d = json.loads(b.download_as_bytes())
        for g in d.get("ing", []):
            if g: g[0] = round(g[0] * ING.CAL['C_post']); g[2] = round(g[2] * ING.CAL['C_post']); g[1] = ING.nivel(g[0])
        sal.pon(f"hex/{ent}/{c}.json", d); n += 1
    for b in sal.b.list_blobs(prefix=f"ingreso/mun/{ent}/"):
        if not b.name.endswith(".json"): continue
        d = json.loads(b.download_as_bytes())
        for x in d["mz"]: x[1] = round(x[1] * ING.CAL['C_post']); x[4] = round(x[4] * ING.CAL['C_post']); x[2] = ING.nivel(x[1])
        sal.pon(b.name, d)
    d = json.loads(sal.b.blob(f"ingreso/ageb/{ent}.json").download_as_bytes())
    for v in d["ageb"].values(): v[0] = round(v[0] * ING.CAL['C_post']); v[3] = round(v[3] * ING.CAL['C_post']); v[1] = ING.nivel(v[0])
    sal.pon(f"ingreso/ageb/{ent}.json", d); log(ent, "niveles de ingreso asignados en", n, "celdas")

def ing_manzana(cve, r, AG, LP, AGC, ent):
    """(media, mediana) mensual del hogar en la manzana: microsimulación del AGEB (con caché) y desviación propia de la manzana."""
    k = cve[:13]; tm = ING.tam_loc(LP.get(cve[:9], 0)); ra = AG.get(k)
    if k not in AGC: AGC[k] = ING.ingreso_ageb(ra, ent, tm) if ra else None
    return ING.ingreso_mz(r, ra, AGC[k], ent, tm)

def calcula(ent, sal, trabajo, censo_local, csv_zip):
    t0 = time.time(); C, TOT, AG, LP = lee_censo(ent, trabajo, csv_zip); EIC = carga_eic(); log(ent, "censo CSV:", len(C), "manzanas · EIC 2025:", sum(1 for c in EIC if c[:2] == ent), "municipios")
    FAC = {cm: EIC[cm]['p'] / TOT[cm] for cm in TOT if cm in EIC and TOT[cm] > 0}
    hp = defaultdict(lambda: [0.0, 0.0]); hing = defaultdict(lambda: [0.0, 0.0, 0.0]); AGC = {}; hm = defaultdict(lambda: defaultdict(float)); S = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0])); VH = defaultdict(float)
    n_mz = 0; sin_csv = 0; pob_tot = 0
    for cm, m in manzanas(ent, sal, censo_local):
        cve, lat, lng, poly, _a, pt = m; r = C.get(cve)
        if r is None: sin_csv += 1; continue
        if not pt or len(poly) < 6: continue
        cx, cy = fwd(lat, lng); ring = [(cx + poly[i] / 10.0, cy + poly[i + 1] / 10.0) for i in range(0, len(poly), 2)]
        A_m = area_f(ring)
        if abs(A_m) < 1e-6: continue
        xs = [p[0] for p in ring]; ys = [p[1] for p in ring]
        r_lo, r_hi = math.floor((min(ys) - OY - R) / (1.5 * R)), math.ceil((max(ys) - OY + R) / (1.5 * R)); partes = []
        for rr in range(r_lo, r_hi + 1):
            q_lo, q_hi = math.floor((min(xs) - OX - R) / W - rr / 2), math.ceil((max(xs) - OX + R) / W - rr / 2)
            for qq in range(q_lo, q_hi + 1):
                cl = recorta(ring, hexagono(qq, rr))
                if len(cl) >= 3:
                    a = abs(area_f(cl))
                    if a > 1e-6: partes.append(((qq, rr), a))
        tot = sum(a for _, a in partes) or 1.0; viv = r.get('TVIVHAB') or 0.0; vh = r.get('VIVPAR_HAB')
        n_mz += 1; pob_tot += pt
        ing_mz = ing_manzana(cve, r, AG, LP, AGC, ent)
        for k, a in partes:
            f = a / tot; hp[k][0] += pt * f; hp[k][1] += viv * f; hm[k][cm] += pt * f
            if vh: VH[k] += f * vh
            if ing_mz is not None and vh: hing[k][0] += f * vh * ing_mz[1]; hing[k][1] += f * vh * ing_mz[0]; hing[k][2] += f * vh
            for key, nom, sg, nu, de, pesoc in VARS:
                wb = r.get(pesoc)
                if wb is None or wb <= 0: continue
                x = r.get(nu)
                if x is None: continue
                if de is None: val = x
                else:
                    d = r.get(de)
                    if d is None or d <= 0: continue
                    val = 100.0 * x / d
                if key == 'gp' and val <= 0: continue
                s = S[k][key]; s[0] += f * wb * val; s[1] += f * wb
    log(ent, "manzanas con geometría y dato:", n_mz, "· sin CSV:", sin_csv, "· hexágonos:", len(hp), f"· {time.time() - t0:.0f}s")
    llaves = [k for k, (p, v) in hp.items() if p >= 0.5]
    agg = {k: {key: (S[k][key][0] / S[k][key][1] if S[k][key][1] > 0 else None) for key, *_ in VARS} for k in llaves}
    ok = [k for k in llaves if VH[k] >= 3 and all(agg[k][key] is not None for key, *_ in VARS)]
    nse = {}; meta_nse = None
    if len(ok) >= 20:
        ws = {k: VH[k] for k in ok}; Wt = sum(ws.values()); ks = [v[0] for v in VARS]; sg = {v[0]: v[2] for v in VARS}; p = len(ks)
        mu = {c: sum(ws[k] * agg[k][c] for k in ok) / Wt for c in ks}
        sd = {c: math.sqrt(sum(ws[k] * (agg[k][c] - mu[c]) ** 2 for k in ok) / Wt) or 1 for c in ks}
        Z = {k: [(agg[k][c] - mu[c]) / sd[c] for c in ks] for k in ok}
        Cv = [[sum(ws[k] * Z[k][a] * Z[k][b] for k in ok) / Wt for b in range(p)] for a in range(p)]; v = [1.0] * p
        for _ in range(300):
            w = [sum(Cv[a][b] * v[b] for b in range(p)) for a in range(p)]; nn = math.sqrt(sum(x * x for x in w)) or 1; v = [x / nn for x in w]
        lam = sum(v[a] * sum(Cv[a][b] * v[b] for b in range(p)) for a in range(p))
        if sum(v[a] * sg[ks[a]] for a in range(p)) < 0: v = [-x for x in v]
        score = {k: sum(v[a] * Z[k][a] for a in range(p)) for k in ok}
        m_ = sum(ws[k] * score[k] for k in ok) / Wt; s_ = math.sqrt(sum(ws[k] * (score[k] - m_) ** 2 for k in ok) / Wt) or 1
        for k in ok: score[k] = (score[k] - m_) / s_
        lo, hi = min(score.values()), max(score.values()); NB = 60; fr = [0.0] * NB
        for k in ok: fr[min(NB - 1, int((score[k] - lo) / (hi - lo) * NB))] += ws[k]
        cs = []; a = 0
        for x in fr: a += math.sqrt(x); cs.append(a)
        cuts = []
        for q in (1, 2, 3):
            tq = cs[-1] * q / 4; j = next(j for j, c in enumerate(cs) if c >= tq); cuts.append(round(lo + (j + 1) * (hi - lo) / NB, 3))
        niv = {1: [0, 0.0, 0.0], 2: [0, 0.0, 0.0], 3: [0, 0.0, 0.0], 4: [0, 0.0, 0.0]}
        for k in ok:
            n = 1 + sum(score[k] >= c for c in cuts); o = agg[k]; niv[n][0] += 1; niv[n][1] += hp[k][0]; niv[n][2] += hp[k][1]
            nse[k] = [round(score[k], 2), n, round(o['gp'], 1), round(o['auto'], 1), round(o['inter'], 1), round(o['pc'], 1), round(o['oc'], 2), round(o['pb'], 1), round(o['ss'], 1), round(o['pt'], 1)]
        ptot = sum(x[1] for x in niv.values()) or 1; NOM = {1: 'Bajo', 2: 'Medio bajo', 3: 'Medio alto', 4: 'Alto'}
        meta_nse = {'fuente': 'INEGI · Censo de Población y Vivienda 2020, Principales resultados por AGEB y manzana urbana (' + NOMBRES[ent][3:] + ')', 'metodo': 'Primer componente principal de 13 rasgos de vivienda, bienes, escolaridad y seguridad social, ponderado por hogares; estratos por Dalenius y Hodges (4 niveles)', 'varianza_explicada': round(lam / p, 3),
                    'variables': [{'k': c, 'n': nom, 'signo': sgn, 'carga': round(v[j], 3), 'media': round(mu[c], 2), 'sd': round(sd[c], 2)} for j, (c, nom, sgn, *_r) in enumerate(VARS)], 'cortes': cuts,
                    'niveles': [{'n': n, 'nombre': NOM[n], 'hex': niv[n][0], 'pob': round(niv[n][1]), 'pct_pob': round(100 * niv[n][1] / ptot, 1), 'viv': round(niv[n][2])} for n in (1, 2, 3, 4)], 'hexagonos_clasificados': len(ok), 'hexagonos_sin_dato': len(llaves) - len(ok),
                    'campos': ['indice', 'nivel', 'escolaridad', 'auto', 'internet', 'computadora', 'ocupantes_cuarto', 'posbasica', 'seguridad_social', 'piso_tierra'],
                    'nota': 'El índice es relativo a la entidad (no es una escala nacional ni la clasificación comercial AMAI).'}
    # tiles de 0.2°
    tiles = defaultdict(lambda: ([], [], []))
    for k in llaves:
        la, ln = inv(*centro(*k)); mun = max(hm[k].items(), key=lambda kv: kv[1])[0][2:]
        t = tiles[(math.floor(la / CELDA), math.floor(ln / CELDA))]; p25 = sum(pm * FAC.get(cm, 1.0) for cm, pm in hm[k].items()); t[0].append([k[0], k[1], round(la, 6), round(ln, 6), round(hp[k][0], 1), round(hp[k][1], 1), mun, round(p25, 1)]); t[1].append(nse.get(k)); ig = hing.get(k); t[2].append([round(ig[0] / ig[2]), ING.nivel(ig[0] / ig[2]), round(ig[1] / ig[2])] if ig and ig[2] > 0 else None)
    celdas = []
    for (i, j), (hx, ns, ig) in tiles.items():
        sal.pon(f"hex/{ent}/{i}_{j}.json", {"c": [i, j], "hex": hx, "nse": ns, "ing": ig}); celdas.append(f"{i}_{j}")
    idx = {'ent': ent, 'nombre': NOMBRES[ent][3:], 'ancla': [LAT0, LNG0], 'radio_m': R, 'celda_grados': CELDA, 'celdas': sorted(celdas), 'hexagonos': len(llaves), 'pob_hexagonos': round(sum(hp[k][0] for k in llaves)), 'pob_manzanas': pob_tot, 'manzanas': n_mz, 'nse': meta_nse,
           'fuente': 'INEGI · Censo de Población y Vivienda 2020 (manzanas urbanas) + Marco Geoestadístico', 'metodo': 'interpolación areal que conserva la población (reparto proporcional al área de intersección manzana-hexágono)', 'nota_2025': 'p25 = p20 × (población municipal EIC 2025 en viviendas particulares / población total municipal del Censo 2020); estimación, no dato de manzana', 'municipios_eic2025': sum(1 for cm in TOT if cm in EIC), 'pob_hexagonos_2025': round(sum(sum(pm * FAC.get(cm, 1.0) for cm, pm in hm[k].items()) for k in llaves)),
           'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'segundos': round(time.time() - t0)}
    # ingreso por manzana (un archivo por municipio) y por AGEB (uno por estado); [mediana, media] mensual del hogar
    porMun = defaultdict(list); n_ing = 0; hist = defaultdict(float)
    for cve, r in C.items():
        i_ = ing_manzana(cve, r, AG, LP, AGC, ent)
        if i_ is None: continue
        vh = int(r.get('VIVPAR_HAB') or 0); porMun[cve[:5]].append([cve, round(i_[1]), ING.nivel(i_[1]), vh, round(i_[0])]); n_ing += 1; hist[round(math.log(max(i_[1], 1)) / 0.02)] += vh
    for cm, lst in porMun.items(): sal.pon(f"ingreso/mun/{ent}/{cm}.json", {"campos": ["cvegeo", "ingreso_mediana", "nivel", "hogares", "ingreso_media"], "mz": lst})
    ag = {}
    for k, r in AG.items():
        i_ = AGC.get(k) if k in AGC else ING.ingreso_ageb(r, ent, ING.tam_loc(LP.get(k[:9], 0)))
        if i_: ag[k] = [round(i_[1]), ING.nivel(i_[1]), int(r.get('VIVPAR_HAB') or 0), round(i_[0])]
    sal.pon(f"ingreso/ageb/{ent}.json", {"campos": ["ingreso_mediana", "nivel", "hogares", "ingreso_media"], "ageb": ag})
    idx['ingreso'] = {'manzanas': n_ing, 'agebs': len(ag), 'modelo_r2': ING.M['r2'], 'modelo_r2_cv': ING.M['r2_validacion_cruzada'], 'hogares': sum(hist.values()), 'hist': {str(k): v for k, v in hist.items()}}
    sal.pon(f"hex/{ent}/index.json", idx); log(ent, "LISTO:", len(llaves), "hexágonos,", len(celdas), "celdas,", len(nse), "con NSE,", idx['segundos'], "s")

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--estados", default=",".join(NOMBRES)); ap.add_argument("--local"); ap.add_argument("--censo-local"); ap.add_argument("--csv"); ap.add_argument("--bucket", default="check-in-493804-panel"); ap.add_argument("--forzar", action="store_true"); ap.add_argument("--reniveliza", action="store_true"); ap.add_argument("--trabajo", default="/tmp/hx")
    a = ap.parse_args(); sal = Salida(a.local, a.bucket); fallas = []
    if a.censo_local and not a.local: sys.exit("--censo-local requiere --local")
    if not sal.local and not hasattr(sal, "b"): sal.b = None
    if a.local and not a.censo_local and not a.reniveliza:
        from google.cloud import storage; sal.b = storage.Client().bucket(a.bucket)
    ti, tn = int(os.environ.get("CLOUD_RUN_TASK_INDEX", 0)), int(os.environ.get("CLOUD_RUN_TASK_COUNT", 1))
    for ent in [e.strip().zfill(2) for e in a.estados.split(",") if e.strip()][ti::tn]:
        try:
            if a.reniveliza: reniveliza(ent, sal); continue
            if not a.forzar and sal.existe(f"hex/{ent}/index.json"): log(ent, "ya está hecho, se salta"); continue
            calcula(ent, sal, a.trabajo, a.censo_local, a.csv); shutil.rmtree(os.path.join(a.trabajo, ent), ignore_errors=True)
        except Exception as e:
            import traceback; traceback.print_exc(); log(ent, "FALLÓ:", repr(e)[:300]); fallas.append(ent)
    log("terminado. Fallas:", fallas or "ninguna"); sys.exit(1 if fallas else 0)
