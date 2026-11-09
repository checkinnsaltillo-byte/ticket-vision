#!/usr/bin/env python3
"""Modelo de ingreso del hogar a partir de la ENIGH 2024 (INEGI) para estimarlo en áreas pequeñas (manzana / AGEB) con variables que también trae el Censo 2020.

Estimación en áreas pequeñas (SAE) en dos pasos:
  1) Se ajusta con la ENIGH una regresión ponderada (factor de expansión) de log(ingreso corriente mensual del hogar) sobre rasgos del hogar que el Censo también publica por manzana:
     piso de tierra, 3+ cuartos, ocupantes por cuarto, auto, internet, computadora/laptop/tablet, TV de paga, lavadora, microondas, refrigerador, celular, teléfono fijo,
     consola de videojuegos, escolaridad media (15+), jefatura femenina, tamaño del hogar, ocupados por hogar; más efecto de entidad y de tamaño de localidad.
  2) hex_nacional.py aplica los coeficientes a los porcentajes de cada manzana del Censo 2020 (y los comprime hacia su AGEB cuando la manzana tiene pocos hogares).
Uso: python3 enigh_modelo.py <carpeta con concentradohogar.csv viviendas.csv hogares.csv poblacion.csv> <salida.json>
"""
import json, sys, os
import numpy as np, pandas as pd

D, OUT = sys.argv[1], sys.argv[2]
rd = lambda n, **k: pd.read_csv(os.path.join(D, n, n + '.csv'), low_memory=False, **k)
c = rd('concentradohogar'); v = rd('viviendas'); h = rd('hogares'); p = rd('poblacion', usecols=['folioviv', 'foliohog', 'edad', 'nivelaprob', 'gradoaprob'])
for t in (c, v, h, p): t['folioviv'] = t['folioviv'].astype(str)
num = lambda s: pd.to_numeric(s, errors='coerce')
v['mat_pisos'] = num(v['mat_pisos']); v['num_cuarto'] = num(v['num_cuarto'])
# escolaridad media de los integrantes de 15 años y más (años aprobados; mismos criterios que el Censo: primaria 6, secundaria 9, preparatoria 12…)
def anios(n, g):
    g = 0 if pd.isna(g) else g; n = 0 if pd.isna(n) else n
    return {0: 0, 1: 0, 2: min(g, 6), 3: 6 + min(g, 3), 4: 9 + min(g, 3), 5: 12 + min(g, 4), 6: 9 + min(g, 3), 7: 12 + min(g, 5), 8: 16 + min(g, 2), 9: 16 + min(g, 2), 10: 18 + min(g, 4)}.get(int(n), 0)
p = p[p['edad'] >= 15].copy(); p['anios'] = [anios(a, b) for a, b in zip(p['nivelaprob'], p['gradoaprob'])]
esc = p.groupby(['folioviv', 'foliohog'])['anios'].mean().rename('gp').reset_index()
m = c.merge(v[['folioviv', 'mat_pisos', 'num_cuarto']], on='folioviv').merge(h[['folioviv', 'foliohog', 'conex_inte', 'tv_paga', 'celular', 'telefono', 'num_auto', 'num_van', 'num_pick', 'num_compu', 'num_lap', 'num_table', 'num_lavad', 'num_micro', 'num_refri', 'num_juego']], on=['folioviv', 'foliohog']).merge(esc, on=['folioviv', 'foliohog'], how='left')
m = m[(m['ing_cor'] > 0) & (m['num_cuarto'] > 0) & m['gp'].notna()].copy()
F = pd.DataFrame(index=m.index)
F['pt'] = (m['mat_pisos'] == 1) * 1.0
F['c3'] = (m['num_cuarto'] >= 3) * 1.0
F['oc'] = m['tot_integ'] / m['num_cuarto']
F['auto'] = ((m['num_auto'] + m['num_van'] + m['num_pick']) > 0) * 1.0   # el Censo cuenta «automóvil o camioneta»
F['inter'] = (m['conex_inte'] == 1) * 1.0
F['pc'] = ((m['num_compu'] > 0) | (m['num_lap'] > 0) | (m['num_table'] > 0)) * 1.0
F['stvp'] = (m['tv_paga'] == 1) * 1.0
F['lav'] = (m['num_lavad'] > 0) * 1.0
F['mic'] = (m['num_micro'] > 0) * 1.0
F['refri'] = (m['num_refri'] > 0) * 1.0
F['cel'] = (m['celular'] == 1) * 1.0
F['telef'] = (m['telefono'] == 1) * 1.0
F['cvj'] = (m['num_juego'] > 0) * 1.0
F['gp'] = m['gp']
F['hf'] = (m['sexo_jefe'] == 2) * 1.0
F['tam'] = m['tot_integ']
F['ocup'] = m['ocupados']
FEATS = list(F.columns)
ent = m['ubica_geo'].astype(str).str.zfill(5).str[:2]; tam_loc = m['tam_loc'].astype(int)
ENTS = sorted(ent.unique()); ENTS_X = ENTS[1:]; TAMS_X = [2, 3, 4]
X = np.column_stack([np.ones(len(m)), F.values] + [(ent == e).values * 1.0 for e in ENTS_X] + [(tam_loc == t).values * 1.0 for t in TAMS_X])
names = ['const'] + FEATS + ['ent_' + e for e in ENTS_X] + ['tam_%d' % t for t in TAMS_X]
y = np.log(m['ing_cor'].values / 3.0); w = m['factor'].values.astype(float)
def wls(X, y, w):
    sw = np.sqrt(w); b, *_ = np.linalg.lstsq(X * sw[:, None], y * sw, rcond=None); return b
b = wls(X, y, w); res = y - X @ b; r2 = 1 - np.sum(w * res ** 2) / np.sum(w * (y - np.average(y, weights=w)) ** 2); sigma2 = np.sum(w * res ** 2) / np.sum(w)
# validación cruzada 5 pliegues (por UPM para no mezclar hogares vecinos)
upm = m['upm'].values; rng = np.random.default_rng(7); u = np.unique(upm); fold = dict(zip(u, rng.integers(0, 5, len(u)))); fo = np.array([fold[x] for x in upm]); pred = np.zeros(len(y))
for k in range(5):
    tr = fo != k; bk = wls(X[tr], y[tr], w[tr]); pred[~tr] = X[~tr] @ bk
r2cv = 1 - np.sum(w * (y - pred) ** 2) / np.sum(w * (y - np.average(y, weights=w)) ** 2)
smear = float(np.average(np.exp(res), weights=w))   # factor de Duan para volver de la escala logarítmica a pesos
# error estándar (diseño aproximado: ponderado, sin conglomerados)
wn = w / w.mean(); XtWX = (X * wn[:, None]).T @ X; cov = np.linalg.inv(XtWX) * sigma2 * (len(y) / (len(y) - X.shape[1])) * 2.0; se = np.sqrt(np.diag(cov))   # pesos normalizados (n efectivo = hogares de la muestra) y efecto de diseño aproximado de 2
mensual = m['ing_cor'].values / 3.0; urb = tam_loc.values <= 3
def wq(x, w, qs):
    o = np.argsort(x); cw = np.cumsum(w[o]) / w.sum(); return [float(x[o][np.searchsorted(cw, q)]) for q in qs]
out = {'fuente': 'INEGI · ENIGH 2024 (nueva serie): concentradohogar, viviendas, hogares, población', 'metodo': 'Regresión ponderada de log(ingreso corriente mensual del hogar) sobre rasgos del hogar presentes también en el Censo 2020, con efecto de entidad y de tamaño de localidad; estimación en áreas pequeñas',
       'hogares_muestra': int(len(y)), 'r2': round(float(r2), 3), 'r2_validacion_cruzada': round(float(r2cv), 3), 'sigma': round(float(np.sqrt(sigma2)), 3), 'smear': round(smear, 4), 'features': FEATS,
       'coef': {n: round(float(x), 5) for n, x in zip(names, b)}, 'se': {n: round(float(x), 5) for n, x in zip(names, se)},
       'enigh_media_mensual_nacional': round(float(np.average(mensual, weights=w))), 'enigh_mediana_mensual_nacional': round(wq(mensual, w, [.5])[0]),
       'enigh_media_mensual_urbana': round(float(np.average(mensual[urb], weights=w[urb]))), 'enigh_mediana_mensual_urbana': round(wq(mensual[urb], w[urb], [.5])[0]),
       'enigh_media_por_entidad': {e: round(float(np.average(mensual[(ent == e).values], weights=w[(ent == e).values]))) for e in ENTS},
       'enigh_deciles_mensuales': [round(x) for x in wq(mensual, w, [i / 10 for i in range(1, 10)])],
       'dias': 'ingreso corriente trimestral / 3 (pesos del 3er trimestre de 2024)'}
json.dump(out, open(OUT, 'w'), ensure_ascii=False, indent=1)
np.savez(os.path.join(os.path.dirname(os.path.abspath(OUT)), 'ingreso_hogares_enigh.npz'), F=F.values, cols=np.array(FEATS), y=mensual, w=w, ent=ent.values.astype(str), tam=tam_loc.values.astype(int))
print('hogares', len(y), 'R2', out['r2'], 'R2 validación cruzada', out['r2_validacion_cruzada'], 'sigma', out['sigma'], 'smear', out['smear'])
print({n: (round(float(x), 3), round(float(s), 3)) for n, x, s in zip(names[:18], b[:18], se[:18])})
print('media mensual nacional', out['enigh_media_mensual_nacional'], 'urbana', out['enigh_media_mensual_urbana'], 'deciles', out['enigh_deciles_mensuales'])
