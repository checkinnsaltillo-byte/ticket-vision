#!/usr/bin/env python3
"""Malla nacional · indicadores por AGEB urbana de TODO México que salen solo de bases públicas ya cargadas (sin Google Places ni ningún análisis por sitio) → malla/<ent>.json

Lee por estado, de Cloud Storage: ageb/<ent>.json (AGEB, centro y contorno), censo/mun (manzanas: centro y población), denue/mun (negocios con giro, tamaño y SCIAN),
osm/nac/vial (red vial con su clase), osm/nac/ent (árboles), colonias/<ent> (tipo de asentamiento del DENUE) e inegi/<ent>.json (agua y áreas verdes).
Por AGEB guarda (misma fórmula que Geo Lab, con el DENUE en lugar de Google donde hace falta):
  g    negocios por giro (10 sectores del DENUE)
  pot  potencial de gravedad económica: empleo equivalente por km² suavizado con núcleo gaussiano (σ = 300 m), total + 10 sectores
  pd   distancia (m) al polo (centro de gravedad) más cercano de cada uno de esos 11 conjuntos
  pi   polaridad 0-100: potencial del AGEB / potencial de su polo
  apt  aptitud comercial 0-100 con DENUE (6 categorías de servicios + promedio), fórmula de Geo Lab
  afl  [residentes, empleados, visitantes inferidos] a ≤ 500 m
  apea afluencia peatonal diaria estimada = 0.8·R + 0.8·E + 0.5·V (a ≤ 500 m)
  anc  establecimientos de alta afluencia (anclas) a ≤ 500 m
  via  km de vialidad a ≤ 1 km por clase [autopista/troncal, primaria, secundaria, terciaria, local]
  dpri distancia (m) a la vialidad primaria o superior más cercana
  tipo tipo de asentamiento dominante (índice en meta.tipos) y % de la población que vive en él
  nat  [m² de áreas verdes de INEGI a ≤ 1 km, distancia (m) al agua más cercana, árboles de OSM a ≤ 500 m]
Reanudable (salta estados hechos; --forzar rehace). --fusiona calcula referencias nacionales (malla/ref.json).
Uso: python3 -I malla_nacional.py [--estados 06,19] [--local CARPETA] [--forzar] | --fusiona
"""
import argparse, json, math, os, re, sys, time
from collections import defaultdict
import numpy as np
from scipy.spatial import cKDTree
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nacional import log, NOMBRES, Salida
import hex_nacional as HX

BUCKET = "check-in-493804-panel"
GIROS = ["Comercio al por menor", "Comercio al por mayor", "Restaurantes y hospedaje", "Servicios financieros y seguros", "Profesionales, corporativos e inmobiliarios", "Salud y asistencia social", "Educación, cultura y esparcimiento", "Industria, construcción y primario", "Transporte, información y gobierno", "Otros servicios"]
AFL_MID = [3, 8, 20, 40, 75, 175, 350]
AFL_R = [(r"^622", 4, 4.5, 2), (r"^621[1-9]", 4, 7, 0), (r"^6244", 5, 12, 0), (r"^62", 4, 3, 0), (r"^61111", 5, 14, 1), (r"^61112", 5, 18, 1), (r"^6111[34]", 5, 15, 1), (r"^6112", 5, 20, 1), (r"^6113", 5, 25, 2), (r"^611[4-9]", 5, 6, 0),
         (r"^462111", 2, 45, 2), (r"^4622", 2, 30, 2), (r"^462112", 1, 90, 0), (r"^4621", 2, 40, 2), (r"^4611", 1, 40, 0), (r"^4641", 1, 45, 0), (r"^46", 1, 14, 0),
         (r"^7223", 3, 6, 0), (r"^7224", 3, 16, 0), (r"^722", 3, 25, 0), (r"^721", 8, 3, 0), (r"^5221", 7, 28, 1), (r"^52", 7, 8, 0), (r"^5[345]", 7, 2.5, 0), (r"^93", 6, 14, 2),
         (r"^51213", 8, 80, 2), (r"^71", 8, 18, 0), (r"^8132", 8, 20, 0), (r"^81", 7, 8, 0), (r"^(4851|4852|4881|4883|4884)", 9, 60, 2), (r"^4[89]", 9, 12, 0), (r"^43", 10, 2, 0), (r".", 10, 1.5, 0)]
AFL_R = [(re.compile(a), b, c, d) for a, b, c, d in AFL_R]
MARCA = re.compile(r"(^|\s)(soriana|walmart|wal mart|heb|h-e-b|chedraui|costco|sams|sam's|bodega aurrera|la comer|city club|smart|ley)(\s|$)"); MALL = re.compile(r"(centro comercial|galer[ií]as|plaza comercial|outlet|\bmall\b)")
# aptitud comercial con DENUE: (patrón SCIAN, referencia de negocios) por categoría; misma fórmula que Geo Lab (Google Places): 0.65·min(1, n/ref) + 0.35·(1 − d/800)
APT = [(re.compile(r"^62"), 8), (re.compile(r"^(461|462|4641)"), 10), (re.compile(r"^61"), 6), (re.compile(r"^(71|722)"), 25), (re.compile(r"^(485|488)"), 10), (re.compile(r"^(52|54|81|93)"), 20)]
APT_N = ["Salud", "Abasto", "Educación", "Ocio y comida", "Transporte", "Servicios"]
VCL = {"motorway": 0, "motorway_link": 0, "trunk": 0, "trunk_link": 0, "primary": 1, "primary_link": 1, "secondary": 2, "secondary_link": 2, "tertiary": 3, "tertiary_link": 3, "unclassified": 4, "residential": 4, "living_street": 4}
VCL_N = ["Autopista o troncal", "Primaria", "Secundaria", "Terciaria", "Local"]
SIG = 300.0
TIPO_G = ["Colonia", "Fraccionamiento o residencial", "Unidad o conjunto habitacional", "Barrio", "Pueblo, ejido o localidad rural", "Zona industrial", "Otro"]
def tipo_g(t):
    t = (t or "").lower()
    if t.startswith("col") and "ampl" not in t: return 0
    if any(q in t for q in ("fracc", "resid", "privada", "coto", "cond", "prolong", "ampliac")): return 1
    if "habitacional" in t: return 2
    if "barrio" in t: return 3
    if any(q in t for q in ("pueblo", "ejido", "localidad", "ranch", "granja", "hacienda", "exhacienda", "poblado", "congregaci")): return 4
    if "industrial" in t or "industria" in t: return 5
    return 6 if t and t not in ("ninguno", "sin dato", "no especificado") else -1


def fwd_np(lat, lng):
    """LCC de INEGI vectorizada (metros), misma proyección que hex_nacional.fwd"""
    p, l = np.radians(lat), np.radians(lng); s = np.sin(p); t = np.tan(np.pi / 4 - p / 2) / ((1 - HX.E * s) / (1 + HX.E * s)) ** (HX.E / 2)
    rho = HX.A * HX.FF * t ** HX.N; th = HX.N * (l - HX.L0)
    return HX.FE + rho * np.sin(th), HX.RHO0 - rho * np.cos(th)

def dec_poly(s):
    """polyline de Google con precisión 1e6 → arreglos lat, lng"""
    i = 0; la = lo = 0; A = []; B = []; n = len(s)
    while i < n:
        for k in (0, 1):
            r = 0; sh = 0
            while True:
                b = ord(s[i]) - 63; i += 1; r |= (b & 31) << sh; sh += 5
                if b < 32: break
            d = ~(r >> 1) if r & 1 else r >> 1
            if k == 0: la += d
            else: lo += d
        A.append(la / 1e6); B.append(lo / 1e6)
    return np.array(A), np.array(B)

DATOS = None   # carpeta local que replica las rutas del bucket (--datos-local); sin ella se lee de Cloud Storage

def lee(sal, ruta):
    """JSON del bucket (o de la carpeta local) o None"""
    if DATOS:
        p = os.path.join(DATOS, ruta); return json.load(open(p)) if os.path.exists(p) else None
    b = sal.b.blob(ruta)
    return json.loads(b.download_as_bytes()) if b.exists() else None

def lista(sal, prefijo):
    if DATOS:
        import glob
        for p in sorted(glob.glob(os.path.join(DATOS, prefijo, "*.json"))):
            if not p.endswith("index.json"): yield p, json.load(open(p))
        return
    for b in sal.b.list_blobs(prefix=prefijo + "/"):
        if b.name.endswith(".json") and not b.name.endswith("index.json"): yield b.name, json.loads(b.download_as_bytes())

def area_pol(x, y): return abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))) / 2


def calcula(ent, sal):
    t0 = time.time(); A = lee(sal, f"ageb/{ent}.json")
    if not A: raise RuntimeError("falta ageb/" + ent)
    claves = [k for k, r in A["ageb"].items() if r[0] is not None]; n = len(claves)
    cla = np.array([A["ageb"][k][0] for k in claves]); clo = np.array([A["ageb"][k][1] for k in claves]); cx, cy = fwd_np(cla, clo); C = np.c_[cx, cy]; TA = cKDTree(C); ix = {k: i for i, k in enumerate(claves)}
    S, W_, N_, E_ = cla.min() - .1, clo.min() - .1, cla.max() + .1, clo.max() + .1
    # manzanas: centro y población
    mla = []; mlo = []; mpt = []; mag = []
    for _nm, d in lista(sal, f"censo/mun/{ent}"):
        for m in d["mz"]:
            k = m[0][:13]
            if k in ix: mla.append(m[1]); mlo.append(m[2]); mpt.append(m[5] or 0); mag.append(ix[k])
    mx, my = fwd_np(np.array(mla), np.array(mlo)); M = np.c_[mx, my]; TM = cKDTree(M); mpt = np.array(mpt, float); mag = np.array(mag)
    log(ent, "AGEB:", n, "· manzanas:", len(mag))
    # DENUE: giro, tamaño, afluencia y categoría de aptitud de cada negocio
    dla = []; dlo = []; dg = []; dE = []; dV = []; dan = []; dc = []
    for _nm, d in lista(sal, f"denue/mun/{ent}"):
        for p in d.get("p") or []:
            sc = str(p[5]); nm = (p[4] or "").lower(); tam = int(p[3]) if isinstance(p[3], (int, float)) else 0; tam = min(6, max(0, tam))
            cat = f = a = None
            for rx, c_, f_, a_ in AFL_R:
                if rx.search(sc): cat, f, a = c_, f_, a_; break
            if cat == 2 and MARCA.search(nm): f *= 1.25; a = 2
            if MALL.search(nm) and tam >= 2: cat = 2; f = max(f, 25); a = 2
            anc = 1 if (a == 2 or (a == 1 and tam >= 2)) else 0; e = AFL_MID[tam]
            ap = next((i for i, (rx, _r) in enumerate(APT) if rx.search(sc)), -1)
            dla.append(p[0]); dlo.append(p[1]); dg.append(int(p[2]) if isinstance(p[2], (int, float)) else 9); dE.append(e); dV.append(e * f); dan.append(anc); dc.append(ap)
    dla = np.array(dla); dlo = np.array(dlo); dg = np.clip(np.array(dg, int), 0, 9); dE = np.array(dE, float); dV = np.array(dV, float); dan = np.array(dan, int); dc = np.array(dc, int)
    nd = len(dg); dx, dy = fwd_np(dla, dlo) if nd else (np.zeros(0), np.zeros(0)); D = np.c_[dx, dy]; log(ent, "negocios:", nd)
    giros = np.zeros((n, 10), int)
    if nd:
        TD = cKDTree(D); dist, j = TM.query(D, k=1, distance_upper_bound=150.0); ok = np.isfinite(dist)
        np.add.at(giros, (mag[j[ok]], dg[ok]), 1)
    # gravedad económica: potencial gaussiano de empleo equivalente por km², total + 10 sectores
    pot = np.zeros((n, 11));
    if nd:
        Wm = np.zeros((nd, 11)); Wm[:, 0] = dE; Wm[np.arange(nd), 1 + dg] = dE
        for i, idx in enumerate(TD.query_ball_point(C, 3 * SIG)):
            if not idx: continue
            dd = D[idx] - C[i]; kk = np.exp(-(dd[:, 0] ** 2 + dd[:, 1] ** 2) / (2 * SIG * SIG)); pot[i] = kk @ Wm[idx]
        pot *= 1e6 / (2 * math.pi * SIG * SIG)
    pd = np.full((n, 11), np.nan); pi_ = np.full((n, 11), np.nan)
    vec = TA.query_ball_point(C, 3000.0)
    for s in range(11):
        v = pot[:, s]; mx_ = v.max() if n else 0
        if mx_ <= 0: continue
        piso = max(50.0 if s else 200.0, .05 * mx_); pic = [i for i in range(n) if v[i] >= piso and v[i] >= v[vec[i]].max() - 1e-9]
        if not pic: continue
        TP = cKDTree(C[pic]); dd, jj = TP.query(C, k=1); pv = v[np.array(pic)][jj]; okp = dd <= 15000
        pd[okp, s] = dd[okp]; pi_[okp, s] = np.minimum(100, 100 * v[okp] / np.maximum(pv[okp], 1e-9))
    # aptitud comercial (DENUE): n a ≤ 1 km y distancia al más cercano
    apt = np.zeros((n, 7))
    for c, (_rx, ref) in enumerate(APT):
        sel = np.where(dc == c)[0]
        if not len(sel): continue
        T = cKDTree(D[sel]); dist, _ = T.query(C, k=1, distance_upper_bound=800.0); cnt = np.array([len(x) for x in T.query_ball_point(C, 1000.0)])
        d_ = np.where(np.isfinite(dist), dist, 800.0); apt[:, c] = np.round(100 * (.65 * np.minimum(1, cnt / ref) + .35 * (1 - np.minimum(1, d_ / 800.0))) * (cnt > 0))
    apt[:, 6] = np.round(apt[:, :6].mean(axis=1))
    # afluencia a ≤ 500 m: residentes (manzanas), empleados y visitantes inferidos (DENUE)
    R = np.zeros(n); Em = np.zeros(n); Vm = np.zeros(n); anc = np.zeros(n, int)
    for i, idx in enumerate(TM.query_ball_point(C, 500.0)): R[i] = mpt[idx].sum() if idx else 0
    if nd:
        for i, idx in enumerate(TD.query_ball_point(C, 500.0)):
            if idx: Em[i] = dE[idx].sum(); Vm[i] = dV[idx].sum(); anc[i] = dan[idx].sum()
    apea = .8 * R + .8 * Em + .5 * Vm
    # vialidad (OSM): km por clase a ≤ 1 km y distancia a la vía primaria o superior
    via = np.zeros((n, 5)); dpri = np.full(n, np.nan); PX = []; PY = []; PC = []; PL = []; vistos = set(); celdas = set((lee(sal, "osm/nac/vial/index.json") or {}).get("celdas", [])); PASO = 50.0
    for i in range(int(math.floor(S / .5)), int(math.floor(N_ / .5)) + 1):
        for j in range(int(math.floor(W_ / .5)), int(math.floor(E_ / .5)) + 1):
            if f"{i}_{j}" not in celdas: continue
            t = lee(sal, f"osm/nac/vial/{i}_{j}.json")
            for w in (t or {}).get("ways", []):
                if w.get("i") in vistos: continue          # las celdas se traslapan (margen de 0.25°): cada calle se cuenta una vez
                vistos.add(w.get("i")); c = VCL.get((w.get("t") or {}).get("highway"))
                if c is None: continue
                la, lo = dec_poly(w["g"])
                if len(la) < 2: continue
                x, y = fwd_np(la, lo); cum = np.r_[0, np.cumsum(np.hypot(np.diff(x), np.diff(y)))]; tot = cum[-1]
                if tot < 1: continue
                k = max(1, int(round(tot / PASO))); pos = (np.arange(k) + .5) * tot / k; PX.append(np.interp(pos, cum, x)); PY.append(np.interp(pos, cum, y)); PC.append(np.full(k, c, np.int8)); PL.append(np.full(k, tot / k, np.float32))
    if PX:
        px = np.concatenate(PX); P = np.c_[px, np.concatenate(PY)]; pcl = np.concatenate(PC).astype(int); pl = np.concatenate(PL).astype(float); T = cKDTree(P)
        for i, idx in enumerate(T.query_ball_point(C, 1000.0)):
            if idx: via[i] = np.bincount(pcl[idx], weights=pl[idx], minlength=5) / 1000.0
        sel = np.where(pcl <= 1)[0]
        if len(sel): dd, _ = cKDTree(P[sel]).query(C, k=1, distance_upper_bound=20000.0); dpri[:] = np.where(np.isfinite(dd), dd, np.nan)
    px = PX
    log(ent, "calles:", len(vistos))
    # tipo de asentamiento: celda de colonia (DENUE) más cercana a cada manzana, moda ponderada por población
    tipos = TIPO_G; cx_ = []; cy_ = []; ct = []
    ci = lee(sal, f"colonias/{ent}/index.json")
    for cel in (ci or {}).get("celdas", []):
        t = lee(sal, f"colonias/{ent}/{cel}.json")
        if not t: continue
        for la, lo, o in t["p"]:
            g_ = tipo_g(t["c"][o][1])
            if g_ >= 0: cx_.append(la); cy_.append(lo); ct.append(g_)
    tipo = np.full(n, -1); tpct = np.zeros(n)
    if cx_:
        x, y = fwd_np(np.array(cx_), np.array(cy_)); dd, jj = cKDTree(np.c_[x, y]).query(M, k=1, distance_upper_bound=250.0); ct = np.array(ct); acc = defaultdict(lambda: defaultdict(float)); tot = np.zeros(n)
        for m_, (d_, j_) in enumerate(zip(dd, jj)):
            w = max(mpt[m_], 1.0); tot[mag[m_]] += w
            if np.isfinite(d_): acc[mag[m_]][int(ct[j_])] += w
        for a, dct in acc.items(): k = max(dct, key=dct.get); tipo[a] = k; tpct[a] = 100 * dct[k] / tot[a]
    # entorno natural: áreas verdes y agua de INEGI, árboles de OSM
    nat = np.zeros((n, 3)); nat[:, 1] = np.nan
    ig = lee(sal, f"inegi/{ent}.json") or {}; vx = []; vy = []; va = []; wx = []; wy = []
    VERDE = {"jardin", "parque", "areas verdes", "unidad deportiva"}
    for it in ig.get("sia", []):
        g, t = it.get("g", ""), it.get("t", "")
        if g == "cuerpo de agua" or (g == "instalacion deportiva o recreativa" and t in VERDE):
            for parte in it.get("p", []):
                lo, la = np.array(parte[0::2]), np.array(parte[1::2])
                if len(la) < 3: continue
                x, y = fwd_np(la, lo)
                if g == "cuerpo de agua": wx.extend(x); wy.extend(y)
                else: vx.append(x.mean()); vy.append(y.mean()); va.append(area_pol(x, y))
    for it in ig.get("sil", []):
        if it.get("g") in ("corriente de agua", "canal"):
            for parte in it.get("p", []):
                lo, la = np.array(parte[0::2]), np.array(parte[1::2])
                if len(la): x, y = fwd_np(la, lo); wx.extend(x); wy.extend(y)
    for it in ig.get("sip", []):
        if it.get("g") == "instalacion deportiva o recreativa" and it.get("t") in VERDE and it.get("p"):
            pp = it["p"][0]; x, y = fwd_np(np.array([pp[1]]), np.array([pp[0]])); vx.append(x[0]); vy.append(y[0]); va.append(2500.0)
    if va:
        T = cKDTree(np.c_[vx, vy]); va = np.array(va)
        for i, idx in enumerate(T.query_ball_point(C, 1000.0)): nat[i, 0] = va[idx].sum() if idx else 0
    if wx:
        dd, _ = cKDTree(np.c_[wx, wy]).query(C, k=1, distance_upper_bound=20000.0); nat[:, 1] = np.where(np.isfinite(dd), dd, np.nan)
    ax, ay = [], []
    for i in range(int(math.floor(S / .1)), int(math.floor(N_ / .1)) + 1):
        for j in range(int(math.floor(W_ / .1)), int(math.floor(E_ / .1)) + 1):
            t = lee(sal, f"osm/nac/ent/{i}_{j}.json") if (i * 0 == 0) else None
            if not t: continue
            for nd_ in t.get("n", []):
                if nd_[2] == "t": ax.append(nd_[0]); ay.append(nd_[1])
    if ax:
        x, y = fwd_np(np.array(ax), np.array(ay))
        for i, idx in enumerate(cKDTree(np.c_[x, y]).query_ball_point(C, 500.0)): nat[i, 2] = len(idx)
    # salida
    r1 = lambda v: None if v is None or (isinstance(v, float) and not math.isfinite(v)) else round(float(v), 1)
    out = {}
    for i, k in enumerate(claves):
        out[k] = [giros[i].tolist(), [r1(v) for v in pot[i]], [None if not math.isfinite(v) else int(v) for v in pd[i]], [r1(v) for v in pi_[i]], [int(v) for v in apt[i]], [int(R[i]), int(Em[i]), int(Vm[i])], int(apea[i]), int(anc[i]),
                  [round(float(v), 2) for v in via[i]], None if not math.isfinite(dpri[i]) else int(dpri[i]), int(tipo[i]), int(tpct[i]), [int(nat[i, 0]), None if not math.isfinite(nat[i, 1]) else int(nat[i, 1]), int(nat[i, 2])]]
    meta = {"ent": ent, "nombre": NOMBRES[ent][3:], "agebs": n, "negocios": nd, "giros": GIROS, "apt": APT_N + ["Promedio"], "via": VCL_N, "tipos": tipos, "sigma_m": SIG,
            "campos": ["g", "pot", "pd", "pi", "apt", "afl", "apea", "anc", "via", "dpri", "tipo", "tpct", "nat"],
            "notas": ["g = negocios del DENUE asignados a la manzana más cercana (≤ 150 m) y de ahí a su AGEB.", "pot = Σ empleo equivalente (punto medio del rango de personal ocupado) · exp(−d²/2σ²) / (2πσ²), por km², σ = 300 m; total y por sector.",
                      "pd/pi: el polo de cada conjunto es el AGEB con mayor potencial en 3 km a la redonda (mínimo 5 % del máximo del estado); pd = distancia al polo más cercano (≤ 15 km), pi = 100 · potencial / potencial del polo.",
                      "apt = fórmula de Geo Lab (0.65·min(1, n/ref) + 0.35·(1 − d/800)) con el DENUE a 1 km en lugar de Google Places; 6 categorías y promedio.", "apea = 0.8·residentes + 0.8·empleados + 0.5·visitantes inferidos a ≤ 500 m (visitantes = empleados × factor por giro de Geo Lab); sin ajuste de contexto.",
                      "via = km de vialidad OSM por clase a ≤ 1 km; dpri = distancia a la vía primaria o superior más cercana.", "tipo = tipo de asentamiento del DENUE dominante (por población); tpct = % de la población de la AGEB en ese tipo.",
                      "nat = [m² de áreas verdes INEGI a ≤ 1 km, distancia al agua INEGI (m), árboles OSM a ≤ 500 m]. Las cifras de centro usan el centro de la AGEB (promedio de sus manzanas)."],
            "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "segundos": round(time.time() - t0)}
    b = sal.pon(f"malla/{ent}.json", {"meta": meta, "ageb": out}); log(ent, "LISTO:", n, "AGEB,", round(b / 1e6, 2), "MB,", meta["segundos"], "s")


def fusiona(sal):
    """referencias nacionales (percentil 98) para llevar a 0-100 los valores brutos"""
    P = defaultdict(list)
    for nm, d in lista(sal, "malla"):
        for r in d["ageb"].values(): P["apea"].append(r[6] / .785); P["pot"].append(r[1][0] or 0); P["via"].append(sum(r[8][i] * w for i, w in enumerate((5, 4, 3, 2, 1))))
    ref = {k: round(float(np.percentile(v, 98)), 1) for k, v in P.items() if v}
    sal.pon("malla/ref.json", {"p98": ref, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "nota": "apea y via: percentil 98 nacional entre AGEB; el índice 0-100 es min(100, valor / p98 · 100). via = Σ peso·km con pesos 5,4,3,2,1 por clase."}); log("referencias:", ref)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--estados", default=",".join(NOMBRES)); ap.add_argument("--local"); ap.add_argument("--bucket", default=BUCKET); ap.add_argument("--forzar", action="store_true"); ap.add_argument("--fusiona", action="store_true"); ap.add_argument("--datos-local")
    a = ap.parse_args(); sal = Salida(a.local, a.bucket); fallas = []
    if a.datos_local:
        if not a.local: sys.exit("--datos-local requiere --local")
        DATOS = a.datos_local
    else:
        from google.cloud import storage
        sal.b = storage.Client().bucket(a.bucket)
    if a.fusiona: fusiona(sal); sys.exit(0)
    ti, tn = int(os.environ.get("CLOUD_RUN_TASK_INDEX", 0)), int(os.environ.get("CLOUD_RUN_TASK_COUNT", 1))
    for ent in [e.strip().zfill(2) for e in a.estados.split(",") if e.strip()][ti::tn]:
        try:
            if not a.forzar and sal.existe(f"malla/{ent}.json"): log(ent, "ya está hecho, se salta"); continue
            calcula(ent, sal)
        except Exception as e:
            import traceback; traceback.print_exc(); log(ent, "FALLÓ:", repr(e)[:300]); fallas.append(ent)
    log("terminado. Fallas:", fallas or "ninguna"); sys.exit(1 if fallas else 0)
