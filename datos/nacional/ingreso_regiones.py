#!/usr/bin/env python3
"""Ingreso estimado del hogar para los hexágonos propios de Saltillo y Monterrey (maqueta/data/poblacion_hex_<región>.json): promedio ponderado de las manzanas que aporta cada hexágono
(ingreso/mun/<ent>/<entmun>.json, lo deja hex_nacional.py). Salida: maqueta/data/ingreso_hex_<región>.json = {"meta":…, "h":[[ingreso, nivel] | null, …]} en el mismo orden que los hexágonos.
Uso: python3 ingreso_regiones.py   (desde la carpeta Codigo; requiere gcloud con acceso al bucket)"""
import json, os, subprocess, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); RAIZ = os.path.abspath(os.path.join(AQUI, "..", ".."))
CAL = json.load(open(os.path.join(AQUI, "ingreso_calibracion.json"))); CORTES = CAL["cortes"]
G = os.path.expanduser("~/google-cloud-sdk/bin/gcloud"); ENV = {**os.environ, "CLOUDSDK_PYTHON": os.path.expanduser("~/opt/anaconda3/envs/gcloud/bin/python")}
cache = {}
def mun(cm):
    if cm not in cache:
        r = subprocess.run([G, "storage", "cat", f"gs://check-in-493804-panel/ingreso/mun/{cm[:2]}/{cm}.json"], capture_output=True, env=ENV)
        cache[cm] = {x[0]: x[1] for x in json.loads(r.stdout)["mz"]} if r.returncode == 0 else {}
    return cache[cm]
for reg in ("saltillo", "monterrey"):
    D = json.load(open(os.path.join(RAIZ, f"maqueta/data/poblacion_hex_{reg}.json"))); out = []; n = 0
    for h in D["hex"]:
        s = w = 0.0
        for cve, masa, _f in h.get("mz", []):
            v = mun(cve[:5]).get(cve)
            if v is not None and masa > 0: s += masa * v; w += masa
        if w > 0: i = s / w; out.append([round(i), 1 + sum(i >= c for c in CORTES)]); n += 1
        else: out.append(None)
    meta = {"fuente": "Estimación propia: ENIGH 2024 (INEGI) sobre variables del Censo 2020, por manzana; promedio ponderado por población de las manzanas de cada hexágono", "unidad": "MXN por hogar al mes (pesos de 2024)", "campos": ["ingreso_mensual", "nivel"], "niveles": ["Bajo", "Medio bajo", "Medio", "Medio alto", "Alto"], "hexagonos_con_dato": n, "hexagonos": len(out)}
    json.dump({"meta": meta, "h": out}, open(os.path.join(RAIZ, f"maqueta/data/ingreso_hex_{reg}.json"), "w"), ensure_ascii=False, separators=(",", ":")); print(reg, n, "de", len(out), "hexágonos con ingreso")
