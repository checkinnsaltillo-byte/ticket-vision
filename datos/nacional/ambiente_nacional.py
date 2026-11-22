#!/usr/bin/env python3
"""Malla nacional · relieve y clima por AGEB urbana de todo México → ambiente/<ent>.json

Relieve: mosaicos Terrarium (AWS Terrain Tiles, nivel 11, ≈ 70 m por píxel) muestreados en el centro de cada AGEB y en dos anillos de 8 puntos a 500 m y 1 000 m.
Clima: WorldClim 2.1 a 5 minutos de arco (normales 1970-2000), ya recortado a México en ambiente/clima.json (temperatura, precipitación, viento y radiación solar).
Por AGEB: [altitud m, pendiente media % (a ≤ 500 m), desnivel m (máximo − mínimo a ≤ 1 km), temperatura media anual °C, precipitación anual mm, viento m/s, radiación kJ/m²/día].
Reanudable (--forzar rehace). Uso: python3 -I ambiente_nacional.py [--estados 06] [--local CARPETA --datos-local CARPETA] [--forzar]
"""
import argparse, io, json, math, os, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nacional import log, NOMBRES, Salida

BUCKET = "check-in-493804-panel"; Z = 11; URL = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/%d/%d/%d.png"
DATOS = None; TILES = {}


def lee(sal, ruta):
    if DATOS:
        p = os.path.join(DATOS, ruta); return json.load(open(p)) if os.path.exists(p) else None
    b = sal.b.blob(ruta); return json.loads(b.download_as_bytes()) if b.exists() else None

def tile(x, y):
    k = (x, y)
    if k in TILES: return TILES[k]
    a = None
    for i in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(URL % (Z, x, y), headers={"User-Agent": "Mozilla/5.0 (compatible; data-fetch)"}), timeout=60) as r:
                im = np.array(Image.open(io.BytesIO(r.read())).convert("RGB")).astype(np.float32); a = im[..., 0] * 256 + im[..., 1] + im[..., 2] / 256 - 32768; break
        except Exception: time.sleep(2 * (i + 1))
    TILES[k] = a; return a

def xy(lat, lng):
    n = 2 ** Z; x = (lng + 180) / 360 * n; la = np.radians(lat); y = (1 - np.log(np.tan(la) + 1 / np.cos(la)) / math.pi) / 2 * n; return x, y

def elev(lat, lng):
    """elevación (m) en puntos (arreglos); NaN donde no hay mosaico"""
    x, y = xy(lat, lng); tx = np.floor(x).astype(int); ty = np.floor(y).astype(int); px = np.clip(((x - tx) * 256).astype(int), 0, 255); py = np.clip(((y - ty) * 256).astype(int), 0, 255); out = np.full(len(lat), np.nan)
    for k in set(zip(tx.tolist(), ty.tolist())):
        t = TILES.get(k)
        if t is None: continue
        m = (tx == k[0]) & (ty == k[1]); out[m] = t[py[m], px[m]]
    return out

def clima(C, lat, lng):
    G = C["paso"]; i = (C["lat1"] - lat) / G - .5; j = (lng - C["lon0"]) / G - .5; i0 = int(math.floor(i)); j0 = int(math.floor(j)); fi = i - i0; fj = j - j0; res = []
    for k in ("tem", "llu", "vie", "rad"):
        g = C[k]; num = den = 0.0
        for di, dj, w in ((0, 0, (1 - fi) * (1 - fj)), (0, 1, (1 - fi) * fj), (1, 0, fi * (1 - fj)), (1, 1, fi * fj)):
            a, b = i0 + di, j0 + dj
            if 0 <= a < C["filas"] and 0 <= b < C["cols"] and g[a][b] is not None: num += w * g[a][b]; den += w
        res.append(round(num / den, 1) if den > 0 else None)
    return res


def calcula(ent, sal, C):
    t0 = time.time(); A = lee(sal, f"ageb/{ent}.json")
    if not A: raise RuntimeError("falta ageb/" + ent)
    ks = [k for k, r in A["ageb"].items() if r[0] is not None]; la = np.array([A["ageb"][k][0] for k in ks]); lo = np.array([A["ageb"][k][1] for k in ks]); n = len(ks)
    ang = np.radians(np.arange(8) * 45.0); LA = [la]; LO = [lo]
    for R in (500.0, 1000.0):
        for a in ang: LA.append(la + R * np.cos(a) / 110540.0); LO.append(lo + R * np.sin(a) / (111320.0 * np.cos(np.radians(la))))
    LA = np.stack(LA); LO = np.stack(LO)   # 17 × n
    x, y = xy(LA.ravel(), LO.ravel()); need = set(zip(np.floor(x).astype(int).tolist(), np.floor(y).astype(int).tolist())); need = [k for k in need if k not in TILES]
    with ThreadPoolExecutor(8) as ex: list(ex.map(lambda k: tile(*k), need))
    log(ent, "AGEB:", n, "· mosaicos:", len(need))
    E = elev(LA.ravel(), LO.ravel()).reshape(17, n); alt = E[0]; r1 = E[1:9]; pend = np.nanmean(np.abs(r1 - alt) / 500.0 * 100, axis=0); desn = np.nanmax(E, axis=0) - np.nanmin(E, axis=0)
    out = {}; nan = lambda v, d=0: None if v is None or not np.isfinite(v) else round(float(v), d)
    for i, k in enumerate(ks): out[k] = [nan(alt[i]), nan(pend[i], 1), nan(desn[i]), *clima(C, float(la[i]), float(lo[i]))]
    meta = {"ent": ent, "nombre": NOMBRES[ent][3:], "agebs": n, "campos": ["alt", "pend", "desn", "tem", "llu", "vie", "rad"],
            "fuente": "Relieve: Terrain Tiles Terrarium (nivel 11, ≈ 70 m; SRTM y otras fuentes abiertas) · Clima: WorldClim 2.1 a 5 minutos de arco, normales 1970-2000",
            "notas": ["alt = altitud del centro del AGEB; pend = pendiente media entre el centro y 8 puntos a 500 m; desn = máximo menos mínimo de 17 puntos a ≤ 1 km.", "El clima tiene resolución de ≈ 9 km: todas las AGEB de una ciudad chica comparten casi el mismo valor."],
            "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "segundos": round(time.time() - t0)}
    TILES.clear(); b = sal.pon(f"ambiente/{ent}.json", {"meta": meta, "ageb": out}); log(ent, "LISTO:", n, "AGEB,", round(b / 1e6, 2), "MB,", meta["segundos"], "s")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--estados", default=",".join(NOMBRES)); ap.add_argument("--local"); ap.add_argument("--datos-local"); ap.add_argument("--bucket", default=BUCKET); ap.add_argument("--forzar", action="store_true")
    a = ap.parse_args(); sal = Salida(a.local, a.bucket); fallas = []
    if a.datos_local:
        if not a.local: sys.exit("--datos-local requiere --local")
        DATOS = a.datos_local
    else:
        from google.cloud import storage
        sal.b = storage.Client().bucket(a.bucket)
    C = lee(sal, "ambiente/clima.json")
    if not C: sys.exit("falta ambiente/clima.json")
    ti, tn = int(os.environ.get("CLOUD_RUN_TASK_INDEX", 0)), int(os.environ.get("CLOUD_RUN_TASK_COUNT", 1))
    for ent in [e.strip().zfill(2) for e in a.estados.split(",") if e.strip()][ti::tn]:
        try:
            if not a.forzar and sal.existe(f"ambiente/{ent}.json"): log(ent, "ya está hecho, se salta"); continue
            calcula(ent, sal, C)
        except Exception as e:
            import traceback; traceback.print_exc(); log(ent, "FALLÓ:", repr(e)[:300]); fallas.append(ent)
    log("terminado. Fallas:", fallas or "ninguna"); sys.exit(1 if fallas else 0)
