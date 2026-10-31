"""Prepara los establecimientos del DENUE (INEGI) de la zona conurbada de Saltillo para el visor de maqueta.
Uso: python3 -I denue_prep.py <denue_inegi_05_.csv> <poblacion_hex_saltillo.json> <salida.json>
Descarga: https://www.inegi.org.mx/contenidos/masiva/denue/denue_05_csv.zip (Coahuila)."""
import csv, json, sys, re
csv_f, hex_f, out_f = sys.argv[1:4]
H = json.load(open(hex_f))['hex']
la0, la1 = min(h['lat'] for h in H) - .01, max(h['lat'] for h in H) + .01
lo0, lo1 = min(h['lng'] for h in H) - .01, max(h['lng'] for h in H) + .01
G = [('Comercio al por menor', '#f472b6'), ('Comercio al por mayor', '#fb923c'), ('Restaurantes y hospedaje', '#facc15'),
     ('Servicios financieros y seguros', '#22d3ee'), ('Profesionales, corporativos e inmobiliarios', '#818cf8'),
     ('Salud y asistencia social', '#4ade80'), ('Educación, cultura y esparcimiento', '#a78bfa'),
     ('Industria, construcción y primario', '#94a3b8'), ('Transporte, información y gobierno', '#38bdf8'), ('Otros servicios', '#f87171')]
def grupo(c):
    s = c[:2]
    if s == '46': return 0
    if s == '43': return 1
    if s == '72': return 2
    if s == '52': return 3
    if s in ('53', '54', '55', '56'): return 4
    if s in ('62',): return 5
    if s in ('61', '71'): return 6
    if s in ('11', '21', '22', '23', '31', '32', '33'): return 7
    if s in ('48', '49', '51', '93'): return 8
    return 9
def tam(t):
    m = re.match(r'(\d+)', t or ''); n = int(m.group(1)) if m else 0
    return 0 if n <= 5 else 1 if n <= 10 else 2 if n <= 30 else 3 if n <= 50 else 4 if n <= 100 else 5 if n <= 250 else 6
P = []
for r in csv.DictReader(open(csv_f, encoding='latin-1')):
    try: la, lo = float(r['latitud']), float(r['longitud'])
    except ValueError: continue
    if la0 < la < la1 and lo0 < lo < lo1:
        P.append([round(la, 5), round(lo, 5), grupo(r['codigo_act']), tam(r['per_ocu']), r['nom_estab'].strip().title()[:34], r['codigo_act']])
json.dump({'meta': {'fuente': 'INEGI · DENUE (Directorio Estadístico Nacional de Unidades Económicas), Coahuila', 'grupos': [{'n': n, 'c': c} for n, c in G],
  'tamanos': ['0-5', '6-10', '11-30', '31-50', '51-100', '101-250', '251+'], 'n': len(P), 'campos': ['lat', 'lng', 'grupo', 'tamano', 'nombre', 'scian']}, 'p': P}, open(out_f, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print(len(P), [sum(1 for p in P if p[2] == k) for k in range(10)])
