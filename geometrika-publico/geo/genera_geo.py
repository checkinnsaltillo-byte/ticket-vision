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
out = {}; falta = []
for c in cat:
    for e in c['an']:
        for i in e['ind']:
            k = e['id'] + ':' + i['id']; lk = 'aire:aire' if k == 'met:aire' else k
            if i['id'] in EU and e['id'] == 'eu': m = (1, 'Capa «%s»: los frentes de manzana se colorean con el dato de INEGI (gris = sin dato o no aplica).' % EU[i['id']])
            elif k in M: m = M[k]
            else: falta.append(k); continue
            card = ej.get(lk); sin = bool(card and 'ind-na' in card)
            out[k] = {'v': 'Aire' if k == 'met:aire' else WIN[e['id']], 'm': m[0], 't': m[1]}
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
