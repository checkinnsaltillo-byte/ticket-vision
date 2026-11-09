#!/usr/bin/env python3
# Genera ../datalab-geo.js: para cada indicador del catálogo, si se muestra en Geo Lab, dónde, cómo se ve en el mapa
# y una tarjeta de ejemplo REAL (capturada de Geo Lab con el proyecto «Tec de Mty»; ver ejemplos-tec.json).
# Uso: python3 geo/genera_geo.py   (desde geometrika-publico). Para refrescar las tarjetas, volver a capturarlas de Geo Lab (panel Indicadores > Expandir) y reemplazar ejemplos-tec.json / ejemplos.css.
import json, re, os, subprocess
D = os.path.dirname(os.path.abspath(__file__)); P = os.path.dirname(D)
ej = json.load(open(D + '/ejemplos-tec.json')); css = open(D + '/ejemplos.css').read()
cat = json.loads(subprocess.check_output(['node', '-e', 'global.window={};require("%s/datalab-indicadores.js");console.log(JSON.stringify(window.DL_INDICADORES))' % P]))
html = open(P + '/../maqueta/entorno.html', encoding='utf8').read()
EU = dict(re.findall(r"(eu_\w+): \{ n: '([^']+)'", html))

WIN = {'met': 'Meteorología › Sol, viento y clima', 'inu': 'Meteorología › Lluvia e inundación', 'geo': 'Terreno', 'urb': 'Urbanización', 'rie': 'Riesgos', 'eu': 'Entorno urbano (INEGI)', 'fri': 'Accesibilidad', 'cob': 'Población', 'tra': 'Tráfico', 'od': 'Origen/Destino vehicular', 'dem': 'Demografía', 'eco': 'Actividad económica', 'afl': 'Afluencia', 'ent': 'Análisis del entorno urbano (IA)', 'aire': 'Calidad del aire y polen', 'psl': 'Potencial solar', 'arb': 'Cobertura arbórea', 'emi': 'Emisiones de carbono'}
SOLO = 'Solo en la tarjeta y en la ventana del análisis; no se dibuja en el mapa.'
M = {  # clave → (¿en el mapa?, cómo se ve)
 'met:temp': (0, SOLO + ' La ventana muestra la gráfica mensual.'), 'met:lluvia': (0, SOLO + ' La ventana muestra la lluvia mes por mes.'), 'met:hum': (0, SOLO), 'met:clima': (0, SOLO + ' La ventana muestra el pronóstico de 10 días.'),
 'met:aire': (1, 'Botón «Ver mapa de calor» de la ventana Calidad del aire y polen: pinta el aire calle por calle (verde = buena calidad, rojo = mala).'),
 'met:viento': (1, 'Botón «Vientos»: dibuja el flujo del viento sobre la maqueta, con su rosa de rumbos en la ventana.'),
 'met:sol': (1, 'Botones «Trayectoria» y «Horas»: dibujan el arco del sol y las horas del día, y proyectan las sombras sobre la maqueta (también «Animar el día»).'),
 'inu:riesgo': (1, 'Botón «Profundidad en calles»: pinta cada tramo de calle según la profundidad del agua (la calle de enfrente da el riesgo de la propiedad).'),
 'inu:calles': (1, 'Botón «Profundidad en calles»: los tramos con más de 15 cm quedan resaltados.'),
 'inu:peligro': (1, 'Botón «Profundidad en calles»: la profundidad y la corriente del agua frente a la propiedad se ven sobre la calle.'),
 'inu:caudal': (0, SOLO + ' El botón «Flujo» anima por dónde corre el agua.'), 'inu:tc': (0, SOLO + ' El botón «Flujo» anima el escurrimiento.'),
 'geo:alt': (1, 'Botón «Ver sobre la maqueta»: colorea el relieve por altitud (con «Curvas de nivel» opcionales).'),
 'geo:desn': (1, 'Botón «Ver sobre la maqueta»: el relieve coloreado muestra de dónde a dónde se da el desnivel.'),
 'geo:pend': (1, 'Pestaña Pendiente › «Ver sobre la maqueta»: colorea el terreno por rangos de pendiente.'),
 'geo:pend5': (1, 'Pestaña Pendiente › «Ver sobre la maqueta»: las zonas con más de 5° se ven en los colores de pendiente fuerte.'),
 'urb:edif': (1, 'Pestaña Crecimiento urbano › «Ver sobre la maqueta»: capa del área construida por año (con «Animar 1975 → 2030»).'),
 'urb:crec': (1, 'Pestaña Crecimiento urbano › «Ver sobre la maqueta»: capa del área construida por año (con «Animar 1975 → 2030»).'),
 'urb:etapa': (1, 'Pestaña Crecimiento urbano › «Ver sobre la maqueta»: se ve cuándo se urbanizó cada zona.'),
 'urb:cons': (1, 'Pestaña Cobertura de suelo › «Ver sobre la maqueta»: pinta la maqueta por tipo de suelo (ESA WorldCover, 10 m).'),
 'urb:veg': (1, 'Pestaña Cobertura de suelo › «Ver sobre la maqueta»: pinta la maqueta por tipo de suelo (ESA WorldCover, 10 m).'),
 'rie:rg': (1, 'Capa «Riesgos»: marca sobre la maqueta cada riesgo detectado (basura, baches, alcantarillas…) y permite resaltarlo desde la lista.'),
 'fri:ancla': (1, 'Pestañas Deformación y Dominancia › «Ver en el mapa»: la red de calles se redibuja según el tiempo hacia cada ancla.'),
 'fri:fric': (1, 'Pestaña Deformación › «Ver en el mapa»: la red se estira donde el viaje pierde más tiempo.'),
 'fri:cerca': (1, 'Pestañas Deformación y Dominancia › «Ver en el mapa»: se ven las anclas que quedan a 15 minutos.'),
 'fri:rutas': (1, 'Pestaña Rutas de acceso › «Ver en el mapa»: traza las rutas de llegada a la propiedad.'),
 'fri:trafr': (1, 'Pestaña Rutas de acceso › «Ver en el mapa»: las rutas se leen con el tráfico (cuando hay lectura).'),
 'cob:pob': (1, 'Botón «Ver en el mapa»: dibuja el contorno (radio o isócrona por calles) dentro del que se cuenta la población.'),
 'cob:p15': (1, 'Botón «Ver en el mapa»: dibuja el contorno de 15 minutos a pie.'),
 'cob:dens': (1, 'Botón «Ver en el mapa»: dibuja el contorno dentro del que se calcula la densidad.'),
 'tra:dem': (1, 'Botón «Ver en el mapa»: pinta la vialidad según la última lectura de tráfico de Google (fluido, moderado, lento, detenido).'),
 'tra:vel': (1, 'Botón «Ver en el mapa»: pinta la vialidad según la velocidad de la última lectura de tráfico de Google.'),
 'tra:lenta': (1, 'Botón «Ver en el mapa»: la vialidad más lenta se distingue por su color (lento o detenido).'),
 'tra:pico': (0, SOLO + ' La gráfica 7 × 24 de la ventana muestra la hora más congestionada.'),
 'od:orig': (1, 'Botón «Árbol en el mapa»: dibuja las rutas de origen del tráfico que llega a la propiedad.'),
 'od:hhi': (0, SOLO), 'od:tviaje': (0, SOLO),
 'dem:pob': (1, 'Pestaña Población › «Ver en el mapa»: hexágonos de 200 m en columnas según los habitantes.'),
 'dem:den': (1, 'Pestaña Densidad › «Ver en el mapa»: hexágonos coloreados por habitantes/km².'),
 'dem:ocu': (1, 'Pestaña Viviendas › «Ver en el mapa»: hexágonos coloreados por vivienda y ocupación.'),
 'dem:ing': (1, 'Pestaña Ingreso › «Ver en el mapa»: hexágonos coloreados por nivel del ingreso mensual típico (mediana) estimado del hogar, con altura = habitantes.'),
 'dem:nse': (1, 'Pestaña NSE › «Ver en el mapa»: hexágonos coloreados por estrato socioeconómico.'),
 'eco:denue': (1, 'Botón «Ver en el mapa» (DENUE): puntos de negocios y torres por manzana según el giro.'),
 'eco:gpn': (1, 'Botón «Ver negocios en el mapa»: coloca los negocios de Google Places, con filtro de los que abren de noche.'),
 'eco:div': (0, SOLO + ' Las capas de DENUE muestran los negocios que lo componen.'), 'eco:gpa': (0, SOLO), 'eco:gpr': (0, SOLO),
 'afl:aidx': (1, 'Botón «Ver en el mapa»: densidad (KDE), envolvente o prismas hexagonales de afluencia.'),
 'afl:apea': (1, 'Botón «Ver en el mapa»: densidad (KDE), envolvente o prismas hexagonales de afluencia.'),
 'afl:adur': (0, SOLO), 'afl:aanc': (0, SOLO), 'afl:aveh': (0, SOLO + ' Todavía se basa en los datos de tráfico, que están en construcción.'),
 'ent:ire': (1, 'Botón «Ver fotos en el mapa»: ubica las fotos de Street View en que se basa el análisis.'), 'ent:ioi': (1, 'Botón «Ver fotos en el mapa»: ubica las fotos de Street View en que se basa el análisis.'), 'ent:conf': (1, 'Botón «Ver fotos en el mapa»: ubica las fotos de Street View disponibles.'),
 'aire:aqi': (1, 'Botón «Ver mapa de calor»: pinta el aire calle por calle (verde = buena calidad, rojo = mala).'),
 'aire:pm25a': (0, SOLO), 'aire:pron': (0, SOLO + ' La pestaña Pronóstico muestra la curva de 24 h.'), 'aire:polen': (0, SOLO + ' La pestaña Polen muestra los 5 días.'),
 'psl:sole': (1, 'Botón «Ver paneles en el mapa»: coloca los paneles sobre las azoteas más grandes.'), 'psl:solco': (0, SOLO), 'psl:solh': (0, SOLO), 'psl:solr': (0, SOLO + ' La ventana permite ajustar tarifa y costo.'),
 'arb:arbp': (1, 'Botón «Ver en el mapa»: hexágonos coloreados por cobertura arbórea.'), 'arb:arbd': (1, 'Pestaña Prioridad › «Ver en el mapa»: hexágonos coloreados por prioridad de reforestación.'), 'arb:arbi': (0, SOLO),
 'emi:emie': (1, 'Botón «Ver en el mapa»: hexágonos coloreados por emisiones totales.'), 'emi:emim': (1, 'Botón «Ver en el mapa»: hexágonos coloreados por emisiones del transporte.'), 'emi:emipc': (1, 'Botón «Ver en el mapa»: hexágonos coloreados por emisiones per cápita.'),
}

# ¿Cuándo se genera el dato? P = al crear el proyecto (se consulta una vez y se guarda con el proyecto) · I = cada vez que se ingresa (se calcula o consulta al abrir la maqueta o al pulsar «Calcular y actualizar»)
# D = bajo demanda (solo si alguien pulsa el botón) · G = ya guardado en el sistema (dato de referencia cargado de antemano) · X = pendiente de construir. El primer código es el principal.
W = {
 'met:temp': ('P', 'Se consulta (Open-Meteo 2020-2024) al crear el proyecto y se guarda con él.'), 'met:lluvia': ('P', 'Se consulta al crear el proyecto y se guarda con él.'), 'met:clima': ('P', 'Se consulta al crear el proyecto y se guarda con él.'),
 'met:aire': ('P', 'El promedio de 30 días se consulta al crear el proyecto y se guarda. La ventana Calidad del aire y polen consulta el aire de ahora cada vez que se abre.'),
 'met:hum': ('I', 'Se descargan los datos horarios del último año (ERA5) al abrir; el navegador los recuerda para no repetirlo.'), 'met:viento': ('I', 'Se descargan los datos horarios del último año (ERA5) al abrir; el navegador los recuerda para no repetirlo.'),
 'met:sol': ('I', 'Se calcula al momento con la posición astronómica del sol (no hay descarga).'),
 'inu:riesgo': ('I', 'Se calcula en el navegador cada vez que se abre: relieve + red de calles del proyecto + escenario de lluvia.'), 'inu:caudal': ('I', 'Se calcula en el navegador cada vez que se abre: relieve + red de calles del proyecto + escenario de lluvia.'), 'inu:calles': ('I', 'Se calcula en el navegador cada vez que se abre: relieve + red de calles del proyecto + escenario de lluvia.'), 'inu:peligro': ('I', 'Se calcula en el navegador cada vez que se abre: relieve + red de calles del proyecto + escenario de lluvia.'), 'inu:tc': ('I', 'Se calcula en el navegador cada vez que se abre: relieve + red de calles del proyecto + escenario de lluvia.'),
 'geo:alt': ('I', 'Se descarga el relieve (Terrarium) y se calcula cada vez que se abre.'), 'geo:desn': ('I', 'Se descarga el relieve (Terrarium) y se calcula cada vez que se abre.'), 'geo:pend': ('I', 'Se descarga el relieve (Terrarium) y se calcula cada vez que se abre.'), 'geo:pend5': ('I', 'Se descarga el relieve (Terrarium) y se calcula cada vez que se abre.'),
 'urb:edif': ('G', 'Las imágenes de crecimiento urbano (1975-2030) ya están guardadas en el sistema; al abrir solo se mide el sitio.'), 'urb:crec': ('G', 'Las imágenes de crecimiento urbano (1975-2030) ya están guardadas en el sistema; al abrir solo se mide el sitio.'), 'urb:etapa': ('G', 'Las imágenes de crecimiento urbano (1975-2030) ya están guardadas en el sistema; al abrir solo se mide el sitio.'),
 'urb:cons': ('G', 'La cobertura del suelo (ESA WorldCover) de todo México ya está guardada; al abrir solo se recorta el sitio.'), 'urb:veg': ('G', 'La cobertura del suelo (ESA WorldCover) de todo México ya está guardada; al abrir solo se recorta el sitio.'),
 'rie:rg': ('P', 'Sale de las fotos de calle que se leen con IA al crear el proyecto y queda guardado.'),
 'fri:ancla': ('I', 'Se calcula en el navegador al abrir, con la red de calles del proyecto y los destinos de interés.'), 'fri:fric': ('I', 'Se calcula en el navegador al abrir, con la red de calles del proyecto y los semáforos.'), 'fri:cerca': ('I', 'Se calcula en el navegador al abrir, con la red de calles del proyecto y los destinos de interés.'),
 'fri:rutas': ('I', 'Al abrir se calcula una versión con OpenStreetMap; la versión con tráfico de Google se pide a mano (bajo demanda, con aviso de gasto).'),
 'fri:trafr': ('D', 'Solo se genera al pedir las rutas con Google Routes en la ventana Accesibilidad (la pantalla pide confirmar el gasto).'),
 'cob:pob': ('P', 'Al crear el proyecto se precalculan las isócronas; el conteo de población se hace cada vez que se abre.'), 'cob:p15': ('P', 'Al crear el proyecto se precalculan las isócronas; el conteo de población se hace cada vez que se abre.'), 'cob:dens': ('P', 'Al crear el proyecto se precalculan las isócronas; el conteo de población se hace cada vez que se abre.'),
 'tra:dem': ('P', 'La primera lectura (Google Routes) se hace al crear el proyecto y se guarda; el botón «Actualizar ahora» pide una nueva (bajo demanda).'), 'tra:vel': ('P', 'La primera lectura (Google Routes) se hace al crear el proyecto y se guarda; el botón «Actualizar ahora» pide una nueva (bajo demanda).'), 'tra:pico': ('P', 'La primera lectura (Google Routes) se hace al crear el proyecto y se guarda; el botón «Actualizar ahora» pide una nueva (bajo demanda).'), 'tra:lenta': ('P', 'La primera lectura (Google Routes) se hace al crear el proyecto y se guarda; el botón «Actualizar ahora» pide una nueva (bajo demanda).'),
 'od:orig': ('D', 'Solo se genera al pulsar «Recalcular» en la ventana Origen/Destino; el resultado queda guardado y después solo se lee.'), 'od:hhi': ('D', 'Solo se genera al pulsar «Recalcular» en la ventana Origen/Destino; el resultado queda guardado y después solo se lee.'), 'od:tviaje': ('D', 'Solo se genera al pulsar «Recalcular» en la ventana Origen/Destino; el resultado queda guardado y después solo se lee.'),
 'dem:pob': ('G', 'El Censo 2020 por hexágono de la ciudad ya está guardado; al abrir se suman los hexágonos del sitio.'), 'dem:den': ('G', 'El Censo 2020 por hexágono de la ciudad ya está guardado; al abrir se suman los hexágonos del sitio.'), 'dem:ocu': ('G', 'El Censo 2020 por hexágono de la ciudad ya está guardado; al abrir se suman los hexágonos del sitio.'), 'dem:ing': ('G', 'El ingreso estimado por manzana (ENIGH 2024 + Censo 2020) de todo el país ya está calculado y guardado; al abrir solo se promedian los hexágonos del sitio.'),
 'dem:nse': ('G', 'El NSE por hexágono de la ciudad ya está guardado; al abrir se toman los hexágonos del sitio.'),
 'eco:denue': ('G', 'El DENUE de la ciudad ya está guardado; al abrir se cuentan los establecimientos del radio.'), 'eco:div': ('G', 'El DENUE de la ciudad ya está guardado; al abrir se calcula la diversidad.'),
 'eco:gpn': ('P', 'Los negocios de Google Places se consultan al crear el proyecto (radio de 1 km) y se guardan.'), 'eco:gpa': ('P', 'Los negocios de Google Places se consultan al crear el proyecto (radio de 1 km) y se guardan.'), 'eco:gpr': ('P', 'Los negocios de Google Places se consultan al crear el proyecto (radio de 1 km) y se guardan.'),
 'afl:aidx': ('G', 'Parte del Censo y el DENUE ya guardados; la estimación se calcula en el navegador al abrir.'), 'afl:apea': ('G', 'Parte del Censo y el DENUE ya guardados; la estimación se calcula en el navegador al abrir.'), 'afl:adur': ('G', 'Parte del Censo y el DENUE ya guardados; se calcula en el navegador al abrir.'), 'afl:aanc': ('G', 'Parte del DENUE ya guardado; se calcula en el navegador al abrir.'),
 'afl:aveh': ('X', 'Todavía no se genera: se construirá con los datos de tráfico.'),
 'ent:ire': ('P', 'La IA lee las fotos de Street View al crear el proyecto y el resultado queda guardado (requiere fotos).'), 'ent:ioi': ('P', 'La IA lee las fotos de Street View al crear el proyecto y el resultado queda guardado (requiere fotos).'), 'ent:conf': ('P', 'La IA lee las fotos de Street View al crear el proyecto y el resultado queda guardado (requiere fotos).'),
 'aire:aqi': ('I', 'Se consulta a Google Air Quality cada vez que se abre (con memoria de 20 minutos); el botón «Actualizar» fuerza una lectura nueva.'), 'aire:pm25a': ('I', 'Se consulta a Google Air Quality cada vez que se abre (con memoria de 20 minutos).'), 'aire:pron': ('I', 'Se consulta a Google Air Quality cada vez que se abre (con memoria de 20 minutos).'), 'aire:polen': ('I', 'Se consulta a Google Pollen cada vez que se abre (con memoria de 20 minutos).'),
 'psl:sole': ('P', 'Google Solar se consulta al crear el proyecto (30 azoteas mayores) y se guarda; «Calcular azoteas» recalcula bajo demanda.'), 'psl:solco': ('P', 'Sale de la misma consulta de Google Solar hecha al crear el proyecto.'), 'psl:solh': ('P', 'Sale de la misma consulta de Google Solar hecha al crear el proyecto.'), 'psl:solr': ('P', 'Sale de la consulta de Google Solar hecha al crear el proyecto; cambia al ajustar tarifa y costo.'),
 'arb:arbp': ('G', 'El arbolado por hexágono de la ciudad ya está guardado; al abrir se toman los hexágonos del sitio.'), 'arb:arbd': ('G', 'Sale del arbolado y la meta, con datos ya guardados; se calcula al abrir.'),
 'arb:arbi': ('P', 'Sale de la lectura con IA de las fotos de calle, hecha al crear el proyecto.'),
 'emi:emie': ('G', 'Parte del Censo, el NSE y el DENUE ya guardados; se calcula en el navegador al abrir.'), 'emi:emim': ('G', 'Parte del Censo y el origen de viajes ya guardados; se calcula en el navegador al abrir.'), 'emi:emipc': ('G', 'Parte de datos ya guardados; se calcula en el navegador al abrir.'),
}
for _k in list(EU) :
    W['eu:' + _k] = ('G', 'Los datos de INEGI (entorno urbano por frente de manzana) ya están guardados; al abrir se recortan los del sitio.')
out = {}; falta = []
for c in cat:
    for e in c['an']:
        for i in e['ind']:
            k = e['id'] + ':' + i['id']; lk = 'aire:aire' if k == 'met:aire' else k
            if i['id'] in EU and e['id'] == 'eu': m = (1, 'Capa «%s»: los frentes de manzana se colorean con el dato de INEGI (gris = sin dato o no aplica).' % EU[i['id']])
            elif k in M: m = M[k]
            else: falta.append(k); continue
            w = W.get(k) or W.get('eu:' + i['id'] if e['id'] == 'eu' else '')
            if not w: falta.append('cuando:' + k); continue
            card = ej.get(lk); sin = bool(card and 'ind-na' in card)
            out[k] = {'v': 'Aire' if k == 'met:aire' else WIN[e['id']], 'm': m[0], 't': m[1], 'w': w[0], 'wn': w[1]}
            if card and not sin: out[k]['h'] = card
if falta: raise SystemExit('sin texto de mapa: ' + ', '.join(falta))
# CSS: solo las reglas de la tarjeta y sus gráficos, con el prefijo .dl-geo
SEL = re.compile(r'ind-(card|c[1-4]|tp|dot|gauge|bar|scale|cols|spark|donut|rose|steps|na)\b')
rules = []
for m in re.finditer(r'(^[^{}@]+)\{([^{}]*)\}', css, re.M):
    sel, body = m.group(1).strip(), m.group(2)
    if not SEL.search(sel) or re.search(r'\.ind-(n|h|row|colh|b|sum|mini)\b|\bdata-k', sel): continue
    rules.append(','.join('.dl-geo ' + s.strip() for s in sel.split(',')) + '{' + body.strip() + '}')
js = '/* Qué indicadores se ven en Geo Lab y cómo. Generado por geo/genera_geo.py; no editar a mano. Las tarjetas son capturas reales (proyecto «Tec de Mty»). */\n(function(){var s=document.createElement("style");s.textContent=' + json.dumps('\n'.join(rules)) + ';document.head.appendChild(s);})();\nwindow.DL_GEO_PROY = "Tec de Mty";\nwindow.DL_GEO = ' + json.dumps(out, ensure_ascii=False, separators=(',', ':')) + ';\n'
open(P + '/datalab-geo.js', 'w', encoding='utf8').write(js)
print('indicadores', len(out), '· con tarjeta', sum(1 for v in out.values() if 'h' in v), '· en mapa', sum(v['m'] for v in out.values()), '· reglas css', len(rules), '· bytes', len(js))
