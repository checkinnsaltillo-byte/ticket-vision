# DENUE (INEGI) · Establecimientos económicos

`denue_prep.py` filtra el DENUE de Coahuila (`https://www.inegi.org.mx/contenidos/masiva/denue/denue_05_csv.zip`) a la zona conurbada de Saltillo, agrupa los sectores SCIAN en 10 giros y escribe `maqueta/data/denue_saltillo.json` (≈39 000 establecimientos: lat, lng, giro, tamaño, nombre, SCIAN).
