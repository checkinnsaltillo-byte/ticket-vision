#!/usr/bin/env python3
"""Huellas de edificios de Microsoft (Global ML Building Footprints) de todo México → osm/nac/hue/<i>_<j>.json (cuadros de 0.1°, mismo formato que osm/huellas-*/).

La tarea n de un Cloud Run Job procesa la banda n de longitud (8 bandas): baja los archivos (quadkeys de nivel 9) que tocan su banda y conserva
solo los edificios cuyo centroide cae en un cuadro de su banda. Así ningún cuadro lo escribe más de una tarea.
Uso: python3 -I huellas_nacional.py            (tarea)
     python3 -I huellas_nacional.py --fusiona  (al terminar todas: escribe osm/nac/hue/index.json)
"""
import urllib.request, gzip, json, math, os, collections, sys, time, datetime, io
from concurrent.futures import ThreadPoolExecutor

BUCKET = os.environ.get("BUCKET", "check-in-493804-panel")
NB = 8; LON0, LON1 = -119.0, -85.0; C = 0.1; LA0, LA1 = 14.0, 33.5
ANCHO = (LON1 - LON0) / NB


def log(*a): print(time.strftime("%H:%M:%S"), *a, flush=True)
def enc(pts):
    out = []; la = ln = 0
    def v(d):
        d = ~(d << 1) if d < 0 else d << 1; s = ""
        while d >= 0x20: s += chr((0x20 | (d & 0x1f)) + 63); d >>= 5
        return s + chr(d + 63)
    for a, b in pts:
        ia, ib = round(a * 1e6), round(b * 1e6); out.append(v(ia - la) + v(ib - ln)); la, ln = ia, ib
    return "".join(out)
def qk_bbox(q):   # (lat0, lng0, lat1, lng1) de un quadkey
    x = y = 0; z = len(q)
    for i, ch in enumerate(q):
        d = int(ch); m = 1 << (z - i - 1)
        if d & 1: x |= m
        if d & 2: y |= m
    n = 2 ** z; lng0 = x / n * 360 - 180; lng1 = (x + 1) / n * 360 - 180
    lat = lambda yy: math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * yy / n))))
    return lat(y + 1), lng0, lat(y), lng1
def abre(url, intentos=6):
    for i in range(intentos):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "checkinn-geometrika/1.0"}), timeout=300) as r: return r.read()
        except Exception as e: log("  reintento", i + 1, url[-40:], e); time.sleep(8 * (i + 1))
    raise RuntimeError("no se pudo bajar " + url)


def tarea(n):
    lo = LON0 + n * ANCHO; hi = lo + ANCHO
    suyo = lambda j: lo <= j * C < hi - 1e-9
    txt = abre("https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv").decode()
    ks = []
    for l in txt.split("\n"):
        if l.startswith("Mexico,"):
            c = l.strip().split(","); b = qk_bbox(c[1])
            if b[3] >= lo - .2 and b[1] <= hi + .2 and b[2] >= LA0 and b[0] <= LA1: ks.append((c[1], c[2]))
    log("banda", n, lo, hi, "·", len(ks), "archivos")
    tiles = collections.defaultdict(list); nb = 0; t0 = time.time()
    for q, u in ks:
        data = abre(u)
        for line in gzip.GzipFile(fileobj=io.BytesIO(data)):
            try: j = json.loads(line)
            except Exception: continue
            ring = (j.get("geometry") or {}).get("coordinates", [[]])[0]
            if len(ring) < 4: continue
            pts = [(p[1], p[0]) for p in ring[:-1]]
            ca = sum(a for a, b in pts) / len(pts); co = sum(b for a, b in pts) / len(pts)
            if not (LA0 <= ca <= LA1) or not suyo(math.floor(co / C)): continue
            tiles[f"{math.floor(ca / C)}_{math.floor(co / C)}"].append(enc(pts)); nb += 1
        del data; log("  ", q, "ok · edificios de la banda hasta ahora:", nb, "·", round(time.time() - t0), "s")
    from google.cloud import storage
    b = storage.Client().bucket(BUCKET)
    def sube(ruta, obj): b.blob(ruta).upload_from_string(json.dumps(obj, separators=(",", ":")).encode("utf-8"), content_type="application/json")
    with ThreadPoolExecutor(16) as ex: list(ex.map(lambda kv: sube(f"osm/nac/hue/{kv[0]}.json", {"f": kv[1]}), tiles.items()))
    sube(f"osm/nac/hue/parts/{n}.json", {"at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "tiles": sorted(tiles), "n": nb})
    log("banda", n, "LISTA:", nb, "edificios en", len(tiles), "cuadros ·", round(time.time() - t0), "s")


def fusiona():
    from google.cloud import storage
    b = storage.Client().bucket(BUCKET); P = [json.loads(b.blob(f"osm/nac/hue/parts/{n}.json").download_as_bytes()) for n in range(NB)]
    obj = {"at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "bbox": [LA0, LON0, LA1, LON1], "celda": C, "tiles": sorted({t for p in P for t in p["tiles"]}), "fuente": "Microsoft Global ML Building Footprints (ODbL)", "n": sum(p["n"] for p in P)}
    b.blob("osm/nac/hue/index.json").upload_from_string(json.dumps(obj, separators=(",", ":")).encode("utf-8"), content_type="application/json")
    log("índice de huellas:", len(obj["tiles"]), "cuadros,", obj["n"], "edificios")


if __name__ == "__main__":
    if "--fusiona" in sys.argv: fusiona()
    else: tarea(int(os.environ.get("CLOUD_RUN_TASK_INDEX", 0)))
