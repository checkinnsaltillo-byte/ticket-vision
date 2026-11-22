#!/usr/bin/env python3
"""Malla nacional por AGEB urbana: indicadores del Censo 2020 y del DENUE ya calculados para cada AGEB de TODO México → ageb/<ent>.json

Solo datos públicos que ya están cargados (no descarga nada por sitio ni corre análisis): por estado lee
  · el CSV del Censo 2020 «Principales resultados por AGEB y manzana urbana» (el mismo de hex_nacional.py): renglón total de cada AGEB;
  · las manzanas con geometría que dejó nacional.py (censo/mun/<ent>/<entmun>.json): centro, área y para ubicar negocios;
  · el DENUE por municipio que dejó nacional.py (denue/mun/<ent>/<entmun>.json): cada negocio se asigna a la manzana que lo contiene (o a la más cercana a ≤ 150 m) y de ahí a su AGEB.
Por AGEB guarda: centro (lat, lng), municipio, población 2020 y estimación 2025 (factor municipal de la EIC 2025), viviendas habitadas, ocupantes por vivienda,
densidad (habitantes por km² de manzanas), área de manzanas, NSE estatal (índice y nivel 1-4: primer componente principal de 13 rasgos ponderado por viviendas,
cortes de Dalenius-Hodges; relativo a la entidad y calculado entre AGEB, por eso puede diferir un poco del de hexágonos), establecimientos DENUE y diversidad de giros (0-100).
Salida: ageb/<ent>.json = {"meta": {...}, "campos": [...], "ageb": {"<clave de 13>": [...]}}. Reanudable (salta estados ya hechos; --forzar rehace).
Uso: python3 -I ageb_nacional.py [--estados 05,19] [--local CARPETA_SALIDA] [--datos-local CARPETA_CON_censo/mun_y_denue/mun] [--csv RUTA.zip] [--forzar] [--trabajo /tmp/ag]
"""
import argparse, glob, json, math, os, shutil, sys, time
from collections import defaultdict
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nacional import log, NOMBRES, Salida
import hex_nacional as HX

CAMPOS = ["lat", "lng", "mun", "pob_2020", "pob_2025", "viviendas_habitadas", "ocupantes_por_vivienda", "densidad_hab_km2", "area_manzanas_km2", "nse_indice", "nse_nivel", "establecimientos_denue", "diversidad_giros", "manzanas"]
CG = 200.0   # tamaño de la celda del índice espacial de manzanas (m)


def lee_json(prefijo, sal, datos_local):
    """Itera (nombre sin extensión, objeto) de los JSON bajo un prefijo, en disco o en Cloud Storage."""
    if datos_local:
        for p in sorted(glob.glob(os.path.join(datos_local, prefijo, "*.json"))): yield os.path.basename(p)[:-5], json.load(open(p))
    else:
        for b in sal.b.list_blobs(prefix=prefijo + "/"):
            if b.name.endswith(".json"): yield b.name.split("/")[-1][:-5], json.loads(b.download_as_bytes())

def dentro(x, y, ring):
    c = False; n = len(ring); j = n - 1
    for i in range(n):
        xi, yi = ring[i]; xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi: c = not c
        j = i
    return c

def nse_pca(filas):
    """filas: {clave: (peso, {var: valor})} con todas las variables → {clave: (índice, nivel)} y meta. Mismo método que hex_nacional.py, entre AGEB."""
    ok = [k for k, (w, o) in filas.items() if w >= 3 and all(o.get(v[0]) is not None for v in HX.VARS)]
    if len(ok) < 20: return {}, None
    ks = [v[0] for v in HX.VARS]; sg = {v[0]: v[2] for v in HX.VARS}; p = len(ks); ws = {k: filas[k][0] for k in ok}; Wt = sum(ws.values()); ag = {k: filas[k][1] for k in ok}
    mu = {c: sum(ws[k] * ag[k][c] for k in ok) / Wt for c in ks}
    sd = {c: math.sqrt(sum(ws[k] * (ag[k][c] - mu[c]) ** 2 for k in ok) / Wt) or 1 for c in ks}
    Z = {k: [(ag[k][c] - mu[c]) / sd[c] for c in ks] for k in ok}
    Cv = [[sum(ws[k] * Z[k][a] * Z[k][b] for k in ok) / Wt for b in range(p)] for a in range(p)]; v = [1.0] * p
    for _ in range(300):
        w = [sum(Cv[a][b] * v[b] for b in range(p)) for a in range(p)]; nn = math.sqrt(sum(x * x for x in w)) or 1; v = [x / nn for x in w]
    lam = sum(v[a] * sum(Cv[a][b] * v[b] for b in range(p)) for a in range(p))
    if sum(v[a] * sg[ks[a]] for a in range(p)) < 0: v = [-x for x in v]
    sc = {k: sum(v[a] * Z[k][a] for a in range(p)) for k in ok}
    m_ = sum(ws[k] * sc[k] for k in ok) / Wt; s_ = math.sqrt(sum(ws[k] * (sc[k] - m_) ** 2 for k in ok) / Wt) or 1
    for k in ok: sc[k] = (sc[k] - m_) / s_
    lo, hi = min(sc.values()), max(sc.values()); NB = 60; fr = [0.0] * NB
    for k in ok: fr[min(NB - 1, int((sc[k] - lo) / ((hi - lo) or 1) * NB))] += ws[k]
    cs = []; a = 0
    for x in fr: a += math.sqrt(x); cs.append(a)
    cortes = []
    for q in (1, 2, 3):
        tq = cs[-1] * q / 4; j = next(j for j, c in enumerate(cs) if c >= tq); cortes.append(round(lo + (j + 1) * (hi - lo) / NB, 3))
    res = {k: (round(sc[k], 2), 1 + sum(sc[k] >= c for c in cortes)) for k in ok}
    meta = {"metodo": "Primer componente principal de 13 rasgos de vivienda, bienes, escolaridad y seguridad social, ponderado por viviendas; 4 estratos por Dalenius y Hodges. Calculado entre las AGEB urbanas de la entidad.",
            "varianza_explicada": round(lam / p, 3), "cortes": cortes, "variables": [{"k": c, "carga": round(v[j], 3), "media": round(mu[c], 2), "sd": round(sd[c], 2)} for j, c in enumerate(ks)],
            "nota": "El índice es relativo a la entidad (no es una escala nacional ni la clasificación comercial AMAI)."}
    return res, meta


def calcula(ent, sal, trabajo, datos_local, csv_zip):
    t0 = time.time(); _C, TOT, AG, _LP = HX.lee_censo(ent, trabajo, csv_zip); EIC = HX.carga_eic()
    FAC = {cm: EIC[cm]["p"] / TOT[cm] for cm in TOT if cm in EIC and TOT[cm] > 0}; log(ent, "censo CSV:", len(AG), "AGEB urbanas")
    # 1) manzanas: área, centro ponderado por población e índice espacial para ubicar negocios
    geo = defaultdict(lambda: [0.0, 0.0, 0.0, 0.0, 0]); rej = defaultdict(list); n_mz = 0   # AGEB → [área m², Σw·lat, Σw·lng, Σw, manzanas]
    for _cm, d in lee_json(f"censo/mun/{ent}", sal, datos_local):
        for m in d["mz"]:
            cve, lat, lng, poly, _g, pt = m
            if len(poly) < 6: continue
            cx, cy = HX.fwd(lat, lng); ring = [(cx + poly[i] / 10.0, cy + poly[i + 1] / 10.0) for i in range(0, len(poly), 2)]; a = abs(HX.area_f(ring))
            if a < 1e-6: continue
            k = cve[:13]; g = geo[k]; w = max(pt or 0, 1); g[0] += a; g[1] += w * lat; g[2] += w * lng; g[3] += w; g[4] += 1; n_mz += 1
            xs = [q[0] for q in ring]; ys = [q[1] for q in ring]; it = (ring, k, cx, cy)
            for gx in range(int(math.floor(min(xs) / CG)), int(math.floor(max(xs) / CG)) + 1):
                for gy in range(int(math.floor(min(ys) / CG)), int(math.floor(max(ys) / CG)) + 1): rej[(gx, gy)].append(it)
    log(ent, "manzanas con geometría:", n_mz, "en", len(geo), "AGEB")
    # 2) DENUE: cada negocio a la manzana que lo contiene (o la más cercana a ≤ 150 m) y de ahí a su AGEB
    est = defaultdict(lambda: defaultdict(int)); n_den = 0; n_sin = 0; ngr = 10
    for _cm, d in lee_json(f"denue/mun/{ent}", sal, datos_local):
        ngr = max(ngr, len((d.get("meta") or {}).get("grupos") or []))
        for p in d.get("p") or []:
            x, y = HX.fwd(p[0], p[1]); gx, gy = int(math.floor(x / CG)), int(math.floor(y / CG)); k = None; mejor = 150.0 ** 2
            for it in rej.get((gx, gy), ()):
                if dentro(x, y, it[0]): k = it[1]; break
            if k is None:
                for ax in (-1, 0, 1):
                    for ay in (-1, 0, 1):
                        for it in rej.get((gx + ax, gy + ay), ()):
                            dd = (it[2] - x) ** 2 + (it[3] - y) ** 2
                            if dd < mejor: mejor = dd; k = it[1]
            n_den += 1
            if k is None: n_sin += 1; continue
            est[k][int(p[2]) if isinstance(p[2], (int, float)) else 0] += 1
    log(ent, "negocios DENUE:", n_den, "· sin AGEB urbana cercana:", n_sin)
    # 3) NSE entre AGEB
    filas = {}
    for k, r in AG.items():
        # el Censo oculta con «*» los conteos de 1 o 2 casos: en una AGEB con base suficiente se toman como 1.5; si falta VIVPAR_HAB se usa TVIVHAB
        col = lambda c: r.get(c) if r.get(c) is not None else (r.get("TVIVHAB") if c == "VIVPAR_HAB" else None)
        w = col("VIVPAR_HAB") or 0; o = {}
        for key, _nom, _sg, nu, de, pesoc in HX.VARS:
            wb = col(pesoc); x = r.get(nu); val = None
            if wb and wb > 0:
                if de is None: val = x
                else:
                    dv = col(de)
                    if dv and dv > 0:
                        if x is None and dv >= 20: x = 1.5
                        val = 100.0 * x / dv if x is not None else None
            if key == "gp" and val is not None and val <= 0: val = None
            o[key] = val
        filas[k] = (w, o)
    nse, meta_nse = nse_pca(filas)
    # 4) salida
    out = {}; pob_t = 0; con_geo = 0
    for k, r in AG.items():
        pob = r.get("POBTOT") or 0; viv = r.get("TVIVHAB") or 0; vph = r.get("VIVPAR_HAB") or viv; g = geo.get(k)
        if not pob and not g: continue
        mun = k[:5]; f25 = FAC.get(mun); a_km2 = g[0] / 1e6 if g else None; e = est.get(k) or {}; n_e = sum(e.values())
        div = round(-sum(v / n_e * math.log(v / n_e) for v in e.values() if v) / math.log(ngr) * 100) if n_e else None
        ns = nse.get(k); pob_t += pob; con_geo += 1 if g else 0
        out[k] = [round(g[1] / g[3], 6) if g else None, round(g[2] / g[3], 6) if g else None, mun, int(pob), round(pob * f25) if f25 else None, int(viv), round(pob / vph, 2) if vph else None,
                  round(pob / a_km2) if a_km2 and a_km2 > 0 else None, round(a_km2, 4) if a_km2 else None, ns[0] if ns else None, ns[1] if ns else None, n_e, div, g[4] if g else 0]
    meta = {"ent": ent, "nombre": NOMBRES[ent][3:], "agebs": len(out), "con_geometria": con_geo, "pob_2020": int(pob_t), "negocios_denue": n_den, "negocios_sin_ageb": n_sin, "con_nse": len(nse), "nse": meta_nse,
            "fuente": "INEGI · Censo de Población y Vivienda 2020 (principales resultados por AGEB y manzana urbana), Encuesta Intercensal 2025 (factor municipal), DENUE y Marco Geoestadístico",
            "notas": ["Solo AGEB urbanas.", "densidad = población / área sumada de las manzanas de la AGEB (no el polígono de la AGEB).", "centro = promedio de los centros de sus manzanas ponderado por población.",
                      "pob_2025 = pob_2020 × (población municipal EIC 2025 / población municipal Censo 2020): estimación, no dato de AGEB.", "diversidad_giros = entropía de Shannon normalizada de los grupos DENUE × 100.", "Los conteos que el Censo oculta con «*» (1 o 2 casos) se toman como 1.5 para el NSE."],
            "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "segundos": round(time.time() - t0)}
    n = sal.pon(f"ageb/{ent}.json", {"meta": meta, "campos": CAMPOS, "ageb": out}); log(ent, "LISTO:", len(out), "AGEB,", con_geo, "con geometría,", len(nse), "con NSE,", n_den - n_sin, "negocios asignados,", round(n / 1e6, 2), "MB,", meta["segundos"], "s")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--estados", default=",".join(NOMBRES)); ap.add_argument("--local"); ap.add_argument("--datos-local"); ap.add_argument("--csv"); ap.add_argument("--bucket", default="check-in-493804-panel")
    ap.add_argument("--forzar", action="store_true"); ap.add_argument("--trabajo", default="/tmp/ag")
    a = ap.parse_args(); sal = Salida(a.local, a.bucket); fallas = []
    if a.datos_local and not a.local: sys.exit("--datos-local requiere --local")
    if a.local and not a.datos_local:
        from google.cloud import storage; sal.b = storage.Client().bucket(a.bucket)
    ti, tn = int(os.environ.get("CLOUD_RUN_TASK_INDEX", 0)), int(os.environ.get("CLOUD_RUN_TASK_COUNT", 1))
    for ent in [e.strip().zfill(2) for e in a.estados.split(",") if e.strip()][ti::tn]:
        try:
            if not a.forzar and sal.existe(f"ageb/{ent}.json"): log(ent, "ya está hecho, se salta"); continue
            calcula(ent, sal, a.trabajo, a.datos_local, a.csv); shutil.rmtree(os.path.join(a.trabajo, ent), ignore_errors=True)
        except Exception as e:
            import traceback; traceback.print_exc(); log(ent, "FALLÓ:", repr(e)[:300]); fallas.append(ent)
    log("terminado. Fallas:", fallas or "ninguna"); sys.exit(1 if fallas else 0)
