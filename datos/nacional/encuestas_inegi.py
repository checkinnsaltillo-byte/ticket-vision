#!/usr/bin/env python3
"""Encuestas y censos de gobierno/seguridad/agro del INEGI (Indicadores, datos abiertos) → gs://check-in-493804-panel/inegi-enc/<prog>.json

Cada paquete «_00_csv.zip» del INEGI (masiva/indicadores/programas/<prog>/<año>/) trae la serie completa hasta ese año en formato largo
(cve_entidad, cve_municipio, id_indicador, indicador, año, valor, unidad_medida). Se toma el paquete válido más reciente de cada programa
(algunos años traen solo el diccionario, sin datos: se descartan) y se guarda compacto:
  {prog, nombre, nivel, paquete, indicadores:[[id, nombre, unidad]], entidades:{cve:nombre}, filas:[[cveEnt, cveMun, idxInd, año, valor]]}
Uso: python3 -I encuestas_inegi.py [--local CARPETA_ZIPS] [--subir]
"""
import argparse, csv, io, json, os, sys, urllib.request, zipfile
BASE = "https://www.inegi.org.mx/contenidos/masiva/indicadores/programas/%s/%s/%s_00_csv.zip"
PROGS = {  # prog: (nombre, años a probar de más nuevo a más viejo)
    "envipe": ("ENVIPE · Victimización y percepción de seguridad pública", range(2010, 2027)),
    "enve": ("ENVE · Victimización de empresas", range(2010, 2027)),
    "encig": ("ENCIG · Calidad e impacto gubernamental", range(2010, 2027)),
    "cngmd": ("CNGMD · Censo Nacional de Gobiernos Municipales y Demarcaciones de la CDMX", range(2010, 2027)),
    "cngspspe": ("CNGE · Censo Nacional de Gobierno, Seguridad Pública y Sistema Penitenciario Estatales", range(2010, 2027)),
    "cnpje": ("CNPJE · Censo Nacional de Procuración de Justicia Estatal", range(2010, 2027)),
    "cnije": ("CNIJE · Censo Nacional de Impartición de Justicia Estatal", range(2010, 2027)),
    "ensu": ("ENSU · Encuesta Nacional de Seguridad Pública Urbana", [2025]),
    "ena": ("ENA · Encuesta Nacional Agropecuaria", range(2010, 2027)),
}

def baja(url):
    try:
        r = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=120); return r.read()
    except Exception: return None

def valida(b):
    try: z = zipfile.ZipFile(io.BytesIO(b))
    except Exception: return None
    for n in z.namelist():
        l = n.lower()
        if l.endswith(".csv") and "valor" in l and "nota" not in l: return z.read(n)
    return None

def parsea(raw):
    try: t = raw.decode("utf-8-sig")
    except UnicodeDecodeError: t = raw.decode("latin1")
    R = csv.reader(io.StringIO(t)); h = next(R); ix = {k.strip(): i for i, k in enumerate(h)}
    inds, idx, ents, filas = [], {}, {}, []
    for r in R:
        if len(r) < len(h): continue
        try: v = float(r[ix["valor"]])
        except ValueError: continue
        iid = r[ix["id_indicador"]].strip()
        if iid not in idx: idx[iid] = len(inds); inds.append([iid, r[ix["indicador"]].strip(), r[ix["unidad_medida"]].strip()])
        ce = r[ix["cve_entidad"]].strip().zfill(2); cm = r[ix["cve_municipio"]].strip()
        cm = cm.zfill(3) if cm and cm != "0" else ""
        ents.setdefault(ce, r[ix["desc_entidad"]].strip())
        filas.append([ce, cm, idx[iid], (int(r[ix["año"]]) if r[ix["año"]].strip().isdigit() else r[ix["año"]].strip()), round(v, 4)])
    return inds, ents, filas

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--local"); ap.add_argument("--subir", action="store_true"); a = ap.parse_args()
    out = os.path.join(a.local or ".", "inegi-enc"); os.makedirs(out, exist_ok=True)
    for p, (nom, anios) in PROGS.items():
        # se juntan todos los paquetes válidos (del más viejo al más nuevo; el más nuevo corrige a los anteriores): algunos programas cambian de metodología y el último no trae toda la historia
        paqs = []
        for y in sorted(anios):
            f = os.path.join(a.local, "%s_%s.zip" % (p, y)) if a.local else None
            b = open(f, "rb").read() if f and os.path.exists(f) else (None if a.local else baja((BASE.replace("%s/%s/", "") % (p, p, p)) if p == "ensu" else BASE % (p, y, p)))
            raw = valida(b) if b else None
            if raw: paqs.append((y, raw))
        if not paqs: print(p, "sin paquete válido"); continue
        inds, idx, ents, datos = [], {}, {}, {}
        for y, raw in paqs:
            i2, e2, f2 = parsea(raw); ents.update(e2)
            for iid, n, u in i2:
                if iid not in idx: idx[iid] = len(inds); inds.append([iid, n, u])
            for ce, cm, k, an, v in f2: datos[(i2[k][0], ce, cm, an)] = v
        filas = [[ce, cm, idx[iid], an, v] for (iid, ce, cm, an), v in datos.items()]; mun = any(f[1] for f in filas)
        d = {"prog": p, "nombre": nom, "nivel": "municipal" if mun else "estatal", "paquetes": [y for y, _ in paqs], "indicadores": inds, "entidades": ents, "filas": filas}
        ruta = os.path.join(out, p + ".json"); json.dump(d, open(ruta, "w"), ensure_ascii=False, separators=(",", ":"))
        print(p, d["paquetes"], len(inds), "indicadores", len(filas), "filas", d["nivel"], round(os.path.getsize(ruta) / 1e6, 2), "MB")
    if a.subir: os.system("gcloud storage cp %s/*.json gs://check-in-493804-panel/inegi-enc/" % out)
main()
