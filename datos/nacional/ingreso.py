"""Ingreso mensual del hogar (estimado) por manzana / AGEB: microsimulación espacial con la ENIGH 2024 y las variables del Censo 2020.

Idea: para cada AGEB se reponderan los hogares de la ENIGH (inclinación exponencial) hasta que sus rasgos (bienes, vivienda, escolaridad, ocupados, tamaño del hogar…)
coincidan con los porcentajes que el Censo publica del AGEB; el ingreso del AGEB es el promedio ponderado de esos hogares. Así se respeta la forma en que los rasgos se
combinan en los hogares reales (un AGEB con pocos autos y poco internet se parece a los hogares pobres de la ENIGH), que una regresión lineal aplanaría.
Antes se «armonizan» los porcentajes del Censo 2020 con los de la ENIGH 2024 por entidad (cambios de definición y de fecha). La manzana parte del ingreso de su AGEB
y se desvía según su propia composición (regresión de enigh_modelo.py, ampliada por el factor KAPPA y comprimida hacia el AGEB cuando tiene pocos hogares)."""
import json, math, os
import numpy as np
AQUI = os.path.dirname(os.path.abspath(__file__))
M = json.load(open(os.path.join(AQUI, "enigh_modelo.json"))); ARM = json.load(open(os.path.join(AQUI, "ingreso_armonia.json")))
CALP = os.path.join(AQUI, "ingreso_calibracion.json"); CAL = json.load(open(CALP)) if os.path.exists(CALP) else {"C": 1.0, "cortes": [], "kappa": 1.0, "ab": [0.0, 1.0]}
COEF = M["coef"]; FEATS = M["features"]; K_SHRINK = 30.0
COLS_ING = ["VIVPAR_HAB", "VPH_PISOTI", "VPH_3YMASC", "PRO_OCUP_C", "VPH_AUTOM", "VPH_INTER", "VPH_PC", "VPH_STVP", "VPH_LAVAD", "VPH_HMICRO", "VPH_REFRI", "VPH_CEL", "VPH_TELEF", "VPH_CVJ", "GRAPROES", "HOGJEF_F", "TOTHOG", "POBHOG", "POCUPADA"]
_S = np.load(os.path.join(AQUI, "ingreso_muestra.npz"), allow_pickle=True)
XF = _S["F"].astype(np.float64); YS = _S["y"].astype(np.float64); ES = _S["ent"]; TS = _S["tam"]
_FE = lambda e: COEF.get("ent_" + e, 0.0)
TAMFE = {1: 0.0, 2: COEF["tam_2"], 3: COEF["tam_3"], 4: COEF["tam_4"]}
_BASE = np.array([_FE(e) + TAMFE[int(t)] for e, t in zip(ES, TS)]); _SD = XF.std(axis=0) + 1e-9
_SHARE = np.array(ARM["share"], dtype=bool)
def feats(r):
    v = r.get("VIVPAR_HAB"); th = r.get("TOTHOG")
    if not v or v <= 0 or not th or th <= 0: return None
    sh = lambda c: None if r.get(c) is None else min(1.0, max(0.0, r[c] / v))
    f = {"pt": sh("VPH_PISOTI"), "c3": sh("VPH_3YMASC"), "oc": r.get("PRO_OCUP_C"), "auto": sh("VPH_AUTOM"), "inter": sh("VPH_INTER"), "pc": sh("VPH_PC"), "stvp": sh("VPH_STVP"), "lav": sh("VPH_LAVAD"), "mic": sh("VPH_HMICRO"), "refri": sh("VPH_REFRI"), "cel": sh("VPH_CEL"), "telef": sh("VPH_TELEF"), "cvj": sh("VPH_CVJ"),
         "gp": r.get("GRAPROES"), "hf": None if r.get("HOGJEF_F") is None else min(1.0, r["HOGJEF_F"] / th), "tam": None if r.get("POBHOG") is None else r["POBHOG"] / th, "ocup": None if r.get("POCUPADA") is None else r["POCUPADA"] / th}
    return f if all(x is not None for x in f.values()) else None
def tam_loc(pob): return 1 if pob >= 100000 else 2 if pob >= 15000 else 3 if pob >= 2500 else 4
def armoniza(f, ent):
    d = ARM["delta"].get(ent); v = np.array([f[k] for k in FEATS], dtype=np.float64)
    if d is None: return v
    d = np.array(d); out = v.copy(); s = _SHARE
    p = np.clip(v[s], .003, .997); out[s] = 1 / (1 + np.exp(-(np.log(p / (1 - p)) + d[s]))); out[~s] = v[~s] * np.exp(d[~s]); return out
def log_reg(v, ent, tam):   # regresión del modelo (rasgos ya armonizados): sirve para las desviaciones de la manzana
    x = COEF["const"] + COEF.get("ent_" + ent, 0.0) + COEF.get("tam_%d" % tam, 0.0)
    for k, a in zip(FEATS, v): x += COEF[k] * a
    return x
def micro(v, ent, tam, rho=1e-2):
    """ingreso medio del AGEB: hogares de la ENIGH reponderados a los rasgos del AGEB (v), con ingreso ajustado a la entidad y al tamaño de localidad."""
    Z = (XF - v) / _SD; lam = np.zeros(Z.shape[1])
    for _ in range(30):
        a = Z @ lam; a -= a.max(); wt = np.exp(a); pw = wt / wt.sum(); zb = Z.T @ pw; g = zb + rho * lam; Zc = Z - zb; H = (Zc * pw[:, None]).T @ Zc + rho * np.eye(len(lam))
        st = np.linalg.solve(H, g); lam -= st
        if np.abs(st).max() < 1e-6: break
    a = Z @ lam; a -= a.max(); wt = np.exp(a); wt /= wt.sum()
    y = YS * np.exp(_FE(ent) + TAMFE[tam] - _BASE); o = np.argsort(y); cw = np.cumsum(wt[o])
    return float((wt * y).sum()), float(y[o][np.searchsorted(cw, 0.5)])   # (media, mediana) de los hogares reponderados
def ingreso_ageb(r, ent, tam):
    """(media, mediana) mensual del hogar en el AGEB, o None."""
    f = feats(r)
    if not f: return None
    a, b = micro(armoniza(f, ent), ent, tam); return CAL["C"] * a, CAL["C"] * b
def ingreso_mz(rm, ra, ing_ag, ent, tam):
    """manzana: ingreso del AGEB × exp(KAPPA · w · (reg_manzana − reg_AGEB)); sin AGEB, mapeo lineal de la regresión al ingreso de microsimulación."""
    fm = feats(rm) if rm else None
    if fm is None: return ing_ag
    vm = armoniza(fm, ent); lm = log_reg(vm, ent, tam)
    if ing_ag is None or ra is None or feats(ra) is None:
        a, b = CAL.get("ab", [0.0, 1.0]); m = CAL["C"] * math.exp(a + b * lm); return m, m * CAL.get("med_sobre_media", 0.84)
    la = log_reg(armoniza(feats(ra), ent), ent, tam); n = rm["VIVPAR_HAB"]; w = n / (n + K_SHRINK); k = math.exp(CAL.get("kappa", 1.0) * w * (lm - la))
    return ing_ag[0] * k, ing_ag[1] * k
def nivel(ing, ent=None):
    """nivel 1-5 (quintiles de hogares dentro de la entidad, igual que el NSE; sin entidad, quintiles del país)."""
    c = (CAL.get("cortes_ent") or {}).get(ent) or CAL.get("cortes") or []
    return 0 if not c else 1 + sum(ing >= x for x in c)
