#!/usr/bin/env python3
"""Alturas de edificios GHSL (GHS-BUILT-H R2023A, altura media neta, 100 m) de todo México → ghsl/nac/<i>_<j>.bin.gz

Baja los mosaicos Mollweide de 1000 km que cubren México y los reproyecta a cuadros de 1° x 1° con celdas de 0.001° (1000 x 1000 bytes, 1 byte = 0.25 m,
fila 0 = norte; i = piso(lat), j = piso(lng)). Los cuadros sin edificios no se escriben. Índice: ghsl/nac/index.json.
Uso: python3 -I ghsl_nacional.py [--local CARPETA]
"""
import gzip, io, json, math, os, sys, time, urllib.request, zipfile, datetime
import numpy as np
from PIL import Image
Image.MAX_IMAGE_PIXELS = None

BUCKET = os.environ.get("BUCKET", "check-in-493804-panel")
URL = "https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_BUILT_H_GLOBE_R2023A/GHS_BUILT_H_ANBH_E2018_GLOBE_R2023A_54009_100/V1-0/tiles/GHS_BUILT_H_ANBH_E2018_GLOBE_R2023A_54009_100_V1_0_R%d_C%d.zip"
LA0, LA1, LO0, LO1 = map(int, os.environ.get('GHSL_CAJA', '14,34,-119,-85').split(','))
S = 0.001; R = 6378137.0
LOCAL = sys.argv[sys.argv.index("--local") + 1] if "--local" in sys.argv else None


def log(*a): print(time.strftime("%H:%M:%S"), *a, flush=True)
def baja(url):
    for i in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "checkinn-geometrika/1.0"}), timeout=300) as r: return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404: return None
            log("  reintento", i + 1, e)
        except Exception as e: log("  reintento", i + 1, e)
        time.sleep(8 * (i + 1))
    raise RuntimeError("no se pudo bajar " + url)


def main():
    mos = {}   # (fila, columna) → matriz uint8 (0.25 m)
    for r in range(4, 10):
        for c in range(6, 13):
            if os.environ.get('GHSL_SOLO') and (r, c) != tuple(map(int, os.environ['GHSL_SOLO'].split(','))): continue
            z = baja(URL % (r, c))
            if z is None: continue
            with zipfile.ZipFile(io.BytesIO(z)) as zf:
                tif = next(n for n in zf.namelist() if n.lower().endswith(".tif"))
                a = np.array(Image.open(io.BytesIO(zf.read(tif)))).astype(np.float32)
            a[a < 0] = 0; mos[(r, c)] = np.clip(np.round(a / 0.25), 0, 255).astype(np.uint8); log("mosaico R%d C%d" % (r, c), a.shape, "edificada:", int((a > 0).sum())); del a
    if LOCAL is None:
        from google.cloud import storage
        b = storage.Client().bucket(BUCKET)
    tiles = []; n = 0
    for i in range(LA0, LA1):
        for j in range(LO0, LO1):
            lat = (i + 1) - (np.arange(1000) + .5) * S; lon = j + (np.arange(1000) + .5) * S
            LA, LO = np.meshgrid(lat, lon, indexing="ij"); phi = np.radians(LA); th = phi.copy()
            for _ in range(40): th -= (2 * th + np.sin(2 * th) - math.pi * np.sin(phi)) / (2 + 2 * np.cos(2 * th) + 1e-12)
            x = R * 2 * math.sqrt(2) / math.pi * np.radians(LO) * np.cos(th); y = R * math.sqrt(2) * np.sin(th)
            tr = np.floor((9000000 - y) / 1e6).astype(int) + 1; tc = np.floor((x + 18041000) / 1e6).astype(int) + 1
            out = np.zeros((1000, 1000), np.uint8)
            for (r, c), m in mos.items():
                k = (tr == r) & (tc == c)
                if not k.any(): continue
                cc = np.floor((x[k] - (-18041000 + (c - 1) * 1e6)) / 100).astype(int); rr = np.floor(((9000000 - (r - 1) * 1e6) - y[k]) / 100).astype(int)
                ok = (cc >= 0) & (cc < m.shape[1]) & (rr >= 0) & (rr < m.shape[0]); v = np.zeros(cc.shape, np.uint8); v[ok] = m[rr[ok], cc[ok]]; out[k] = v
            if not out.any(): continue
            datos = gzip.compress(out.tobytes(), 9); ruta = f"ghsl/nac/{i}_{j}.bin.gz"
            if LOCAL: os.makedirs(os.path.join(LOCAL, "ghsl/nac"), exist_ok=True); open(os.path.join(LOCAL, ruta), "wb").write(datos)
            else: b.blob(ruta).upload_from_string(datos, content_type="application/gzip")
            tiles.append(f"{i}_{j}"); n += int((out > 0).sum())
        log("fila de latitud", i, "· cuadros con edificios hasta ahora:", len(tiles))
    idx = {"at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "s": S, "n": 1000, "u": 0.25, "tiles": tiles, "fuente": "GHSL GHS-BUILT-H R2023A (JRC)"}
    if LOCAL: open(os.path.join(LOCAL, "ghsl/nac/index.json"), "w").write(json.dumps(idx))
    else: b.blob("ghsl/nac/index.json").upload_from_string(json.dumps(idx).encode(), content_type="application/json")
    log("LISTO:", len(tiles), "cuadros,", n, "celdas con edificios")


if __name__ == "__main__": main()
