#!/bin/bash
# Genera la versión pública de GeoMetrika (www.check-inn.mx/geometrika/) a partir de app.js y styles.css.
# Uso: bash geometrika-publico/build.sh   (desde la carpeta Codigo)
set -e
TV="$(cd "$(dirname "$0")/.." && pwd)"
CA="$TV/../../Check in"; OUT="$CA/geometrika"; mkdir -p "$OUT"
V=$(grep -o 'app.js?v=[0-9]*' "$TV/index.html" | head -1 | cut -d= -f2)
HASH=$(printf geo123 | shasum -a 256 | cut -d' ' -f1)
HASH2=$(printf 1123 | shasum -a 256 | cut -d' ' -f1)   # ve precios reales
n=$(grep -n '^const GM_MAQ_' "$TV/app.js" | cut -d: -f1)
tail -n +$n "$TV/app.js" > /tmp/gm_block.js
"$HOME/opt/terser/node_modules/.bin/terser" /tmp/gm_block.js -c -m --ecma 2020 -o "$OUT/geometrika.js"
node --check "$OUT/geometrika.js"
c=$(grep -n 'MÓDULO GeoMetrika' "$TV/styles.css" | head -1 | cut -d: -f1)
tail -n +$c "$TV/styles.css" > "$OUT/geometrika.css"
cp "$TV/geometrika-logo.png" "$OUT/geometrika-logo.png"; cp "$TV/geometrika-logo-claro.png" "$OUT/geometrika-logo-claro.png"
cp "$TV/metrika-logo.png" "$OUT/metrika-logo.png"; cp "$TV/econolab-logo.png" "$OUT/econolab-logo.png"; cp "$TV/terralab-logo.png" "$OUT/terralab-logo.png"
# Data Lab: pantalla, estilos, inventario de fuentes y logos (la versión de caché sale de su contenido)
DL="$TV/geometrika-publico"
# el catálogo de indicadores se regenera desde la definición de Geo Lab (si falla, se conserva el último)
node "$DL/extrae_indicadores.js" "$TV/maqueta/entorno.html" "$DL/datalab-indicadores.js.nuevo" && mv "$DL/datalab-indicadores.js.nuevo" "$DL/datalab-indicadores.js" || { rm -f "$DL/datalab-indicadores.js.nuevo"; echo "aviso: no se pudo regenerar el catálogo de indicadores; se usa el anterior"; }
# series del INEGI (BIE/BISE) como indicadores y fuentes de Data Lab (se toma el ecolab-datos.js más reciente)
node "$DL/extrae_inegi.js" "$DL/datalab-inegi.js.nuevo" "$DL/ecolab-datos.js" "$OUT/ecolab-datos.js" && mv "$DL/datalab-inegi.js.nuevo" "$DL/datalab-inegi.js" || { rm -f "$DL/datalab-inegi.js.nuevo"; echo "aviso: no se pudo regenerar el catálogo INEGI; se usa el anterior"; }
DLV=$(cat "$DL/datalab.js" "$DL/datalab.css" "$DL/datalab-fuentes.js" "$DL/datalab-indicadores.js" "$DL/datalab-inegi.js" "$DL/datalab-geo.js" "$DL/datalab-geovis.js" "$DL/geo/replica.css" "$TV/datalab-logo.png" | shasum -a 256 | cut -c1-8)
node --check "$DL/datalab.js"; node --check "$DL/datalab-fuentes.js"; node --check "$DL/datalab-indicadores.js"; node --check "$DL/datalab-inegi.js"; node --check "$DL/datalab-geo.js"; node --check "$DL/datalab-geovis.js"
cp "$DL/datalab.js" "$DL/datalab.css" "$DL/datalab-fuentes.js" "$DL/datalab-indicadores.js" "$DL/datalab-inegi.js" "$DL/datalab-geo.js" "$DL/datalab-geovis.js" "$OUT/"; cp "$TV/datalab-logo.png" "$TV/datalab-logo-claro.png" "$OUT/"; mkdir -p "$OUT/geo-vis"; cp "$DL"/geo/vis/*.jpg "$OUT/geo-vis/"; rm -rf "$OUT/geo-vis/r"; cp -R "$DL/geo/vis/r" "$OUT/geo-vis/r"; cp "$DL/geo/replica.css" "$OUT/geo-vis/r/replica.css"
# Media Lab: monitor masivo de noticias (la versión de caché sale de su contenido)
MLV=$(cat "$DL/medialab.js" "$DL/medialab.css" "$TV/medialab-logo.png" | shasum -a 256 | cut -c1-8)
node --check "$DL/medialab.js"; cp "$DL/medialab.js" "$DL/medialab.css" "$OUT/"; cp "$TV/medialab-logo.png" "$OUT/medialab-logo.png"
# Model Lab: modelado estadístico por proyecto (biblioteca de indicadores generada desde Data Lab; motor estadístico propio)
node "$DL/extrae_biblioteca.js" || echo "modelab-biblioteca: se conserva la anterior"
MOV=$(cat "$DL/modelab.js" "$DL/modelab.css" "$DL/modelab-motor.js" "$DL/modelab-biblioteca.js" "$DL/modelab-valuacion.js" "$TV/modelab-logo.png" "$TV/modelab-logo-claro.png" | shasum -a 256 | cut -c1-8)
node --check "$DL/modelab.js"; node --check "$DL/modelab-motor.js"; node --check "$DL/modelab-valuacion.js"; cp "$DL/modelab.js" "$DL/modelab.css" "$DL/modelab-motor.js" "$DL/modelab-biblioteca.js" "$DL/modelab-valuacion.js" "$OUT/"; cp "$TV/modelab-logo.png" "$TV/modelab-logo-claro.png" "$OUT/"
# EcoLab: tablero económico (datos descargados con ecolab-descarga.js)
ECV=$(cat "$DL/ecolab.js" "$DL/ecolab.css" | shasum -a 256 | cut -c1-8)
node --check "$DL/ecolab.js"; node --check "$DL/ecolab-datos.js"
cp "$DL/ecolab.js" "$DL/ecolab.css" "$OUT/"
# los datos los actualiza solos el servidor cada mes (commit en Check in): no pisar una versión publicada más reciente
if node -e 'const f=p=>{try{const w={};new Function("window",require("fs").readFileSync(p,"utf8"))(w);return w.ECO_DATA.generado||""}catch(_){return ""}};process.exit(f(process.argv[1])>f(process.argv[2])?0:1)' "$DL/ecolab-datos.js" "$OUT/ecolab-datos.js"; then cp "$DL/ecolab-datos.js" "$OUT/ecolab-datos.js"; else echo "ecolab-datos.js: se conserva la versión publicada (más reciente)"; fi
# TerraLab: bases de datos inmobiliarias (hereda ecolab.css)
TLV=$(cat "$DL/terralab.js" "$DL/terralab-extraccion.js" "$DL/terralab-fbmarc.js" "$DL/terralab.css" "$TV/terralab-logo.png" | shasum -a 256 | cut -c1-8)
node --check "$DL/terralab.js"; node --check "$DL/terralab-extraccion.js"; cp "$DL/terralab-extraccion.js" "$DL/terralab-fbmarc.js" "$DL/terralab.js" "$DL/terralab.css" "$TV/terralab-logo.png" "$OUT/"
sed "s/__V__/$V/g; s/__TL__/$TLV/g; s/__EC__/$ECV/g; s/__ML__/$MLV/g; s/__MO__/$MOV/g; s/__DL__/$DLV/g; s/__HASH2__/$HASH2/g; s/__HASH__/$HASH/g" "$TV/geometrika-publico/index.template.html" > "$OUT/index.html"
echo "generado en $OUT (v=$V, datalab=$DLV)"
