#!/usr/bin/env python3
"""OpenStreetMap de todo México → Cloud Storage, listo para que el servidor lo cargue por zona (misma estructura que Saltillo/Monterrey).

Una sola pasada del archivo de México produce tres cosas:
  osm/nac/vial/<i>_<j>.json     red vial por CELDA de 0.5° con 0.25° de margen (i = piso(lat/0.5), j = piso(lng/0.5)); mismo formato que osm/vial-*.json
  osm/nac/uso/<i>_<j>.json      uso de suelo / comercios / ductos por celda (mismo formato que osm/uso-*.json)
  osm/nac/ent/<i>_<j>.json      entorno (árboles, luminarias, semáforos, POIs, edificios, vías férreas, agua…) por cuadro de 0.1° (mismo formato que osm/entorno*/)
  osm/nac/parts/<banda>.json    celdas y cuadros que escribió cada tarea (los junta --fusiona en los índices)
La tarea n de un Cloud Run Job procesa la banda de longitud n (4 bandas). Cada banda es independiente.
Uso: python3 -I osm_nacional.py            (tarea normal)
     python3 -I osm_nacional.py --fusiona  (al terminar las 4 tareas: escribe los índices)
"""
import osmium, json, time, os, math, collections, sys, urllib.request, datetime
from concurrent.futures import ThreadPoolExecutor

BUCKET = os.environ.get("BUCKET", "check-in-493804-panel")
PBF_URL = "https://download.geofabrik.de/north-america/mexico-latest.osm.pbf"
BANDAS = [(-119.0, -111.0), (-111.0, -103.0), (-103.0, -95.0), (-95.0, -85.0)]
LA0, LA1 = 14.0, 33.5          # latitudes de México
CE, MG = 0.5, 0.25             # celda y margen de vial/uso
C = 0.1                        # cuadro del entorno
ORIG = os.environ.get("PBF", "/tmp/mexico.osm.pbf")
LOCAL = os.environ.get("SALIDA_LOCAL")   # prueba: escribe en disco en vez de Cloud Storage


def log(*a): print(time.strftime("%H:%M:%S"), *a, flush=True)
def enc(pts):
    out = []; la = ln = 0
    def v(d):
        d = ~(d << 1) if d < 0 else d << 1; s = ""
        while d >= 0x20: s += chr((0x20 | (d & 0x1f)) + 63); d >>= 5
        return s + chr(d + 63)
    for a, b in pts:
        ia, ib = round(a * 1e6), round(b * 1e6); out.append(v(ia - la) + v(ib - ln)); la, ln = ia, ib
    return "".join(out)


def baja():
    if os.environ.get("PBF") or (os.path.exists(ORIG) and os.path.getsize(ORIG) > 3e8): return
    for i in range(6):
        try:
            rq = urllib.request.Request(PBF_URL, headers={"User-Agent": "checkinn-geometrika/1.0"})
            with urllib.request.urlopen(rq, timeout=300) as r, open(ORIG, "wb") as f:
                while True:
                    b = r.read(1 << 22)
                    if not b: break
                    f.write(b)
            return
        except Exception as e: log("reintento descarga", i + 1, e); time.sleep(10 * (i + 1))
    raise RuntimeError("no se pudo bajar el archivo de México")


def celdas(lat, lng):   # celdas (0.5°) cuya caja con margen contiene el punto
    return [(i, j) for i in range(math.floor((lat - MG) / CE), math.floor((lat + MG) / CE) + 1) for j in range(math.floor((lng - MG) / CE), math.floor((lng + MG) / CE) + 1)]
def celdas_vias(pts):   # unión de celdas de todos los puntos (por cuartos de grado para no repetir cálculo)
    q = {(math.floor(a / .25), math.floor(b / .25)) for a, b in pts}; out = set()
    for qa, qb in q:
        for i in range(math.floor((qa * .25 - MG) / CE), math.floor(((qa + 1) * .25 + MG) / CE) + 1):
            for j in range(math.floor((qb * .25 - MG) / CE), math.floor(((qb + 1) * .25 + MG) / CE) + 1): out.add((i, j))
    return out


def tarea(n):
    lo, hi = BANDAS[n]; mlo, mhi = lo - .4, hi + .4
    suyas = lambda j: lo <= j * CE < hi         # celda 0.5° de esta banda
    suyo = lambda j: lo <= j * C < hi - 1e-9    # cuadro 0.1° de esta banda
    log("banda", n, lo, hi, "bajando México…"); baja(); log("archivo listo", round(os.path.getsize(ORIG) / 1e6), "MB")
    EXC = {"footway", "steps", "path", "corridor", "elevator", "proposed", "construction", "bridleway", "platform"}
    KEEP = {"highway", "name", "ref", "oneway", "junction", "lanes", "lanes:forward", "lanes:backward", "maxspeed", "width", "surface", "bridge", "tunnel", "layer", "sidewalk", "service", "access", "lit"}
    AM = {"school", "kindergarten", "college", "university", "hospital", "clinic", "bank", "restaurant", "marketplace", "fuel", "pharmacy", "cafe", "townhall"}; LU = {"residential", "commercial", "retail", "industrial"}
    KN = {"natural": {"tree": "t"}, "highway": {"street_lamp": "l", "traffic_signals": "s", "crossing": "c", "bus_stop": "b"}, "public_transport": {"platform": "p"}, "power": {"tower": "w"}}
    TN = {"crossing", "crossing:markings", "tactile_paving", "kerb", "name", "shelter", "bench", "public_transport", "voltage", "highway", "natural", "power"}
    TW = {"building", "building:levels", "height", "name", "power", "railway", "waterway"}
    AMP = {"hospital", "clinic", "school", "university", "college", "place_of_worship", "townhall", "marketplace", "police", "fire_station", "library", "theatre", "cinema", "bus_station", "fuel"}; SH = {"mall", "supermarket", "department_store"}; LE = {"park", "stadium", "sports_centre", "garden"}; TO = {"hotel", "attraction", "museum"}
    PT = ("amenity", "shop", "leisure", "tourism", "place", "name", "building")
    def poi(t): return t.get("amenity") in AMP or t.get("shop") in SH or t.get("leisure") in LE or t.get("tourism") in TO or t.get("place") == "square"
    tk = lambda a, b: f"{math.floor(a / C)}_{math.floor(b / C)}"
    vial = collections.defaultdict(list); usoN = collections.defaultdict(list); usoW = collections.defaultdict(list)
    ent = collections.defaultdict(lambda: {"n": [], "w": [], "p": [], "a": []})
    t0 = time.time(); nv = nw = nn = 0
    fp = osmium.FileProcessor(ORIG, osmium.osm.NODE | osmium.osm.WAY).with_locations("sparse_file_array,/tmp/idx.bin").with_filter(osmium.filter.KeyFilter(
        "highway", "natural", "public_transport", "power", "building", "railway", "waterway", "amenity", "shop", "leisure", "tourism", "place", "office", "landuse", "man_made"))
    for o in fp:
        t = o.tags
        if o.is_node():
            la, lo_ = o.location.lat, o.location.lon
            if not (LA0 <= la <= LA1 and mlo <= lo_ <= mhi): continue
            # uso: comercios / oficinas / amenidades
            if t.get("shop") or t.get("office") or t.get("amenity") in AM:
                for i, j in celdas(la, lo_):
                    if suyas(j): usoN[(i, j)].append([round(la, 6), round(lo_, 6)])
            if not suyo(math.floor(lo_ / C)): continue
            if poi(t): ent[tk(la, lo_)]["p"].append([round(la, 6), round(lo_, 6), {a.k: a.v for a in t if a.k in PT}])
            k = None
            for key, m in KN.items():
                v = t.get(key)
                if v in m: k = m[v]; break
            if not k or (k == "w" and not t.get("voltage")): continue
            ent[tk(la, lo_)]["n"].append([round(la, 6), round(lo_, 6), k, {a.k: a.v for a in t if a.k in TN and a.k not in ("highway", "natural", "power")}]); nn += 1
        elif o.is_way():
            try: pts = [(x.lat, x.lon) for x in o.nodes if x.location.valid()]
            except Exception: continue
            if len(pts) < 2: continue
            if not any(LA0 <= a <= LA1 and mlo <= b <= mhi for a, b in pts): continue
            hw = t.get("highway"); b_ = t.get("building")
            # vial
            if hw and hw not in EXC:
                w = {"i": o.id, "t": {a.k: a.v for a in t if a.k in KEEP or a.k.startswith("parking:")}, "g": enc(pts)}
                for c in celdas_vias(pts):
                    if suyas(c[1]): vial[c].append(w)
                nv += 1
            # uso: landuse y ductos
            if (t.get("landuse") in LU or t.get("man_made") == "pipeline") and len(pts) >= 3:
                w = {"i": o.id, "t": ({"man_made": "pipeline"} if t.get("man_made") == "pipeline" else {"landuse": t.get("landuse")}), "g": enc(pts)}
                for c in celdas_vias(pts):
                    if suyas(c[1]): usoW[c].append(w)
            # entorno
            ak = None; sub = ""
            if t.get("amenity") == "parking" and t.get("location") != "underground": ak = "parking"; sub = t.get("parking", "")
            elif t.get("leisure") == "pitch": ak = "pitch"; sub = t.get("sport", "")
            elif t.get("leisure") == "track": ak = "track"; sub = t.get("sport", "")
            elif t.get("leisure") == "swimming_pool": ak = "pool"
            elif t.get("power") in ("generator", "plant") and (t.get("generator:source") == "solar" or t.get("plant:source") == "solar"): ak = "solar"
            if ak and len(pts) >= 4 and suyo(math.floor(pts[0][1] / C)) and LA0 <= pts[0][0] <= LA1:
                ent[tk(*pts[0])]["a"].append({"i": o.id, "k": ak, "s": sub.split(";")[0][:20], "g": enc(pts)})
            if poi(t):
                ca = sum(a for a, c in pts) / len(pts); co = sum(c for a, c in pts) / len(pts)
                if suyo(math.floor(co / C)) and LA0 <= ca <= LA1: ent[tk(ca, co)]["p"].append([round(ca, 6), round(co, 6), {a.k: a.v for a in t if a.k in PT}])
            pw = t.get("power") == "line"; rw = t.get("railway") == "rail"; wt = t.get("waterway") in ("river", "stream", "canal", "drain")
            if not (b_ or pw or rw or wt): continue
            if b_:
                if len(pts) < 4: continue
                keys = {tk(*pts[0])} if suyo(math.floor(pts[0][1] / C)) and LA0 <= pts[0][0] <= LA1 else set()
            else:
                keys = {tk(a, c) for a, c in pts if LA0 <= a <= LA1 and suyo(math.floor(c / C))}
            if not keys: continue
            w = {"i": o.id, "t": {a.k: a.v for a in t if a.k in TW}, "g": enc(pts)}
            for kk in keys: ent[kk]["w"].append(w)
            nw += 1
            if nw % 500000 == 0: log("banda", n, "vías de entorno", nw, "· vial", nv, "·", round(time.time() - t0), "s")
    log("banda", n, "lectura terminada:", nv, "vías,", nn, "nodos,", nw, "elementos de entorno,", round(time.time() - t0), "s · subiendo…")
    at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if LOCAL: b = None
    else:
        from google.cloud import storage
        b = storage.Client().bucket(BUCKET)
    def sube(ruta, obj):
        datos = json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        if LOCAL:
            p = os.path.join(LOCAL, ruta); os.makedirs(os.path.dirname(p), exist_ok=True); open(p, "wb").write(datos)
        else: b.blob(ruta).upload_from_string(datos, content_type="application/json")
    tareas = []
    for (i, j), L in vial.items():
        S, W = i * CE - MG, j * CE - MG
        tareas.append((f"osm/nac/vial/{i}_{j}.json", {"at": at, "bbox": [S, W, S + CE + 2 * MG, W + CE + 2 * MG], "fuente": "OpenStreetMap (Geofabrik México), highway sin footway/steps/path…", "ways": L}))
    for c in set(usoN) | set(usoW):
        i, j = c; S, W = i * CE - MG, j * CE - MG
        tareas.append((f"osm/nac/uso/{i}_{j}.json", {"at": at, "bbox": [S, W, S + CE + 2 * MG, W + CE + 2 * MG], "nodes": usoN.get(c, []), "ways": usoW.get(c, [])}))
    for k, v in ent.items(): tareas.append((f"osm/nac/ent/{k}.json", v))
    with ThreadPoolExecutor(16) as ex: list(ex.map(lambda x: sube(*x), tareas))
    sube(f"osm/nac/parts/{n}.json", {"at": at, "vial": sorted(f"{i}_{j}" for i, j in vial), "uso": sorted(f"{i}_{j}" for i, j in set(usoN) | set(usoW)), "ent": sorted(ent)})
    log("banda", n, "LISTA:", len(vial), "celdas vial,", len(set(usoN) | set(usoW)), "de uso,", len(ent), "cuadros de entorno ·", round(time.time() - t0), "s")


def fusiona():
    from google.cloud import storage
    b = storage.Client().bucket(BUCKET); P = [json.loads(b.blob(f"osm/nac/parts/{n}.json").download_as_bytes()) for n in range(len(BANDAS))]
    at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    def sube(ruta, obj): b.blob(ruta).upload_from_string(json.dumps(obj, separators=(",", ":")).encode("utf-8"), content_type="application/json")
    sube("osm/nac/vial/index.json", {"at": at, "celda": CE, "margen": MG, "celdas": sorted({c for p in P for c in p["vial"]})})
    sube("osm/nac/uso/index.json", {"at": at, "celda": CE, "margen": MG, "celdas": sorted({c for p in P for c in p["uso"]})})
    sube("osm/nac/ent/index.json", {"at": at, "bbox": [LA0, -119.0, LA1, -85.0], "celda": C, "tiles": sorted({c for p in P for c in p["ent"]})})
    log("índices escritos")


if __name__ == "__main__":
    if "--fusiona" in sys.argv: fusiona()
    else: tarea(int(os.environ.get("CLOUD_RUN_TASK_INDEX", 0)))
