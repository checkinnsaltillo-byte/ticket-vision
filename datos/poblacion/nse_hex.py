#!/usr/bin/env python3
"""Nivel socioeconómico (NSE) por hexágono a partir del Censo de Población y Vivienda 2020 del INEGI.

Entradas:
  - Censo 2020, "Principales resultados por AGEB y manzana urbana", Coahuila (CSV del INEGI, no incluido).
  - maqueta/data/poblacion_hex_saltillo.json (hexágonos con el aporte de sus manzanas, generado por poblacion_hex.py).
Método (inspirado en la estratificación socioeconómica del INEGI):
  1. Variables de manzana (rasgos de la vivienda, bienes, escolaridad y seguridad social) llevadas al hexágono con el mismo
     reparto por área que la población (promedio ponderado por hogares o por personas).
  2. Índice = primer componente principal de las variables estandarizadas (ponderado por hogares).
  3. Estratos por el método de Dalenius y Hodges (cortes en la raíz cuadrada acumulada de la frecuencia) → 4 niveles:
     1 Bajo, 2 Medio bajo, 3 Medio alto, 4 Alto.
Uso: python3 -I nse_hex.py <csv> <poblacion_hex_saltillo.json> <salida.json>
"""
import csv, json, math, sys

CSV, HEX, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
D = json.load(open(HEX)); H = D['hex']
def num(x):
    try: return float(x)
    except Exception: return None
fil = {}
for r in csv.DictReader(open(CSV, encoding='utf-8-sig')):
    if r['MZA'] in ('000', '') or r['MUN'] not in ('030', '027', '004'): continue
    fil[r['ENTIDAD'] + r['MUN'] + r['LOC'] + r['AGEB'] + r['MZA']] = r
# (clave, nombre, signo, numerador, denominador | None si ya es un promedio)
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
def rec(m, key):
    r = fil.get(m)
    if not r: return None
    return num(r[key])
agg = []
for h in H:
    S = {k: [0.0, 0.0] for k, *_ in VARS}; vh = 0.0
    for cve, pc, f in h.get('mz', []):
        r = fil.get(cve)
        if not r: continue
        vv = num(r['VIVPAR_HAB']); vh += (f * vv) if vv else 0
        for k, nom, sg, nu, de, pesoc in VARS:
            wb = num(r[pesoc])
            if wb is None or wb <= 0: continue
            x = num(r[nu])
            if x is None: continue
            if de is None: val = x
            else:
                d = num(r[de])
                if d is None or d <= 0: continue
                val = 100.0 * x / d
            if k == 'gp' and val <= 0: continue
            S[k][0] += f * wb * val; S[k][1] += f * wb
    out = {}
    for k in S:
        out[k] = S[k][0] / S[k][1] if S[k][1] > 0 else None
    agg.append((out, vh))
ok = [i for i, (o, vh) in enumerate(agg) if vh >= 3 and all(o[k] is not None for k, *_ in VARS)]
ws = {i: agg[i][1] for i in ok}; W = sum(ws.values())
ks = [v[0] for v in VARS]; sg = {v[0]: v[2] for v in VARS}
mu = {k: sum(ws[i] * agg[i][0][k] for i in ok) / W for k in ks}
sd = {k: math.sqrt(sum(ws[i] * (agg[i][0][k] - mu[k]) ** 2 for i in ok) / W) or 1 for k in ks}
Z = {i: [(agg[i][0][k] - mu[k]) / sd[k] for k in ks] for i in ok}
p = len(ks); C = [[sum(ws[i] * Z[i][a] * Z[i][b] for i in ok) / W for b in range(p)] for a in range(p)]
v = [1.0] * p
for _ in range(500):
    w = [sum(C[a][b] * v[b] for b in range(p)) for a in range(p)]; n = math.sqrt(sum(x * x for x in w)); v = [x / n for x in w]
lam = sum(v[a] * sum(C[a][b] * v[b] for b in range(p)) for a in range(p))
# orientación: los rasgos de mayor bienestar deben sumar (escolaridad, bienes) y los de carencia restar (analfabetismo, hacinamiento, piso de tierra)
orient = sum(v[a] * sg[ks[a]] for a in range(p))
if orient < 0: v = [-x for x in v]
score = {i: sum(v[a] * Z[i][a] for a in range(p)) for i in ok}
m = sum(ws[i] * score[i] for i in ok) / W; s = math.sqrt(sum(ws[i] * (score[i] - m) ** 2 for i in ok) / W)
for i in ok: score[i] = (score[i] - m) / s
# Dalenius y Hodges: 60 clases del índice, raíz cuadrada de la frecuencia (hogares) acumulada, 4 estratos
lo, hi = min(score.values()), max(score.values()); NB = 60; fr = [0.0] * NB
for i in ok: fr[min(NB - 1, int((score[i] - lo) / (hi - lo) * NB))] += ws[i]
cs = []; a = 0
for x in fr: a += math.sqrt(x); cs.append(a)
cuts = []
for q in (1, 2, 3):
    t = cs[-1] * q / 4; j = next(j for j, c in enumerate(cs) if c >= t); cuts.append(round(lo + (j + 1) * (hi - lo) / NB, 3))
nivel = lambda x: 1 + sum(x >= c for c in cuts)
salida = []; niv = {1: [0, 0, 0], 2: [0, 0, 0], 3: [0, 0, 0], 4: [0, 0, 0]}
for i, hx in enumerate(H):
    if i not in score: salida.append(None); continue
    o = agg[i][0]; n = nivel(score[i]); niv[n][0] += 1; niv[n][1] += hx['p20']; niv[n][2] += hx['viv']
    salida.append([round(score[i], 2), n, round(o['gp'], 1), round(o['auto'], 1), round(o['inter'], 1), round(o['pc'], 1), round(o['oc'], 2), round(o['pb'], 1), round(o['ss'], 1), round(o['pt'], 1)])
NOM = {1: 'Bajo', 2: 'Medio bajo', 3: 'Medio alto', 4: 'Alto'}; ptot = sum(x[1] for x in niv.values()) or 1
meta = {'fuente': 'INEGI · Censo de Población y Vivienda 2020, Principales resultados por AGEB y manzana urbana (Coahuila)', 'metodo': 'Primer componente principal de 13 rasgos de vivienda, bienes, escolaridad y seguridad social, ponderado por hogares; estratos por Dalenius y Hodges (4 niveles)', 'varianza_explicada': round(lam / p, 3),
        'variables': [{'k': k, 'n': nom, 'signo': sgn, 'carga': round(v[j], 3), 'media': round(mu[k], 2), 'sd': round(sd[k], 2)} for j, (k, nom, sgn, *_r) in enumerate(VARS)], 'cortes': cuts,
        'niveles': [{'n': n, 'nombre': NOM[n], 'hex': niv[n][0], 'pob': round(niv[n][1]), 'pct_pob': round(100 * niv[n][1] / ptot, 1), 'viv': round(niv[n][2])} for n in (1, 2, 3, 4)],
        'hexagonos_clasificados': len(ok), 'hexagonos_sin_dato': len(H) - len(ok),
        'campos': ['indice', 'nivel', 'escolaridad', 'auto', 'internet', 'computadora', 'ocupantes_cuarto', 'posbasica', 'seguridad_social', 'piso_tierra'],
        'nota': 'El reparto de manzanas a hexágonos usa las 4 manzanas con mayor aporte de cada hexágono; el índice es relativo a Saltillo, Ramos Arizpe y Arteaga (no es una escala absoluta nacional). No es la clasificación comercial AMAI.'}
json.dump({'meta': meta, 'h': salida}, open(OUT, 'w'), ensure_ascii=False, separators=(',', ':')); print(json.dumps(meta, ensure_ascii=False, indent=1))
