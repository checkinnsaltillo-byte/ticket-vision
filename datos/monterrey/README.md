# Datos locales del área metropolitana de Monterrey, N. L. (18 municipios)

Desde 2026-11-03 la región `monterrey` cubre los 18 municipios del área metropolitana (INEGI 19: 001 Abasolo, 006 Apodaca, 009 Cadereyta Jiménez, 010 El Carmen, 012 Ciénega de Flores, 018 García, 019 San Pedro Garza García, 021 General Escobedo, 025 General Zuazua, 026 Guadalupe, 031 Juárez, 039 Monterrey, 041 Pesquería, 045 Salinas Victoria, 046 San Nicolás de los Garza, 047 Hidalgo, 048 Santa Catarina, 049 Santiago). Caja: 25.211–26.425 N, -100.892 – -99.656 E (`amm.json`).

Fuentes (descarga con User-Agent de navegador):
- Censo 2020 por AGEB y manzana: `.../ccpv/2020/datosabiertos/ageb_manzana/ageb_mza_urbana_19_cpv2020_csv.zip`
- Marco Geoestadístico (NL): `.../marcogeo/794551132173/19_nuevoleon.zip` (manzanas `19m.shp`)
- DENUE NL: `https://www.inegi.org.mx/contenidos/masiva/denue/denue_19_csv.zip`
- OpenStreetMap México: `https://download.geofabrik.de/north-america/mexico-latest.osm.pbf` (pyosmium)
- Microsoft Global ML Building Footprints (dataset-links.csv)

Scripts (en este orden): `poblacion_hex.py` (MUNS = los 18) → `nse_hex.py` → `denue_prep.py` (filtra los 18) → `arbolado_hex.py` (pide `/mercado/maqueta/suelo`, necesita `x-gm-token`); `osm_vial_extrae.py` + `osm_vial_empaca.py` → `osm/vial-monterrey.json`; `osm_entorno_extrae.py` → `osm/entorno-monterrey/`; `osm_uso_extrae.py` → `osm/uso-monterrey.json`; `huellas_microsoft.py` → `osm/huellas-monterrey/`. Los cuatro de OSM/Microsoft llevan la caja metropolitana en `S,W,N,E`.
p25 = p20 × factor municipal EIC 2025 (cargado el 2026-11-08). El servidor y el visor eligen la región por el centro más cercano entre las cajas que contienen el punto (Monterrey se traslapa con Saltillo en la sierra).
