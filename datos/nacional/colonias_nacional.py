#!/usr/bin/env python3
"""Colonias (asentamientos humanos) de TODO México a partir del DENUE del INEGI, listas de antemano en Cloud Storage.

Igual que el piloto de Saltillo y Monterrey (colonias_prep.py): cada establecimiento trae el nombre de su asentamiento (colonia), tipo y código postal; se agrupan por colonia y se condensan en celdas de ~40 m (colonia dominante por celda) para inferir el territorio. INEGI no publica polígonos de colonias.
Salida: colonias/<ent>/<i>_<j>.json  (celdas de 0.2°: {"c":[[nombre,tipo,municipio,cp],…],"p":[[lat,lng,índice],…]}) y colonias/<ent>/index.json (marca de «terminado»).
Uso: python3 -I colonias_nacional.py [--estados 05,19] [--local CARPETA] [--forzar] [--trabajo /tmp/col]   (Cloud Run Jobs: cada tarea toma los estados que le tocan)
"""
import argparse, csv, io, json, math, os, re, shutil, sys, time, unicodedata, zipfile
from collections import defaultdict
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nacional import baja, log, DENUE, NOMBRES, Salida
CELDA = 0.2
sa = lambda t: ''.join(c for c in unicodedata.normalize('NFD', t) if unicodedata.category(c) != 'Mn')
MIN = {'de', 'del', 'la', 'las', 'los', 'el', 'y', 'e', 'en', 'a', 'al'}
def tit(s):
    w = re.sub(r'\s+', ' ', (s or '').strip()).lower().split(' ')
    return ' '.join(x if (i and x in MIN) else (x[:1].upper() + x[1:]) for i, x in enumerate(w))
TIPOS = {'Fraccionamiento': 'Fracc.', 'Unidad habitacional': 'U. hab.', 'Colonia': 'Col.', 'Barrio': 'Barrio', 'Condominio': 'Cond.', 'Ejido': 'Ejido', 'Parque industrial': 'Parque industrial', 'Zona industrial': 'Zona industrial', 'Pueblo': 'Pueblo', 'Rancho o ranchería': 'Rancho', 'Residencial': 'Resid.'}
def tipo(s): t = tit(s); return TIPOS.get(t, t)

def estado(ent, sal, trabajo):
    t0 = time.time(); d = os.path.join(trabajo, ent); shutil.rmtree(d, ignore_errors=True); os.makedirs(d); dz = []
    try: dz.append(baja(DENUE % ent, f"{d}/denue.zip"))
    except RuntimeError:
        for k in range(1, 9):
            try: dz.append(baja(DENUE % f"{ent}_{k}", f"{d}/denue{k}.zip"))
            except RuntimeError: break
    if not dz: raise RuntimeError("sin archivos DENUE para " + ent)
    idx = {}; names = []; cps = []; tps = []; acc = []; pts = {}; n = 0
    for zp in dz:
        with zipfile.ZipFile(zp) as z:
            for nom in z.namelist():
                if not nom.lower().endswith(".csv") or "conjunto_de_datos" not in nom.lower() or "bitacora" in nom.lower(): continue
                with z.open(nom) as f:
                    for r in csv.DictReader(io.TextIOWrapper(f, encoding="latin-1", errors="replace", newline="")):
                        try: la, lo = float(r['latitud']), float(r['longitud'])
                        except (ValueError, KeyError): continue
                        nm = (r.get('nomb_asent') or '').strip()
                        if not nm or nm.upper() in ('NINGUNO', 'SIN DATO', 'NO ESPECIFICADO'): continue
                        k = (re.sub(r'\s+', ' ', sa(nm).upper()), r['cve_ent'].zfill(2) + r['cve_mun'].zfill(3))
                        if k not in idx: idx[k] = len(names); names.append(['', '', tit(r.get('municipio')), '']); cps.append({}); tps.append({}); acc.append({})
                        i = idx[k]; tt = tipo(r.get('tipo_asent')); tps[i][tt] = tps[i].get(tt, 0) + 1; nn = tit(nm); acc[i][nn] = acc[i].get(nn, 0) + 1; cp = (r.get('cod_postal') or '').strip(); cps[i][cp] = cps[i].get(cp, 0) + 1
                        dd = pts.setdefault((math.floor(la / 0.00036), math.floor(lo / 0.00040)), {}); dd[i] = dd.get(i, 0) + 1; n += 1
    log(ent, "establecimientos con colonia:", n, "· colonias:", len(names), "· celdas:", len(pts))
    for i in range(len(names)):
        names[i][3] = max(cps[i], key=cps[i].get) if cps[i] else ''; names[i][1] = max(tps[i], key=tps[i].get); names[i][0] = max(acc[i], key=lambda q: (any(ch in q for ch in 'áéíóúÁÉÍÓÚñ'), acc[i][q]))
    tiles = defaultdict(list)
    for (cy, cx), dd in pts.items():
        la, lo = round((cy + .5) * 0.00036, 5), round((cx + .5) * 0.00040, 5); tiles[(math.floor(la / CELDA), math.floor(lo / CELDA))].append([la, lo, max(dd, key=dd.get)])
    celdas = []
    for (i, j), P in tiles.items():
        usados = sorted({p[2] for p in P}); rm = {o: k for k, o in enumerate(usados)}
        sal.pon(f"colonias/{ent}/{i}_{j}.json", {"c": [names[o] for o in usados], "p": [[a, b, rm[c]] for a, b, c in P]}); celdas.append(f"{i}_{j}")
    sal.pon(f"colonias/{ent}/index.json", {"ent": ent, "nombre": NOMBRES[ent][3:], "celdas": sorted(celdas), "colonias": len(names), "celdas_40m": len(pts), "celda_m": 40, "fuente": "INEGI · DENUE: nombre de asentamiento (colonia) de cada establecimiento; territorio inferido", "at": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), "segundos": round(time.time() - t0)})
    shutil.rmtree(d, ignore_errors=True); log(ent, "LISTO:", len(names), "colonias en", len(celdas), "celdas,", round(time.time() - t0), "s")

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--estados", default=",".join(NOMBRES)); ap.add_argument("--local"); ap.add_argument("--bucket", default="check-in-493804-panel"); ap.add_argument("--forzar", action="store_true"); ap.add_argument("--trabajo", default="/tmp/col")
    a = ap.parse_args(); sal = Salida(a.local, a.bucket); fallas = []
    ti, tn = int(os.environ.get("CLOUD_RUN_TASK_INDEX", 0)), int(os.environ.get("CLOUD_RUN_TASK_COUNT", 1))
    for ent in [e.strip().zfill(2) for e in a.estados.split(",") if e.strip()][ti::tn]:
        try:
            if not a.forzar and sal.existe(f"colonias/{ent}/index.json"): log(ent, "ya está hecho, se salta"); continue
            estado(ent, sal, a.trabajo)
        except Exception as e:
            import traceback; traceback.print_exc(); log(ent, "FALLÓ:", repr(e)[:300]); fallas.append(ent)
    log("terminado. Fallas:", fallas or "ninguna"); sys.exit(1 if fallas else 0)
