#!/usr/bin/env python3
"""Uso del suelo y vegetación (INEGI, Serie VII 1:250 000) y Red Nacional de Caminos (RNC) → indicadores por municipio
→ gs://check-in-493804-panel/inegi-enc/usv_municipal.json  y  rnc_municipal.json

USV: km² de cada clave de uso/vegetación dentro de cada municipio (se intersecta el continuo nacional con el Marco Geoestadístico municipal).
RNC: km de red por municipio, por tipo de vialidad (según el campo de clasificación de la capa).
Requiere pyogrio, shapely, pyproj, numpy (python3 -m venv + pip). Uso: python3 usv_rnc_municipal.py usv|rnc  --usv ZIP --rnc ZIP [--estados 05,19]
"""
import argparse, json, os, sys, time, urllib.request
import numpy as np, shapely, pyogrio
from shapely import STRtree
from pyproj import CRS, Transformer
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nacional import NOMBRES, MG, baja, log

def munis(ent, tmp, crs_dest):
    z = baja(MG + NOMBRES[ent] + ".zip", os.path.join(tmp, "mg_%s.zip" % ent))
    p = "zip://%s!conjunto_de_datos/%smun.shp" % (z, ent)
    m, fi, g, fl = pyogrio.raw.read(p)
    crs0 = CRS.from_user_input(pyogrio.read_info(p)["crs"]); tr = Transformer.from_crs(crs0, crs_dest, always_xy=True)
    geoms = shapely.from_wkb(g); F = dict(zip(m["fields"], fl))
    out = []
    for geo, cve, nom in zip(geoms, F["CVEGEO"], F["NOMGEO"]):
        out.append((cve, nom, shapely.transform(shapely.make_valid(geo), lambda a: np.column_stack(tr.transform(a[:, 0], a[:, 1])))))
    return out

def usv(a):
    src = "zip://%s!conjunto_de_datos/cdv_usuev250sVII_cnal.shp" % a.usv
    crs = CRS.from_user_input(pyogrio.read_info(src)["crs"]); res = {}
    for ent in a.estados:
        t0 = time.time(); M = munis(ent, a.tmp, crs); xs = [m[2].bounds for m in M]
        bb = (min(b[0] for b in xs), min(b[1] for b in xs), max(b[2] for b in xs), max(b[3] for b in xs))
        meta, fi, g, fl = pyogrio.raw.read(src, bbox=bb, columns=["CLAVE", "DESCRIPCIO"])
        P = shapely.make_valid(shapely.from_wkb(g)); FF = dict(zip(meta["fields"], fl)); claves = FF["CLAVE"]
        tree = STRtree(P)
        for cve, nom, mg in M:
            ix = tree.query(mg, predicate="intersects"); ac = {}
            for i in ix:
                ar = shapely.intersection(P[i], mg).area
                if ar > 0: ac[claves[i]] = ac.get(claves[i], 0) + ar
            res[cve] = {"n": nom, "a": {k: round(v / 1e6, 4) for k, v in ac.items()}, "km2": round(mg.area / 1e6, 3)}
        log("USV", ent, len(M), "municipios", round(time.time() - t0), "s")
    return {"fuente": "INEGI · Uso del suelo y vegetación, escala 1:250 000, Serie VII", "claves": {}, "mun": res}

def rnc(a):
    src = "zip://%s!conjunto_de_datos/rnc2025.gpkg" % a.rnc if not os.path.exists(a.rnc.replace(".zip", ".gpkg")) else a.rnc.replace(".zip", ".gpkg")
    crs = CRS.from_user_input(pyogrio.read_info(src, layer="red_vial")["crs"]); M = []
    for ent in a.estados: M += munis(ent, a.tmp, crs)
    G = np.array([m[2] for m in M], dtype=object); tree = STRtree(G); log("RNC", len(M), "municipios")
    res = {m[0]: {"n": m[1], "km": {}, "pav": 0.0, "peaje": 0.0, "carriles": {}} for m in M}; total = pyogrio.read_info(src, layer="red_vial")["features"]; paso = 400000; sin = 0.0
    for ini in range(0, total, paso):
        meta, fi, g, fl = pyogrio.raw.read(src, layer="red_vial", columns=["TIPO_VIAL", "LONGITUD", "COND_PAV", "PEAJE", "CARRILES"], skip_features=ini, max_features=paso)
        F = {n: fl[k] for k, n in enumerate(meta["fields"])}; fl = [F["TIPO_VIAL"], F["LONGITUD"], F["COND_PAV"], F["PEAJE"], F["CARRILES"]]
        L = shapely.from_wkb(g); pts = shapely.line_interpolate_point(L, 0.5, normalized=True)
        pi, mi = tree.query(pts, predicate="within"); asignado = set(pi.tolist())
        for i, j in zip(pi, mi):
            r = res[M[j][0]]; km = (float(fl[1][i]) / 1000.0) if str(fl[1][i]) not in ("N/A", "nan") else 0.0; tv = str(fl[0][i]); r["km"][tv] = round(r["km"].get(tv, 0) + km, 3)
            if str(fl[2][i]).lower().startswith("con pav"): r["pav"] = round(r["pav"] + km, 3)
            if str(fl[3][i]).lower().startswith("s"): r["peaje"] = round(r["peaje"] + km, 3)
        sin += sum((float(fl[1][i]) / 1000.0 if str(fl[1][i]) not in ('N/A', 'nan') else 0.0) for i in range(len(L)) if i not in asignado); log("RNC", min(ini + paso, total), "de", total)
    return {"fuente": "INEGI · Red Nacional de Caminos 2025", "km_sin_municipio": round(sin, 1), "mun": {k: v for k, v in res.items() if v["km"]}}

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("que"); ap.add_argument("--usv"); ap.add_argument("--rnc"); ap.add_argument("--estados", default=",".join(sorted(NOMBRES)))
    ap.add_argument("--tmp", default="/tmp/inegi/mg"); ap.add_argument("--salida", default="/tmp/inegi/mun"); a = ap.parse_args(); a.estados = a.estados.split(",")
    os.makedirs(a.tmp, exist_ok=True); os.makedirs(a.salida, exist_ok=True)
    r = usv(a) if a.que == "usv" else rnc(a)
    json.dump(r, open(os.path.join(a.salida, a.que + "_municipal.json"), "w"), ensure_ascii=False, separators=(",", ":"))
