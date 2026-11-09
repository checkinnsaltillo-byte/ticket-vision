#!/usr/bin/env python3
"""Prepara lo que necesita la microsimulación del ingreso (corre una vez, local):
  · ingreso_muestra.npz   remuestreo ponderado de 12,000 hogares urbanos de la ENIGH 2024 (rasgos, ingreso mensual, entidad, tamaño de localidad)
  · ingreso_armonia.json  corrección por entidad para que los porcentajes del Censo 2020 hablen «el mismo idioma» que la ENIGH 2024 (cambios de definición y de fecha: internet, teléfono fijo, tamaño del hogar…)
Uso: python3 ingreso_prep.py <carpeta con ingreso/calib/*.json bajados>"""
import glob, json, math, os, sys
import numpy as np
AQUI = os.path.dirname(os.path.abspath(__file__)); M = json.load(open(os.path.join(AQUI, "enigh_modelo.json")))
d = np.load(os.path.join(AQUI, "ingreso_hogares_enigh.npz"), allow_pickle=True); F, cols, y, w, ent, tam = d["F"], list(d["cols"]), d["y"], d["w"], d["ent"], d["tam"]
assert cols == M["features"]
urb = tam <= 3; rng = np.random.default_rng(11); idx = np.where(urb)[0]; S = rng.choice(idx, size=12000, replace=True, p=w[idx] / w[idx].sum())
np.savez_compressed(os.path.join(AQUI, "ingreso_muestra.npz"), F=F[S].astype(np.float32), y=y[S].astype(np.float32), ent=ent[S], tam=tam[S])
SHARE = [c not in ("oc", "gp", "tam", "ocup") for c in cols]
lg = lambda p: math.log(min(max(p, .003), .997) / (1 - min(max(p, .003), .997)))
CEN = {}
for f in glob.glob(os.path.join(sys.argv[1], "*.json")):
    c = json.load(open(f)); CEN[c["ent"]] = (c["fhog"], c["fmean"])
tot = sum(v[0] for v in CEN.values()); cen_nac = [sum(v[0] * v[1][j] for v in CEN.values()) / tot for j in range(len(cols))]
en_nac = np.average(F[urb], axis=0, weights=w[urb])
drift = [lg(en_nac[j]) - lg(cen_nac[j]) if SHARE[j] else math.log(en_nac[j] / cen_nac[j]) for j in range(len(cols))]
delta = {}; info = {}
for e, (fh, fm) in sorted(CEN.items()):
    m = urb & (ent == e); n = int(m.sum()); wgt = n / (n + 300.0)
    if n: en_e = np.average(F[m], axis=0, weights=w[m])
    row = []
    for j in range(len(cols)):
        if SHARE[j]:
            tgt = lg(en_e[j]) * wgt + (lg(fm[j]) + drift[j]) * (1 - wgt) if n else lg(fm[j]) + drift[j]
            row.append(round(tgt - lg(fm[j]), 4))
        else:
            tgt = math.log(en_e[j]) * wgt + (math.log(fm[j]) + drift[j]) * (1 - wgt) if n else math.log(fm[j]) + drift[j]
            row.append(round(tgt - math.log(fm[j]), 4))
    delta[e] = row; info[e] = n
json.dump({"features": cols, "share": SHARE, "delta": delta, "hogares_enigh_urbanos": info, "deriva_nacional": [round(x, 4) for x in drift], "censo_nacional": [round(x, 3) for x in cen_nac], "enigh_nacional": [round(float(x), 3) for x in en_nac]}, open(os.path.join(AQUI, "ingreso_armonia.json"), "w"), indent=1)
print("censo nac ", dict(zip(cols, [round(x, 2) for x in cen_nac]))); print("enigh nac ", dict(zip(cols, [round(float(x), 2) for x in en_nac])))
