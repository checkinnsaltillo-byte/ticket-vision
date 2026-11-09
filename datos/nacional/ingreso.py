"""Ingreso mensual del hogar (estimado) por manzana / AGEB con el modelo de la ENIGH 2024 (enigh_modelo.py) y las variables del Censo 2020.
El modelo y la calibración viajan junto al script (enigh_modelo.json, ingreso_calibracion.json)."""
import json, math, os
AQUI = os.path.dirname(os.path.abspath(__file__))
M = json.load(open(os.path.join(AQUI, "enigh_modelo.json")))
CAL = json.load(open(os.path.join(AQUI, "ingreso_calibracion.json"))) if os.path.exists(os.path.join(AQUI, "ingreso_calibracion.json")) else {"C": 1.0, "cortes": []}
COEF = M["coef"]; K_SHRINK = 30.0
COLS_ING = ["VIVPAR_HAB", "VPH_PISOTI", "VPH_3YMASC", "PRO_OCUP_C", "VPH_AUTOM", "VPH_INTER", "VPH_PC", "VPH_STVP", "VPH_LAVAD", "VPH_HMICRO", "VPH_REFRI", "VPH_CEL", "VPH_TELEF", "VPH_CVJ", "GRAPROES", "HOGJEF_F", "TOTHOG", "POBHOG", "POCUPADA"]
def feats(r):
    v = r.get("VIVPAR_HAB"); th = r.get("TOTHOG")
    if not v or v <= 0 or not th or th <= 0: return None
    sh = lambda c: None if r.get(c) is None else min(1.0, max(0.0, r[c] / v))
    f = {"pt": sh("VPH_PISOTI"), "c3": sh("VPH_3YMASC"), "oc": r.get("PRO_OCUP_C"), "auto": sh("VPH_AUTOM"), "inter": sh("VPH_INTER"), "pc": sh("VPH_PC"), "stvp": sh("VPH_STVP"), "lav": sh("VPH_LAVAD"), "mic": sh("VPH_HMICRO"), "refri": sh("VPH_REFRI"), "cel": sh("VPH_CEL"), "telef": sh("VPH_TELEF"), "cvj": sh("VPH_CVJ"),
         "gp": r.get("GRAPROES"), "hf": None if r.get("HOGJEF_F") is None else min(1.0, r["HOGJEF_F"] / th), "tam": None if r.get("POBHOG") is None else r["POBHOG"] / th, "ocup": None if r.get("POCUPADA") is None else r["POCUPADA"] / th}
    return f if all(x is not None for x in f.values()) else None
def tam_loc(pob):
    return 1 if pob >= 100000 else 2 if pob >= 15000 else 3 if pob >= 2500 else 4
def log_ing(f, ent, tam):
    x = COEF["const"] + COEF.get("ent_" + ent, 0.0) + COEF.get("tam_%d" % tam, 0.0)
    for k in M["features"]: x += COEF[k] * f[k]
    return x
def log_estima(rm, ra, ent, tam):
    """log del ingreso crudo (sin calibrar): manzana comprimida hacia su AGEB según los hogares de la manzana."""
    fm = feats(rm) if rm else None; fa = feats(ra) if ra else None
    lm = log_ing(fm, ent, tam) if fm else None; la = log_ing(fa, ent, tam) if fa else None
    if lm is None: return la
    if la is None: return lm
    n = rm["VIVPAR_HAB"]; w = n / (n + K_SHRINK); return w * lm + (1 - w) * la
def crudo(l): return math.exp(l) * M["smear"]
def ingreso(l): return CAL["C"] * crudo(l)
def nivel(ing):
    c = CAL.get("cortes") or []
    return 0 if not c else 1 + sum(ing >= x for x in c)
