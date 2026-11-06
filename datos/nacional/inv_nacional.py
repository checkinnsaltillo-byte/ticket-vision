#!/usr/bin/env python3
"""Entorno urbano de INEGI (Inventario Nacional de Viviendas 2020) de todo México → Cloud Storage.

Por estado baja «Frentes de manzana» y «Manzanas» (INV 2020, entorno urbano del Censo 2020) y publica por municipio:
  inv/fte/<ent>/<entmun>.json   frentes de manzana: geometría (polilínea 1e6) + 21 características del entorno urbano
  inv/mza/<ent>/<entmun>.json   manzanas: indicadores de vivienda/escolaridad, entorno por manzana y nivel socioeconómico estimado
  inv/estado-<ent>.json         resumen del estado (marca de «terminado»)
Reanudable: si inv/estado-<ent>.json existe, el estado se salta (--forzar para rehacerlo).
Uso: python3 -I inv_nacional.py [--estados 01,02,…] [--local CARPETA] [--forzar] [--trabajo CARPETA]
"""
import io, json, math, os, shutil, struct, sys, time, urllib.request, urllib.error, zipfile, argparse, datetime

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
URL = "https://www.inegi.org.mx/contenidos/masiva/indicadores/inv/%s_%s_INV2020_shp.zip"
# orden fijo de las 21 características por frente (cada una un dígito: 1 sí/pavimento · 2 empedrado (solo recubrimiento) · 3 no · 7 conjunto habitacional · 8 no aplica (rasgo) · 9 no especificado)
ATT = ["RECUCALL", "RAMPAS", "PASOPEAT", "BANQUETA", "GUARNICI", "CICLOVIA", "CICLOCAR", "ALUMPUB", "LETRERO", "TELPUB", "ARBOLES", "SEMAPEAT", "SEMAAUDI", "PARATRAN", "ESTABICI", "DRENAJEP", "TRANSCOL", "RESTPEAT", "RESTAUTO", "PUESTOSF", "PUESTOAM"]
# en manzana: mismas características con sufijo _C (1 todas las vialidades · 2 alguna · 3 ninguna · 7 conjunto habitacional · 8 no aplica · 9 no especificado)
NUM = ["POBTOT", "GRAPROES", "VIVTOT", "TVIPAHAB", "PROM_OCUP", "PRO_OCUP_C", "V3MASOCU_P", "VPH_PIDT_P", "VPH_C_EL_P", "VPH_EXSA_P", "VPH_DREN_P", "P_CD_P", "P_60YMAS_P"]
EST = {"01": "aguascalientes", "02": "bajacalifornia", "03": "bajacaliforniasur", "04": "campeche", "05": "coahuila", "06": "colima", "07": "chiapas", "08": "chihuahua", "09": "cdmx", "10": "durango", "11": "guanajuato", "12": "guerrero", "13": "hidalgo", "14": "jalisco", "15": "mexico", "16": "michoacan", "17": "morelos", "18": "nayarit", "19": "nuevoleon", "20": "oaxaca", "21": "puebla", "22": "queretaro", "23": "quintanaroo", "24": "sanluispotosi", "25": "sinaloa", "26": "sonora", "27": "tabasco", "28": "tamaulipas", "29": "tlaxcala", "30": "veracruz", "31": "yucatan", "32": "zacatecas"}


def log(*a): print(time.strftime("%H:%M:%S"), *a, flush=True)
def baja(url, dest, intentos=6):
    for i in range(intentos):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=180) as r, open(dest, "wb") as f:
                if "text/html" in (r.headers.get("Content-Type") or ""): raise RuntimeError("HTML: no existe " + url)
                while True:
                    b = r.read(1 << 20)
                    if not b: break
                    f.write(b)
            if zipfile.is_zipfile(dest): return dest
            raise RuntimeError("zip incompleto")
        except Exception as e:
            log("  reintento", i + 1, url[-34:], str(e)[:100]); time.sleep(6 * (i + 1))
            if "no existe" in str(e): break
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
def enc(pts):
    out = []; la = ln = 0
    def v(d):
        d = ~(d << 1) if d < 0 else d << 1; s = ""
        while d >= 0x20: s += chr((0x20 | (d & 0x1f)) + 63); d >>= 5
        return s + chr(d + 63)
    for a, b in pts:
        ia, ib = round(a * 1e6), round(b * 1e6); out.append(v(ia - la) + v(ib - ln)); la, ln = ia, ib
    return "".join(out)


def leer_dbf(ruta):
    d = open(ruta, "rb").read(); n = struct.unpack("<I", d[4:8])[0]; hl = struct.unpack("<H", d[8:10])[0]; rl = struct.unpack("<H", d[10:12])[0]
    campos = []; o = 32
    while d[o] != 0x0D: campos.append((d[o:o + 11].split(b"\0")[0].decode("latin-1"), d[o + 16])); o += 32
    for i in range(n):
        r = d[hl + i * rl: hl + (i + 1) * rl]
        if r[0:1] == b"*": yield None; continue
        p = 1; reg = {}
        for nom, ln in campos: reg[nom] = r[p:p + ln].decode("utf-8", "replace").strip(); p += ln
        yield reg
def leer_shp(ruta):
    d = open(ruta, "rb").read(); o = 100; L = len(d)
    while o + 8 <= L:
        cl = struct.unpack(">i", d[o + 4:o + 8])[0] * 2; b = d[o + 8:o + 8 + cl]; o += 8 + cl; t = struct.unpack("<i", b[:4])[0]
        if t == 0: yield None; continue
        npart, npts = struct.unpack("<2i", b[36:44]); partes = list(struct.unpack("<%di" % npart, b[44:44 + 4 * npart])) + [npts]; q = 44 + 4 * npart
        pts = struct.unpack("<%dd" % (2 * npts), b[q:q + 16 * npts])
        yield [[(pts[2 * i], pts[2 * i + 1]) for i in range(partes[k], partes[k + 1])] for k in range(npart)]
def num(v):
    try: return float(v)
    except Exception: return None
def r1(v, k=1): return None if v is None else (round(v, k) if k else int(round(v)))


class Salida:
    def __init__(self, local, bucket):
        self.local = local
        if not local:
            from google.cloud import storage
            self.b = storage.Client().bucket(bucket)
    def existe(self, ruta): return os.path.exists(os.path.join(self.local, ruta)) if self.local else self.b.blob(ruta).exists()
    def pon(self, ruta, obj):
        datos = json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        if self.local: p = os.path.join(self.local, ruta); os.makedirs(os.path.dirname(p), exist_ok=True); open(p, "wb").write(datos)
        else: self.b.blob(ruta).upload_from_string(datos, content_type="application/json")
        return len(datos)


def cuartiles(v):
    s = sorted(x for x in v if x is not None)
    if not s: return None
    q = lambda p: s[min(len(s) - 1, int(p * len(s)))]
    return [q(.25), q(.5), q(.75)]


def estado(ent, sal, trabajo, forzar):
    marca = f"inv/estado-{ent}.json"
    if not forzar and sal.existe(marca): log(ent, "ya está hecho, se salta"); return
    t0 = time.time(); d = os.path.join(trabajo, ent); shutil.rmtree(d, ignore_errors=True); os.makedirs(d)
    zf = baja(URL % (ent, "Frentes"), f"{d}/fr.zip"); zm = baja(URL % (ent, "Manzanas"), f"{d}/mz.zip")
    for z, sub in ((zf, "fr"), (zm, "mz")):
        with zipfile.ZipFile(z) as zz:
            for n in zz.namelist():
                if n.lower().endswith((".shp", ".dbf")): os.makedirs(f"{d}/{sub}", exist_ok=True); open(f"{d}/{sub}/{os.path.basename(n)}", "wb").write(zz.read(n))
    # ── frentes de manzana ───────────────────────────────────────────────────────────────────────────────────
    base = [x for x in os.listdir(f"{d}/fr") if x.endswith(".shp")][0][:-4]; porMun = {}; nf = 0
    for rg, g in zip(leer_dbf(f"{d}/fr/{base}.dbf"), leer_shp(f"{d}/fr/{base}.shp")):
        if rg is None or not g: continue
        pts = [inv(x, y) for part in g for x, y in part]
        if len(pts) < 2: continue
        # polilínea simplificada: conserva a lo más 12 puntos
        if len(pts) > 12: paso = (len(pts) - 1) / 11; pts = [pts[int(round(i * paso))] for i in range(12)]
        cod = "".join((rg.get(k) or "9")[:1] for k in ATT)
        porMun.setdefault(rg["CVE_ENT"] + rg["CVE_MUN"], []).append([rg["CVEGEO"], enc(pts), cod, (rg.get("TIPOVIAL") or "")[:14], (rg.get("NOMVIAL") or "")[:36], (rg.get("CLASEVIA_R") or "")[:2]]); nf += 1
    metaF = {"fuente": "INEGI · Inventario Nacional de Viviendas 2020 (entorno urbano, Censo 2020), frentes de manzana", "atts": ATT, "codigos": "1 sí o pavimento · 2 empedrado o adoquín (recubrimiento) · 3 no o sin recubrimiento · 7 conjunto habitacional · 8 no aplica (es un rasgo) · 9 no especificado", "campos": ["cvegeo manzana", "polilínea 1e6", "21 códigos", "tipo de vialidad", "nombre", "clase de vialidad"]}
    for cm, lst in porMun.items(): sal.pon(f"inv/fte/{ent}/{cm}.json", {"meta": {**metaF, "n": len(lst)}, "f": lst})
    log(ent, "frentes:", nf, "en", len(porMun), "municipios")
    # ── manzanas ─────────────────────────────────────────────────────────────────────────────────────────────
    base = [x for x in os.listdir(f"{d}/mz") if x.endswith(".dbf")][0][:-4]; regs = [r for r in leer_dbf(f"{d}/mz/{base}.dbf") if r is not None]
    def sc(r):   # puntaje de vivienda + escolaridad (mayor = mejor); cada rasgo estandarizado después con el estado completo
        return [num(r.get("GRAPROES")), num(r.get("VPH_PIDT_P")), num(r.get("VPH_C_EL_P")), num(r.get("VPH_EXSA_P")), num(r.get("VPH_DREN_P")), None if num(r.get("PRO_OCUP_C")) is None else -num(r.get("PRO_OCUP_C")), None if num(r.get("V3MASOCU_P")) is None else -num(r.get("V3MASOCU_P"))]
    cols = list(zip(*[sc(r) for r in regs])); mu = []; sd = []
    for c in cols:
        v = [x for x in c if x is not None]; m = sum(v) / len(v) if v else 0; s = math.sqrt(sum((x - m) ** 2 for x in v) / len(v)) if len(v) > 1 else 1
        mu.append(m); sd.append(s or 1)
    def z(r):
        t = [(x - mu[i]) / sd[i] for i, x in enumerate(sc(r)) if x is not None]
        return sum(t) / len(t) if len(t) >= 3 else None
    zz = [z(r) for r in regs]; qs = cuartiles(zz) or [0, 0, 0]
    pm = {}
    for r, zv in zip(regs, zz):
        nse = 0 if zv is None else 4 if zv >= qs[2] else 3 if zv >= qs[1] else 2 if zv >= qs[0] else 1   # 4 alto … 1 bajo (cuartiles del estado); 0 sin dato
        cod = "".join((r.get(k + "_C") or "9")[:1] for k in ATT)
        row = [r["CVEGEO"]] + [r1(num(r.get(k)), 1 if k in ("GRAPROES", "PROM_OCUP", "PRO_OCUP_C") else 0 if k in ("POBTOT", "VIVTOT", "TVIPAHAB") else 1) for k in NUM] + [cod, nse, None if zv is None else round(zv, 2)]
        pm.setdefault(r["CVE_ENT"] + r["CVE_MUN"], []).append(row)
    metaM = {"fuente": "INEGI · Inventario Nacional de Viviendas 2020 (indicadores de población, vivienda y entorno urbano por manzana)", "campos": ["cvegeo"] + NUM + ["21 códigos de entorno por manzana", "nivel socioeconómico estimado (4 alto … 1 bajo; 0 sin dato)", "puntaje z de vivienda y escolaridad"], "atts": ATT,
             "codigos": "1 todas las vialidades · 2 alguna · 3 ninguna · 7 conjunto habitacional · 8 no aplica · 9 no especificado",
             "nse": "Promedio de 7 rasgos estandarizados con todas las manzanas del estado (escolaridad, piso firme, electricidad, excusado, drenaje, hacinamiento, viviendas con 3+ ocupantes por cuarto); cortes por cuartiles del estado", "cortes_z": qs}
    for cm, lst in pm.items(): sal.pon(f"inv/mza/{ent}/{cm}.json", {"meta": {**metaM, "n": len(lst)}, "m": lst})
    log(ent, "manzanas:", len(regs), "en", len(pm), "municipios")
    sal.pon(marca, {"ent": ent, "at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "frentes": nf, "manzanas": len(regs), "municipios": sorted(set(porMun) | set(pm)), "cortes_z": qs, "segundos": round(time.time() - t0)})
    shutil.rmtree(d, ignore_errors=True); log(ent, "LISTO en", round(time.time() - t0), "s")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--estados", default=",".join(EST)); ap.add_argument("--local"); ap.add_argument("--bucket", default="check-in-493804-panel"); ap.add_argument("--forzar", action="store_true"); ap.add_argument("--trabajo", default="/tmp/inv")
    a = ap.parse_args(); sal = Salida(a.local, a.bucket); fallas = []
    ti, tn = int(os.environ.get("CLOUD_RUN_TASK_INDEX", 0)), int(os.environ.get("CLOUD_RUN_TASK_COUNT", 1))
    for ent in [e.strip().zfill(2) for e in a.estados.split(",") if e.strip()][ti::tn]:
        try: estado(ent, sal, a.trabajo, a.forzar)
        except Exception as e: log(ent, "FALLÓ:", repr(e)[:300]); fallas.append(ent)
    log("terminado. Fallas:", fallas or "ninguna"); sys.exit(1 if fallas else 0)
