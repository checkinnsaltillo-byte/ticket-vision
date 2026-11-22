#!/usr/bin/env python3
"""Malla nacional · cobertura del suelo por AGEB urbana de todo México → suelo/<ent>.json

ESA WorldCover 2021 (10 m, ya copiado a worldcover/2021/<id>.tif): para cada AGEB se cuenta, dentro de su contorno (envolvente convexa de sus manzanas; si no hay, un círculo de 500 m),
el porcentaje de píxeles de cada clase. Por AGEB guarda 8 enteros (% del área con dato): [arbolado, matorral, pastizal, cultivo, construido, suelo desnudo, agua, humedal o manglar].
Reanudable (--forzar rehace). Uso: python3 -I suelo_nacional.py [--estados 06] [--local CARPETA --datos-local CARPETA] [--forzar]
"""
import argparse, json, math, os, sys, tempfile, time
from collections import defaultdict
import numpy as np
import tifffile
from PIL import Image, ImageDraw
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nacional import log, NOMBRES, Salida

BUCKET = "check-in-493804-panel"; PS = 1 / 12000.0; DATOS = None
CLASES = [(10,), (20,), (30,), (40,), (50,), (60,), (80,), (90, 95)]
NOM = ["Arbolado", "Matorral", "Pastizal", "Cultivo", "Construido", "Suelo desnudo", "Agua", "Humedal o manglar"]


def lee(sal, ruta):
    if DATOS:
        p = os.path.join(DATOS, ruta); return json.load(open(p)) if os.path.exists(p) else None
    b = sal.b.blob(ruta); return json.loads(b.download_as_bytes()) if b.exists() else None

def tesela(sal, tid):
    """arreglo uint8 36000×36000 del mosaico de 3° (o None si no existe)"""
    if DATOS: p = os.path.join(DATOS, "worldcover/2021", tid + ".tif")
    else:
        b = sal.b.blob(f"worldcover/2021/{tid}.tif")
        if not b.exists(): return None
        p = os.path.join(tempfile.gettempdir(), tid + ".tif"); b.download_to_filename(p)
    if not os.path.exists(p): return None
    try: return tifffile.imread(p)
    finally:
        if not DATOS and os.path.exists(p): os.remove(p)

def tid_de(lat, lng): return "N%02dW%03d" % (int(math.floor(lat / 3)) * 3, -int(math.floor(lng / 3)) * 3)

def porcentajes(a, mask):
    v = a[mask]; v = v[v > 0]
    if not len(v): return None
    c = np.bincount(v, minlength=101); n = c.sum(); return [int(round(100.0 * sum(c[k] for k in g) / n)) for g in CLASES]


def calcula(ent, sal):
    t0 = time.time(); A = lee(sal, f"ageb/{ent}.json")
    if not A: raise RuntimeError("falta ageb/" + ent)
    por = defaultdict(list)
    for k, r in A["ageb"].items():
        if r[0] is not None: por[tid_de(r[0], r[1])].append(k)
    out = {}; sin = 0
    for tid, ks in sorted(por.items()):
        a = tesela(sal, tid)
        if a is None: sin += len(ks); log(ent, "sin mosaico", tid, "·", len(ks), "AGEB"); continue
        lat0 = int(tid[1:3]) + 3; lon0 = -int(tid[4:7])
        for k in ks:
            r = A["ageb"][k]; pol = r[14] if len(r) > 14 else None
            if pol and len(pol) >= 6: la = np.array(pol[0::2]); lo = np.array(pol[1::2])
            else:
                dla = 500 / 110540.0; dlo = 500 / (111320.0 * math.cos(math.radians(r[0]))); la = np.array([r[0] - dla, r[0] + dla, r[0] + dla, r[0] - dla]); lo = np.array([r[1] - dlo, r[1] - dlo, r[1] + dlo, r[1] + dlo])
            col = (lo - lon0) / PS; row = (lat0 - la) / PS; c0 = max(0, int(math.floor(col.min()))); c1 = min(a.shape[1], int(math.ceil(col.max())) + 1); r0 = max(0, int(math.floor(row.min()))); r1 = min(a.shape[0], int(math.ceil(row.max())) + 1)
            if c1 <= c0 or r1 <= r0: continue
            st = max(1, int(math.ceil(max(c1 - c0, r1 - r0) / 700.0))); w = a[r0:r1:st, c0:c1:st]; im = Image.new("L", (w.shape[1], w.shape[0]), 0)
            ImageDraw.Draw(im).polygon([((x - c0) / st, (y - r0) / st) for x, y in zip(col, row)], fill=1, outline=1); m = np.array(im, bool)
            res = porcentajes(w, m) if m.any() else None
            if res: out[k] = res
        del a
    meta = {"ent": ent, "nombre": NOMBRES[ent][3:], "agebs": len(A["ageb"]), "con_dato": len(out), "sin_mosaico": sin, "clases": NOM, "fuente": "ESA WorldCover 2021 v200 (10 m) · CC BY 4.0",
            "notas": ["Porcentaje del área del contorno aproximado de la AGEB (envolvente convexa de sus manzanas, no el límite oficial) con cada clase, sobre píxeles con dato.", "En AGEB muy grandes se muestrea un píxel de cada varios para limitar el cálculo."],
            "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "segundos": round(time.time() - t0)}
    n = sal.pon(f"suelo/{ent}.json", {"meta": meta, "ageb": out}); log(ent, "LISTO:", len(out), "AGEB,", round(n / 1e6, 2), "MB,", meta["segundos"], "s")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--estados", default=",".join(NOMBRES)); ap.add_argument("--local"); ap.add_argument("--datos-local"); ap.add_argument("--bucket", default=BUCKET); ap.add_argument("--forzar", action="store_true")
    a = ap.parse_args(); sal = Salida(a.local, a.bucket); fallas = []
    if a.datos_local:
        if not a.local: sys.exit("--datos-local requiere --local")
        DATOS = a.datos_local
    else:
        from google.cloud import storage
        sal.b = storage.Client().bucket(a.bucket)
    ti, tn = int(os.environ.get("CLOUD_RUN_TASK_INDEX", 0)), int(os.environ.get("CLOUD_RUN_TASK_COUNT", 1))
    for ent in [e.strip().zfill(2) for e in a.estados.split(",") if e.strip()][ti::tn]:
        try:
            if not a.forzar and sal.existe(f"suelo/{ent}.json"): log(ent, "ya está hecho, se salta"); continue
            calcula(ent, sal)
        except Exception as e:
            import traceback; traceback.print_exc(); log(ent, "FALLÓ:", repr(e)[:300]); fallas.append(ent)
    log("terminado. Fallas:", fallas or "ninguna"); sys.exit(1 if fallas else 0)
