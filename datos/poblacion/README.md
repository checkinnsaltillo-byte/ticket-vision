# Población por hexágono (INEGI)

Genera `maqueta/data/poblacion_hex_saltillo.json` con `poblacion_hex.py`.

**Fuentes (INEGI):**
- Censo de Población y Vivienda 2020, *Principales resultados por AGEB y manzana urbana*, Coahuila (CSV, POBTOT y TVIVHAB).
- Marco Geoestadístico, diciembre 2022, Coahuila (`05m.shp`, manzanas). El de 2020 ya no se sirve; se une por CVEGEO (99.86 % de las manzanas con datos coinciden).
- Totales municipales de la Encuesta Intercensal 2025 (Saltillo 976,477; Ramos Arizpe 139,714; Arteaga 42,266 por diferencia con el total metropolitano de 1,158,457; publicados por El Heraldo de Saltillo el 2026-09-23): **verificar contra los tabulados del INEGI**.

**Método:** interpolación areal que conserva la masa. Cada manzana reparte su población entre los hexágonos que cubre, en proporción al área de la intersección (se asume población uniforme dentro de la manzana). La suma de los hexágonos iguala la de las manzanas (996,215 de 996,243).
`p25` = `p20` × (población municipal 2025 / población municipal 2020): estimación, no dato de manzana.

**Limitaciones:** manzanas posteriores a 2020 sin dato; no se reparte según edificación (mejora posible: interpolación dasimétrica con huellas de edificios); la EIC 2025 no publica manzanas.
