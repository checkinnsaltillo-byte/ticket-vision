"""Colonias (asentamientos humanos) desde el DENUE del INEGI: cada establecimiento trae nomb_asent, tipo_asent, cod_postal y coordenadas.
INEGI no publica polígonos de colonias; aquí se agrupan los establecimientos por colonia y se condensan en celdas de 40 m (colonia dominante por celda) para inferir el territorio.
Uso: python3 -I colonias_prep.py <denue_inegi_XX_.csv> <S> <W> <N> <E> <salida.json> [cve_mun,cve_mun,...]"""
import csv, json, sys, re, math, unicodedata
sa = lambda t: ''.join(c for c in unicodedata.normalize('NFD', t) if unicodedata.category(c) != 'Mn')
csv_f, S, W, N, E, out_f = sys.argv[1:7]; S, W, N, E = map(float, (S, W, N, E))
muns = set(sys.argv[7].split(',')) if len(sys.argv) > 7 else None
MIN = {'de', 'del', 'la', 'las', 'los', 'el', 'y', 'e', 'en', 'a', 'al'}
def tit(s):
    w = re.sub(r'\s+', ' ', (s or '').strip()).lower().split(' ')
    return ' '.join(x if (i and x in MIN) else (x[:1].upper() + x[1:]) for i, x in enumerate(w))
def tipo(s):
    t = tit(s); return {'Fraccionamiento': 'Fracc.', 'Unidad habitacional': 'U. hab.', 'Colonia': 'Col.', 'Barrio': 'Barrio', 'Condominio': 'Cond.', 'Ejido': 'Ejido', 'Parque industrial': 'Parque industrial', 'Zona industrial': 'Zona industrial', 'Pueblo': 'Pueblo', 'Rancho o ranchería': 'Rancho', 'Residencial': 'Resid.'}.get(t, t)
idx = {}; names = []; cps = []; tps = []; acc = []; pts = {}
mu_n = {}
for r in csv.DictReader(open(csv_f, encoding='latin-1', errors='replace')):
    try: la, lo = float(r['latitud']), float(r['longitud'])
    except ValueError: continue
    if not (S <= la <= N and W <= lo <= E): continue
    if muns and r['cve_mun'] not in muns: continue
    nom = (r['nomb_asent'] or '').strip()
    if not nom or nom.upper() in ('NINGUNO', 'SIN DATO', 'NO ESPECIFICADO'): continue
    k = (re.sub(r'\s+', ' ', sa(nom).upper()), r['cve_mun'])   # sin acentos ni tipo: «Tecnológico» y «Tecnologico» son la misma colonia
    if k not in idx:
        idx[k] = len(names); names.append([tit(nom), '', tit(r['municipio']), '']); cps.append({}); tps.append({}); acc.append({})
    i = idx[k]; tt = tipo(r['tipo_asent']); tps[i][tt] = tps[i].get(tt, 0) + 1; nn = tit(nom); acc[i][nn] = acc[i].get(nn, 0) + 1; cp = (r['cod_postal'] or '').strip(); cps[i][cp] = cps[i].get(cp, 0) + 1
    cy = math.floor(la / 0.00036); cx = math.floor(lo / (0.00036 / math.cos(math.radians(la))) ) if False else math.floor(lo / 0.00040)
    d = pts.setdefault((cy, cx), {}); d[i] = d.get(i, 0) + 1
    d['_s'] = d.get('_s', 0) + 1
for i, c in enumerate(cps):
    names[i][3] = max(c, key=c.get) if c else ''; names[i][1] = max(tps[i], key=tps[i].get); names[i][0] = max(acc[i], key=lambda q: (any(ch in q for ch in 'áéíóúÁÉÍÓÚñ'), acc[i][q]))   # nombre con acentos si alguna variante lo trae
P = []
for (cy, cx), d in pts.items():
    best = max((k for k in d if k != '_s'), key=lambda k: d[k]); P.append([round((cy + .5) * 0.00036, 5), round((cx + .5) * 0.00040, 5), best])
used = sorted({p[2] for p in P}); remap = {o: n for n, o in enumerate(used)}
json.dump({'meta': {'fuente': 'INEGI · DENUE: nombre de asentamiento (colonia) de cada establecimiento; territorio inferido', 'colonias': len(used), 'celdas': len(P), 'celda_m': 40}, 'c': [names[o] for o in used], 'p': [[a, b, remap[c]] for a, b, c in P]}, open(out_f, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print(out_f, 'colonias', len(used), 'celdas', len(P))
