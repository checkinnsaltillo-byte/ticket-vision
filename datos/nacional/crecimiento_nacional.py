#!/usr/bin/env python3
"""Crecimiento urbano GHSL (GHS-BUILT-S R2023A, 3 arcseg ≈ 90 m, 12 épocas 1975-2030) de las CIUDADES de México → crecimiento/nac/<cy>_<cx>/E<año>.png

No cubre todo el territorio: solo las celdas de 0.5° (600 x 600 píxeles de la rejilla nativa de GHSL) que tocan la mancha urbana de un municipio con
CREC_POB habitantes o más en zona urbana (índice nacional/estado-<ent>.json, el mismo que usa el servidor). cy y cx son el número de celda contando desde
la esquina de la rejilla global de GHSL (cy = piso(píxel_y / 600), cx = piso(píxel_x / 600)), así que anidan exacto en las teselas de 10° (20 x 20 celdas).
Cada PNG usa la misma codificación que crecimiento/E<año>.png de Saltillo: color = rampa amarillo→café y la fracción edificada va en el canal alfa
(alfa = 110 + 120·min(1, fracción/0.7); transparente si fracción < 1 %). Índice: crecimiento/nac/index.json.
Uso: python3 -I crecimiento_nacional.py [--local CARPETA]   ·   prueba chica: CREC_PRUEBA="lat,lng" CREC_EP="2020"
"""
import io, json, math, os, sys, time, urllib.request, urllib.error, zipfile, datetime
import numpy as np
from PIL import Image
Image.MAX_IMAGE_PIXELS = None

BUCKET = os.environ.get("BUCKET", "check-in-493804-panel")
URL = "https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_BUILT_S_GLOBE_R2023A/GHS_BUILT_S_E%d_GLOBE_R2023A_4326_3ss/V1-0/tiles/GHS_BUILT_S_E%d_GLOBE_R2023A_4326_3ss_V1_0_R%d_C%d.zip"
EP = [int(x) for x in os.environ.get("CREC_EP", "2020,1975,1980,1985,1990,1995,2000,2005,2010,2015,2025,2030").split(",")]   # 2020 primero: decide qué celdas valen la pena
GP = 3 / 3600; GX0 = -180.00791620855503; GY0 = 89.09958342; GT = 12000; PX = 600
POB_MIN = int(os.environ.get("CREC_POB", "50000")); MARGEN = 0.03
LOCAL = sys.argv[sys.argv.index("--local") + 1] if "--local" in sys.argv else None
DIR = "crecimiento/nac/"


def log(*a): print(time.strftime("%H:%M:%S"), *a, flush=True)
def baja(url):
    for i in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; data-fetch)"}), timeout=300) as r: return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404: return None
            log("  reintento", i + 1, e)
        except Exception as e: log("  reintento", i + 1, e)
        time.sleep(8 * (i + 1))
    raise RuntimeError("no se pudo bajar " + url)

def celdas_de(s, w, n, e):
    """celdas (cy, cx) que toca una caja en grados"""
    x0 = int(math.floor((w - GX0) / GP / PX)); x1 = int(math.floor((e - GX0) / GP / PX)); y0 = int(math.floor((GY0 - n) / GP / PX)); y1 = int(math.floor((GY0 - s) / GP / PX))
    return {(cy, cx) for cy in range(y0, y1 + 1) for cx in range(x0, x1 + 1)}

def png_de(v, cy):
    """matriz de m² edificados por píxel → PNG RGBA con la fracción edificada en el alfa"""
    lat = GY0 - (cy * PX + np.arange(PX) + .5) * GP; area = GP * 111320 * np.cos(np.radians(lat)) * GP * 110540
    p = v.astype(np.float32) / area[:, None].astype(np.float32); t = np.clip(p / 0.7, 0, 1); X = [0, .35, .7, 1]
    out = np.zeros((PX, PX, 4), np.uint8)
    out[..., 0] = np.round(np.interp(t, X, [253, 251, 234, 124])); out[..., 1] = np.round(np.interp(t, X, [224, 146, 88, 45])); out[..., 2] = np.round(np.interp(t, X, [71, 60, 12, 18])); out[..., 3] = np.round(110 + 120 * t)
    out[p < 0.01] = 0
    b = io.BytesIO(); Image.fromarray(out, "RGBA").save(b, "PNG", optimize=True); return b.getvalue()


def main():
    cli = None
    if LOCAL is None or not os.environ.get("CREC_PRUEBA"):
        from google.cloud import storage
        cli = storage.Client().bucket(BUCKET)
    def guarda(ruta, datos, ct):
        if LOCAL:
            f = os.path.join(LOCAL, ruta); os.makedirs(os.path.dirname(f), exist_ok=True); open(f, "wb").write(datos)
        else:
            bl = cli.blob(ruta); bl.cache_control = "public, max-age=86400"; bl.upload_from_string(datos, content_type=ct)
    # 1) qué celdas: las que tocan la mancha urbana de los municipios grandes
    C = set(); muns = 0
    if os.environ.get("CREC_PRUEBA"):
        la, lo = map(float, os.environ["CREC_PRUEBA"].split(",")); C = celdas_de(la, lo, la, lo); muns = 1
    else:
        for e in range(1, 33):
            try: d = json.loads(cli.blob("nacional/estado-%02d.json" % e).download_as_bytes())
            except Exception as ex: log("sin índice del estado", e, ex); continue
            for m in (d.get("mun") or {}).values():
                bb = m.get("bbox")
                if bb and (m.get("pob") or 0) >= POB_MIN: C |= celdas_de(bb[0] - MARGEN, bb[1] - MARGEN, bb[2] + MARGEN, bb[3] + MARGEN); muns += 1
    T = {}
    for cy, cx in C: T.setdefault((cy // 20, cx // 20), []).append((cy, cx))
    log("municipios con %d hab. o más: %d · celdas a generar: %d · teselas de GHSL: %d" % (POB_MIN, muns, len(C), len(T)))
    # 2) por tesela y época: bajar, recortar cada celda y guardarla
    hechas = {}   # "cy_cx" → km² edificados en 2020
    for (tr, tc), cel in sorted(T.items()):
        vivas = None
        for ep in EP:
            z = baja(URL % (ep, ep, tr + 1, tc + 1))
            if z is None: log("  sin tesela R%d_C%d para %d" % (tr + 1, tc + 1, ep)); continue
            with zipfile.ZipFile(io.BytesIO(z)) as zf:
                tif = next(n for n in zf.namelist() if n.lower().endswith(".tif")); a = np.array(Image.open(io.BytesIO(zf.read(tif))))
            del z
            if a.shape != (GT, GT): raise RuntimeError("tamaño inesperado %s en R%d_C%d" % (a.shape, tr + 1, tc + 1))
            n = 0
            for cy, cx in cel:
                k = "%d_%d" % (cy, cx)
                if vivas is not None and k not in vivas: continue
                v = a[(cy % 20) * PX:(cy % 20 + 1) * PX, (cx % 20) * PX:(cx % 20 + 1) * PX]; v = np.where((v > 0) & (v < 20000), v, 0)
                if ep == 2020:
                    km2 = float(v.sum()) / 1e6
                    if km2 < 0.5: continue   # celda prácticamente sin construcción (mar, sierra): no se escribe
                    hechas[k] = round(km2, 1)
                guarda("%s%s/E%d.png" % (DIR, k, ep), png_de(v, cy), "image/png"); n += 1
            if ep == 2020: vivas = {"%d_%d" % c for c in cel if "%d_%d" % c in hechas}
            log("R%d_C%d época %d: %d celdas" % (tr + 1, tc + 1, ep, n)); del a
    idx = {"v": 1, "at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "px": PX, "epochs": sorted(EP), "pob_min": POB_MIN, "cells": hechas, "fuente": "GHSL GHS-BUILT-S R2023A (JRC, Comisión Europea) · CC BY 4.0", "cellM": 90, "proy": [2025, 2030]}
    guarda(DIR + "index.json", json.dumps(idx).encode(), "application/json")
    log("LISTO: %d celdas con ciudad, %.0f km² edificados en 2020" % (len(hechas), sum(hechas.values())))


if __name__ == "__main__": main()
