# Datos locales del municipio de Monterrey, N. L.

Réplica del esquema de Saltillo para el municipio de Monterrey (INEGI 19039). Fuentes y procedimiento:

- **INEGI** (descarga con User-Agent de navegador):
  - Censo 2020 por AGEB y manzana: `.../ccpv/2020/datosabiertos/ageb_manzana/ageb_mza_urbana_19_cpv2020_csv.zip`
  - Marco Geoestadístico 2020 (NL): `.../marcogeo/889463807469/19_nuevoleon.zip` (manzanas `19m.shp`)
  - DENUE NL: `https://www.inegi.org.mx/contenidos/masiva/denue/denue_19_csv.zip`
- `poblacion_hex.py` (MUNS = {"039"}, ancla 25.6693, -100.3090) → `maqueta/data/poblacion_hex_monterrey.json`. **Sin cifra municipal de la EIC 2025**: `p25 = p20`.
- `nse_hex.py` → `nse_hex_monterrey.json`; `denue_prep.py` (filtra `cve_mun == '039'`) → `denue_monterrey.json`; `arbolado_hex.py` → `arbolado_hex_monterrey.json`.
- **OpenStreetMap + Microsoft** (archivos en Cloud Storage `osm/`): `osm_vial_extrae.py` + `osm_vial_empaca.py` → `vial-monterrey.json`; `osm_entorno_extrae.py` → `entorno-monterrey/`; `osm_uso_extrae.py` → `uso-monterrey.json`; `huellas_microsoft.py` → `huellas-monterrey/`. Cobertura OSM/Microsoft: caja 25.42–25.86 N, -100.50 – -100.11 E (el municipio más un margen para los radios de análisis).
- El servidor elige la región por el punto (`_REGIONES` en `files/server.js`).
