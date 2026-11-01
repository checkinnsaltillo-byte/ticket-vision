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
cp "$TV/geometrika-logo.png" "$OUT/geometrika-logo.png"
sed "s/__V__/$V/g; s/__HASH2__/$HASH2/g; s/__HASH__/$HASH/g" "$TV/geometrika-publico/index.template.html" > "$OUT/index.html"
echo "generado en $OUT (v=$V)"
