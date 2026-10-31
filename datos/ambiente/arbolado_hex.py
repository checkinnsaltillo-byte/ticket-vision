"""Cobertura del suelo (ESA WorldCover 10 m, 2021) por hexágono de 200 m de Saltillo y zona conurbada.
Usa la ruta /mercado/maqueta/suelo del backend (teselas de 1.2 km) y las ensambla en un mosaico de 10 m.
Uso: python3 -I arbolado_hex.py <poblacion_hex_saltillo.json> <salida.json>"""
import json, sys, math, base64, urllib.request, concurrent.futures as cf
import numpy as np
hx, out = sys.argv[1:3]
D = json.load(open(hx)); H = D['hex']; lat0, lng0 = D['meta']['ancla']
kx = 111320 * math.cos(math.radians(lat0)); ky = 111320
X = [(h['lng'] - lng0) * kx for h in H]; Y = [(h['lat'] - lat0) * ky for h in H]
x0, x1, y0, y1 = min(X) - 300, max(X) + 300, min(Y) - 300, max(Y) + 300
T = 1200.0
nx, ny = int(math.ceil((x1 - x0) / T)), int(math.ceil((y1 - y0) / T)); print('teselas', nx, ny, nx * ny)
cells = int(T // 10); M = np.zeros((ny * cells, nx * cells), dtype=np.uint8)   # fila 0 = norte
def pide(ij):
    i, j = ij; cx = x0 + (i + .5) * T; cy = y1 - (j + .5) * T
    la, lo = lat0 + cy / ky, lng0 + cx / kx
    u = f'https://api.check-inn.mx/mercado/maqueta/suelo?lat={la:.6f}&lng={lo:.6f}&r=600'
    for t in range(4):
        try:
            r = urllib.request.Request(u, headers={'Origin': 'https://www.check-inn.mx'})
            d = json.load(urllib.request.urlopen(r, timeout=120))
            if d.get('ok'): return ij, np.frombuffer(base64.b64decode(d['b64']), dtype=np.uint8).reshape(d['n'], d['n']), la, lo
        except Exception as e: err = e
    return ij, None, la, lo
fails = 0
with cf.ThreadPoolExecutor(6) as ex:
    for k, (ij, a, la, lo) in enumerate(ex.map(pide, [(i, j) for j in range(ny) for i in range(nx)])):
        if a is None: fails += 1; continue
        i, j = ij; n = a.shape[0]; M[j * cells:j * cells + n, i * cells:i * cells + n] = a[:cells, :cells]
        if k % 40 == 0: print(k, flush=True)
print('fallas', fails)
R = 200.0; res = []
yy, xx = np.mgrid[-21:22, -21:22]; dx = xx * 10.0; dy = yy * 10.0
mask = (np.abs(dy) <= R * .96) & (np.abs(dx) <= R * .96 * math.sqrt(3) / 2) & (np.abs(dx) * .5 + np.abs(dy) * math.sqrt(3) / 2 <= R * .96 * math.sqrt(3) / 2) if False else (np.hypot(dx, dy) <= R * .93)
for h, x, y in zip(H, X, Y):
    ci = int((x - x0) / 10); cj = int((y1 - y) / 10)
    sub = M[max(0, cj - 21):cj + 22, max(0, ci - 21):ci + 22]; mk = mask[(21 - (cj - max(0, cj - 21))):(21 - (cj - max(0, cj - 21))) + sub.shape[0], (21 - (ci - max(0, ci - 21))):(21 - (ci - max(0, ci - 21))) + sub.shape[1]]
    v = sub[mk]; v = v[v > 0]
    if len(v) < 40: res.append(None); continue
    f = lambda cs: int(round(100 * np.isin(v, cs).sum() / len(v)))
    res.append([f([10]), f([20]), f([30, 40]), f([50]), f([60]), f([80, 90, 95, 100, 70])])
json.dump({'meta': {'fuente': 'ESA WorldCover 10 m · 2021 (vía /mercado/maqueta/suelo)', 'campos': ['arbol', 'matorral', 'pasto_cultivo', 'construido', 'suelo_desnudo', 'agua_otros'], 'unidad': '% del área del hexágono (radio efectivo ≈ 186 m)', 'nota': 'arbol = clase 10 de WorldCover (árboles de ≥ 5 m aprox.); es un indicador de cobertura arbórea, no el modelo de copas de Google (Tree Canopy Insights)'}, 'h': res}, open(out, 'w'), separators=(',', ':'))
print('listo', sum(1 for r in res if r), 'de', len(res))
