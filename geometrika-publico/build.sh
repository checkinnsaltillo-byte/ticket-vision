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
# Data Lab: pantalla, estilos, inventario de fuentes y logos (la versión de caché sale de su contenido)
DL="$TV/geometrika-publico"
# el catálogo de indicadores se regenera desde la definición de Geo Lab (si falla, se conserva el último)
node "$DL/extrae_indicadores.js" "$TV/maqueta/entorno.html" "$DL/datalab-indicadores.js.nuevo" && mv "$DL/datalab-indicadores.js.nuevo" "$DL/datalab-indicadores.js" || { rm -f "$DL/datalab-indicadores.js.nuevo"; echo "aviso: no se pudo regenerar el catálogo de indicadores; se usa el anterior"; }
DLV=$(cat "$DL/datalab.js" "$DL/datalab.css" "$DL/datalab-fuentes.js" "$DL/datalab-indicadores.js" "$TV/datalab-logo.png" | shasum -a 256 | cut -c1-8)
node --check "$DL/datalab.js"; node --check "$DL/datalab-fuentes.js"; node --check "$DL/datalab-indicadores.js"
cp "$DL/datalab.js" "$DL/datalab.css" "$DL/datalab-fuentes.js" "$DL/datalab-indicadores.js" "$OUT/"; cp "$TV/datalab-logo.png" "$TV/datalab-logo-claro.png" "$OUT/"
sed "s/__V__/$V/g; s/__DL__/$DLV/g; s/__HASH2__/$HASH2/g; s/__HASH__/$HASH/g" "$TV/geometrika-publico/index.template.html" > "$OUT/index.html"
echo "generado en $OUT (v=$V, datalab=$DLV)"
