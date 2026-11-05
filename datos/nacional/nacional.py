#!/usr/bin/env python3
"""Descarga masiva de datos gratuitos de INEGI para los 32 estados / 2,475 municipios de México.

Por estado descarga (con reintentos) el Marco Geoestadístico, el Censo 2020 por manzana y el DENUE, y publica en Cloud Storage:
  inegi/<ent>.json                     cartografía de servicios y ejes peatonales (mismo formato que usa /mercado/maqueta/inegi)
  censo/mun/<ent>/<entmun>.json        manzanas con pirámide de edad (mismo formato que censo/manzanas-<región>.json)
  denue/mun/<ent>/<entmun>.json        establecimientos del DENUE (mismo formato que maqueta/data/denue_*.json)
  nacional/estado-<ent>.json           resumen del estado (municipios, cuentas, cajas) — sirve de índice y de marca de «terminado»

Es reanudable: si nacional/estado-<ent>.json existe, el estado se salta (usar --forzar para rehacerlo).
Uso:  python3 -I nacional.py [--estados 01,02,…] [--local CARPETA] [--bucket NOMBRE] [--forzar] [--trabajo CARPETA]
Con --local escribe en disco en vez de subir a Cloud Storage (prueba).
"""
import csv, io, json, math, os, re, shutil, struct, sys, time, unicodedata, urllib.request, urllib.error, zipfile, argparse, datetime

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
MG = "https://www.inegi.org.mx/contenidos/productos/prod_serv/contenidos/espanol/bvinegi/productos/geografia/marcogeo/794551132173/"
CENSO = "https://www.inegi.org.mx/contenidos/programas/ccpv/2020/datosabiertos/ageb_manzana/ageb_mza_urbana_%s_cpv2020_csv.zip"
DENUE = "https://www.inegi.org.mx/contenidos/masiva/denue/denue_%s_csv.zip"
NOMBRES = {"01": "01_aguascalientes", "02": "02_bajacalifornia", "03": "03_bajacaliforniasur", "04": "04_campeche", "05": "05_coahuiladezaragoza", "06": "06_colima", "07": "07_chiapas", "08": "08_chihuahua", "09": "09_ciudaddemexico", "10": "10_durango", "11": "11_guanajuato", "12": "12_guerrero", "13": "13_hidalgo", "14": "14_jalisco", "15": "15_mexico", "16": "16_michoacandeocampo", "17": "17_morelos", "18": "18_nayarit", "19": "19_nuevoleon", "20": "20_oaxaca", "21": "21_puebla", "22": "22_queretaro", "23": "23_quintanaroo", "24": "24_sanluispotosi", "25": "25_sinaloa", "26": "26_sonora", "27": "27_tabasco", "28": "28_tamaulipas", "29": "29_tlaxcala", "30": "30_veracruzignaciodelallave", "31": "31_yucatan", "32": "32_zacatecas"}
EXISTENTES = {"05", "19"}   # inegi/05.json y 19.json ya existen en producción: no se sobrescriben salvo --forzar


def log(*a): print(time.strftime("%H:%M:%S"), *a, flush=True)


# ── descarga con reintentos y reanudación ─────────────────────────────────────────────────────────────────────
def baja(url, dest, intentos=6):
    for i in range(intentos):
        try:
            hecho = os.path.getsize(dest) if os.path.exists(dest) else 0
            rq = urllib.request.Request(url, headers={"User-Agent": UA, **({"Range": "bytes=%d-" % hecho} if hecho else {})})
            with urllib.request.urlopen(rq, timeout=120) as r:
                if "text/html" in (r.headers.get("Content-Type") or ""): raise RuntimeError("respuesta HTML (el archivo no existe con ese nombre): " + url)
                modo = "ab" if (r.status == 206 and hecho) else "wb"
                with open(dest, modo) as f:
                    while True:
                        b = r.read(1 << 20)
                        if not b: break
                        f.write(b)
            if zipfile.is_zipfile(dest) or not dest.endswith(".zip"): return dest
            raise RuntimeError("zip incompleto")
        except urllib.error.HTTPError as e:
            if e.code == 416: return dest   # ya estaba completo
            err = e
        except Exception as e: err = e
        log("  reintento", i + 1, "de", url.split("/")[-1], "→", str(err)[:120]); time.sleep(5 * (i + 1))
        if "HTML" in str(err) or "no existe" in str(err): break
    raise RuntimeError("no se pudo bajar " + url)


# ── proyección Lambert cónica conforme (INEGI, GRS80) inversa ─────────────────────────────────────────────────
A = 6378137.0; F = 1 / 298.257222101; E2 = F * (2 - F); E = math.sqrt(E2)
def _m(p): return math.cos(p) / math.sqrt(1 - E2 * math.sin(p) ** 2)
def _t(p): s = math.sin(p); return math.tan(math.pi / 4 - p / 2) / ((1 - E * s) / (1 + E * s)) ** (E / 2)
P1, P2, P0, L0 = map(math.radians, (17.5, 29.5, 12.0, -102.0)); FE = 2500000.0
N = (math.log(_m(P1)) - math.log(_m(P2))) / (math.log(_t(P1)) - math.log(_t(P2)))
FF = _m(P1) / (N * _t(P1) ** N); RHO0 = A * FF * _t(P0) ** N
def inv(x, y):
    x -= FE; rho = math.copysign(math.hypot(x, RHO0 - y), N); th = math.atan2(x, RHO0 - y); t = (rho / (A * FF)) ** (1 / N); p = math.pi / 2 - 2 * math.atan(t)
    for _ in range(8): s = math.sin(p); p = math.pi / 2 - 2 * math.atan(t * ((1 - E * s) / (1 + E * s)) ** (E / 2))
    return math.degrees(p), math.degrees(th / N + L0)


# ── DBF y SHP sin librerías ──────────────────────────────────────────────────────────────────────────────────
def leer_dbf(ruta):
    d = open(ruta, "rb").read(); n = struct.unpack("<I", d[4:8])[0]; hl = struct.unpack("<H", d[8:10])[0]; rl = struct.unpack("<H", d[10:12])[0]
    campos = []; o = 32
    while d[o] != 0x0D: campos.append((d[o:o + 11].split(b"\0")[0].decode("latin-1"), d[o + 16])); o += 32
    for i in range(n):
        r = d[hl + i * rl: hl + (i + 1) * rl]
        if r[0:1] == b"*": yield None; continue
        p = 1; reg = {}
        for nom, ln in campos: reg[nom] = r[p:p + ln].decode("latin-1").strip(); p += ln
        yield reg
def leer_shp(ruta):
    d = open(ruta, "rb").read(); o = 100; L = len(d)
    while o + 8 <= L:
        cl = struct.unpack(">i", d[o + 4:o + 8])[0] * 2; b = d[o + 8:o + 8 + cl]; o += 8 + cl; t = struct.unpack("<i", b[:4])[0]
        if t == 0: yield None; continue
        if t in (1, 11, 21): x, y = struct.unpack("<2d", b[4:20]); yield ("P", [[(x, y)]]); continue
        npart, npts = struct.unpack("<2i", b[36:44]); partes = list(struct.unpack("<%di" % npart, b[44:44 + 4 * npart])) + [npts]; q = 44 + 4 * npart
        pts = struct.unpack("<%dd" % (2 * npts), b[q:q + 16 * npts])
        yield ("L" if t in (3, 13, 23) else "A", [[(pts[2 * i], pts[2 * i + 1]) for i in range(partes[k], partes[k + 1])] for k in range(npart)])


def norm(s): return "".join(c for c in unicodedata.normalize("NFD", s.lower()) if unicodedata.category(c) != "Mn").strip()
def clean(s):
    s = s.strip(); return "" if norm(s) in ("ninguno", "no aplica", "ningno", "", "ninguo") else " ".join(s.split())
def num(v):
    try: return int(v)
    except Exception: return None
def area_f(r): return sum(r[i][0] * r[(i + 1) % len(r)][1] - r[(i + 1) % len(r)][0] * r[i][1] for i in range(len(r))) / 2
def dp(pts, tol):   # Douglas–Peucker sobre un anillo abierto
    if len(pts) < 4: return pts
    a, b = pts[0], pts[-1]; dx, dy = b[0] - a[0], b[1] - a[1]; L = math.hypot(dx, dy) or 1e-9; k, md = 0, -1
    for i in range(1, len(pts) - 1):
        dd = abs(dy * pts[i][0] - dx * pts[i][1] + b[0] * a[1] - b[1] * a[0]) / L
        if dd > md: md, k = dd, i
    if md > tol: return dp(pts[:k + 1], tol)[:-1] + dp(pts[k:], tol)
    return [a, b]


# ── 1) cartografía INEGI (servicios en área/línea/punto + ejes peatonales) ───────────────────────────────────────
def conv_inegi(cd, ent):
    def flat(pr):
        o = []
        for la, ln in pr: o += [ln, la]
        return o
    def conv(tag):
        for r, g in zip(leer_dbf(f"{cd}/{ent}{tag}.dbf"), leer_shp(f"{cd}/{ent}{tag}.shp")):
            if r is None or not g: continue
            yield r, [[inv(x, y) for x, y in pr] for pr in g[1]]
    res = {"sia": [], "sil": [], "sip": [], "e": []}
    for tag in ("sia", "sil", "sip"):
        for r, parts in conv(tag):
            d = {"g": norm(r["GEOGRAFICO"]), "t": norm(r["TIPO"]), "c": norm(r["CONDICION"]), "n": clean(r["NOMSERV"]), "gg": clean(r["GEOGRAFICO"]), "tt": clean(r["TIPO"])}
            d["p"] = [[round(v, 5) for v in flat(p)] for p in parts]; res[tag].append(d)
    for r, parts in conv("e"):   # solo los peatonales / andadores / callejones / pasajes (las calles vehiculares vienen de OSM)
        tv = norm(r["TIPOVIAL"]); se = norm(r["SENTIDO"])
        if se == "peatonal" or tv in ("andador", "peatonal", "pasaje", "corredor", "callejon", "viaducto", "eje vial"):
            res["e"].append({"tv": tv, "s": se, "n": clean(r["NOMVIAL"]), "tt": clean(r["TIPOVIAL"]), "gg": "Vialidad", "p": [[round(v, 5) for v in flat(p)] for p in parts]})
    allp = [(la, ln) for k in res for d in res[k] for p in d["p"] for la, ln in zip(p[1::2], p[0::2])]
    bb = [min(a for a, _ in allp), min(b for _, b in allp), max(a for a, _ in allp), max(b for _, b in allp)] if allp else None
    return {"ent": ent, "nombre": NOMBRES[ent][3:], "bbox": bb, "fuente": "INEGI · Marco Geoestadístico (capas de servicios y ejes viales)", **res}


# ── 2) manzanas con pirámide de edad por municipio ────────────────────────────────────────────────────────────
def conv_manzanas(cd, ent, csv_bytes_iter):
    filas = {}
    for x in csv_bytes_iter:
        if x.get("MZA", "000") in ("000", ""): continue
        filas[x["ENTIDAD"].zfill(2) + x["MUN"].zfill(3) + x["LOC"].zfill(4) + x["AGEB"] + x["MZA"].zfill(3)] = x
    PARES = [("P_0A2",), ("P_3A5",), ("P_6A11",), ("P_12A14", "P_15A17"), ("P_18A24",)]
    porMun = {}; sin_csv = 0
    for rg, g in zip(leer_dbf(f"{cd}/{ent}m.dbf"), leer_shp(f"{cd}/{ent}m.shp")):
        if rg is None or g is None: continue
        x = filas.get(rg.get("CVEGEO"))
        if x is None: sin_csv += 1; continue
        pt = num(x["POBTOT"])
        if not pt: continue
        rings = g[1]; AR = [area_f(r) for r in rings]; tA = sum(abs(a) for a in AR)
        if tA < 1: continue
        cx = sum(sum(p[0] for p in r) / len(r) * abs(a) for r, a in zip(rings, AR)) / tA; cy = sum(sum(p[1] for p in r) / len(r) * abs(a) for r, a in zip(rings, AR)) / tA
        lat, lng = inv(cx, cy)
        h = [0] * 7; m = [0] * 7
        for k, ps in enumerate(PARES):
            for p in ps: h[k] += num(x.get(p + "_M", "")) or 0; m[k] += num(x.get(p + "_F", "")) or 0
        h[6] = num(x.get("P_60YMAS_M", "")) or 0; m[6] = num(x.get("P_60YMAS_F", "")) or 0
        pm = num(x.get("POBMAS", "")); pf = num(x.get("POBFEM", ""))
        if pm is None or pf is None: pm = pt // 2; pf = pt - pm
        h[5] = max(0, pm - sum(h[:5]) - h[6]); m[5] = max(0, pf - sum(m[:5]) - m[6])
        k = max(range(len(rings)), key=lambda i: abs(AR[i])); ring = rings[k][:-1] if rings[k][0] == rings[k][-1] else rings[k]
        if len(ring) < 3: continue
        m0 = max(range(len(ring)), key=lambda i: math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]))
        s = dp(ring[:m0 + 1], 2.0)[:-1] + dp(ring[m0:] + [ring[0]], 2.0)[:-1]; poly = []
        for px, py in s: poly += [round((px - cx) * 10), round((py - cy) * 10)]
        a = []
        for q in range(7): a += [h[q], m[q]]
        porMun.setdefault(rg["CVEGEO"][:5], []).append([rg["CVEGEO"], round(lat, 6), round(lng, 6), poly, a, pt])
    return porMun, sin_csv


# ── 3) DENUE por municipio ───────────────────────────────────────────────────────────────────────────────────
G = [("Comercio al por menor", "#f472b6"), ("Comercio al por mayor", "#fb923c"), ("Restaurantes y hospedaje", "#facc15"), ("Servicios financieros y seguros", "#22d3ee"),
     ("Profesionales, corporativos e inmobiliarios", "#818cf8"), ("Salud y asistencia social", "#4ade80"), ("Educación, cultura y esparcimiento", "#a78bfa"),
     ("Industria, construcción y primario", "#94a3b8"), ("Transporte, información y gobierno", "#38bdf8"), ("Otros servicios", "#f87171")]
def grupo(c):
    s = c[:2]
    if s == "46": return 0
    if s == "43": return 1
    if s == "72": return 2
    if s == "52": return 3
    if s in ("53", "54", "55", "56"): return 4
    if s == "62": return 5
    if s in ("61", "71"): return 6
    if s in ("11", "21", "22", "23", "31", "32", "33"): return 7
    if s in ("48", "49", "51", "93"): return 8
    return 9
def tam(t):
    m = re.match(r"(\d+)", t or ""); n = int(m.group(1)) if m else 0
    return 0 if n <= 5 else 1 if n <= 10 else 2 if n <= 30 else 3 if n <= 50 else 4 if n <= 100 else 5 if n <= 250 else 6
def conv_denue(zips):
    porMun = {}
    for zp in zips:
        with zipfile.ZipFile(zp) as z:
            for nom in z.namelist():
                if not nom.lower().endswith(".csv") or "conjunto_de_datos" not in nom.lower() or "bitacora" in nom.lower(): continue
                with z.open(nom) as f:
                    for r in csv.DictReader(io.TextIOWrapper(f, encoding="latin-1", errors="replace", newline="")):
                        try: la, lo = float(r["latitud"]), float(r["longitud"])
                        except (ValueError, KeyError): continue
                        cm = (r["cve_ent"].zfill(2) + r["cve_mun"].zfill(3))
                        porMun.setdefault(cm, []).append([round(la, 5), round(lo, 5), grupo(r["codigo_act"]), tam(r["per_ocu"]), r["nom_estab"].strip().title()[:34], r["codigo_act"]])
    return porMun


# ── salida: disco o Cloud Storage ─────────────────────────────────────────────────────────────────────────────
class Salida:
    def __init__(self, local, bucket):
        self.local = local
        if not local:
            from google.cloud import storage
            self.b = storage.Client().bucket(bucket)
    def existe(self, ruta):
        if self.local: return os.path.exists(os.path.join(self.local, ruta))
        return self.b.blob(ruta).exists()
    def pon(self, ruta, obj):
        datos = json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        if self.local:
            p = os.path.join(self.local, ruta); os.makedirs(os.path.dirname(p), exist_ok=True); open(p, "wb").write(datos)
        else:
            self.b.blob(ruta).upload_from_string(datos, content_type="application/json")
        return len(datos)


def estado(ent, sal, trabajo, forzar):
    marca = f"nacional/estado-{ent}.json"
    if not forzar and sal.existe(marca): log(ent, "ya está hecho, se salta"); return
    t0 = time.time(); d = os.path.join(trabajo, ent); shutil.rmtree(d, ignore_errors=True); os.makedirs(d)
    log(ent, "descargando…")
    mgz = baja(MG + NOMBRES[ent] + ".zip", f"{d}/mg.zip"); cz = baja(CENSO % ent, f"{d}/censo.zip")
    dz = []
    try: dz.append(baja(DENUE % ent, f"{d}/denue.zip"))
    except RuntimeError:   # estados partidos en varios archivos (denue_15_1_csv, …)
        for k in range(1, 9):
            try: dz.append(baja(DENUE % f"{ent}_{k}", f"{d}/denue{k}.zip"))
            except RuntimeError: break
    if not dz: raise RuntimeError("sin archivos DENUE para " + ent)
    cd = f"{d}/cd"; os.makedirs(cd)
    with zipfile.ZipFile(mgz) as z:
        for n in z.namelist():
            if n.startswith("conjunto_de_datos/") and re.match(rf"conjunto_de_datos/{ent}(m|mun|sia|sil|sip|e)\.(shp|dbf)$", n): open(f"{cd}/{os.path.basename(n)}", "wb").write(z.read(n))
    nombres = {r["CVEGEO"]: r["NOMGEO"] for r in leer_dbf(f"{cd}/{ent}mun.dbf") if r}
    resumen = {"ent": ent, "nombre": NOMBRES[ent][3:], "at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "mun": {}}
    # cartografía
    if ent in EXISTENTES and not forzar: log(ent, "inegi/%s.json ya existe en producción, no se toca" % ent)
    else:
        o = conv_inegi(cd, ent); resumen["inegi_mb"] = round(sal.pon(f"inegi/{ent}.json", o) / 1e6, 1); log(ent, "cartografía", resumen["inegi_mb"], "MB"); del o
    # censo
    with zipfile.ZipFile(cz) as z:
        nom = next(n for n in z.namelist() if n.lower().endswith(".csv") and "/conjunto_de_datos/" in n.lower() and "bitacora" not in n.lower())
        with z.open(nom) as f: filas = list(csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig", errors="replace", newline="")))
    porMun, sin_csv = conv_manzanas(cd, ent, filas); del filas
    meta = {"fuente": "INEGI · Censo de Población y Vivienda 2020 (resultados por manzana)", "grupos": ["0 a 2", "3 a 5", "6 a 11", "12 a 17", "18 a 24", "25 a 59", "60 y más"], "orden": "hombres, mujeres por grupo", "poly": "decímetros respecto al centroide (este, norte)"}
    for cm, lst in porMun.items():
        sal.pon(f"censo/mun/{ent}/{cm}.json", {"meta": {**meta, "n": len(lst)}, "mz": lst})
        la = [m[1] for m in lst]; lo = [m[2] for m in lst]
        resumen["mun"].setdefault(cm, {"nombre": nombres.get(cm, cm)}).update({"manzanas": len(lst), "pob": sum(m[5] for m in lst), "bbox": [min(la), min(lo), max(la), max(lo)]})
    log(ent, "censo:", sum(len(v) for v in porMun.values()), "manzanas en", len(porMun), "municipios; sin cruce de CSV:", sin_csv)
    # DENUE
    dn = conv_denue(dz); dmeta = {"fuente": "INEGI · DENUE", "grupos": [{"n": n, "c": c} for n, c in G], "tamanos": ["0-5", "6-10", "11-30", "31-50", "51-100", "101-250", "251+"], "campos": ["lat", "lng", "grupo", "tamano", "nombre", "scian"]}
    for cm, lst in dn.items():
        sal.pon(f"denue/mun/{ent}/{cm}.json", {"meta": {**dmeta, "n": len(lst)}, "p": lst}); resumen["mun"].setdefault(cm, {"nombre": nombres.get(cm, cm)})["denue"] = len(lst)
    log(ent, "DENUE:", sum(len(v) for v in dn.values()), "establecimientos en", len(dn), "municipios")
    resumen["municipios_total"] = len(nombres); resumen["segundos"] = round(time.time() - t0)
    sal.pon(marca, resumen); shutil.rmtree(d, ignore_errors=True)
    log(ent, "LISTO en", resumen["segundos"], "s ·", len(resumen["mun"]), "de", len(nombres), "municipios con datos")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--estados", default=",".join(NOMBRES)); ap.add_argument("--local"); ap.add_argument("--bucket", default="check-in-493804-panel"); ap.add_argument("--forzar", action="store_true"); ap.add_argument("--trabajo", default="/tmp/nacional")
    a = ap.parse_args(); sal = Salida(a.local, a.bucket); fallas = []
    # Cloud Run Jobs: si hay varias tareas, cada una toma los estados que le tocan
    ti, tn = int(os.environ.get("CLOUD_RUN_TASK_INDEX", 0)), int(os.environ.get("CLOUD_RUN_TASK_COUNT", 1))
    lista = [e.strip().zfill(2) for e in a.estados.split(",") if e.strip()][ti::tn]
    for ent in lista:
        try: estado(ent, sal, a.trabajo, a.forzar)
        except Exception as e: log(ent, "FALLÓ:", repr(e)[:300]); fallas.append(ent)
    log("terminado. Fallas:", fallas or "ninguna")
    sys.exit(1 if fallas else 0)
