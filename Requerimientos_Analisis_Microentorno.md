# Levantamiento de requerimientos — Módulo «Análisis del microentorno» (GeoVal)

**Versión 0.3 · 24-oct-2026 · Alcance de la Fase 1: solo variables obtenibles de imágenes de Google Street View.**
Las capas de datos públicos estructurados (INEGI, DENUE, OSM, atlas de riesgos, mercado, tráfico en vivo, etc.) quedan **diferidas** (ver sección 13) y se agregarán después. Integra la propuesta inicial con el documento de ChatGPT.

---

## 1. Objetivo

A partir de una **coordenada**, analizar con imágenes de **Street View** el entorno inmediato (radio base 300 m) para **identificar, medir, calificar y explicar** lo que se observa a nivel de calle y que influye en valor, renta, demanda, liquidez y riesgo de un inmueble. Debe responder:

1. ¿Qué tipo de zona parece ser? (tipología **visual**)
2. ¿Qué ventajas y desventajas se observan, con qué evidencia?
3. ¿Qué señales de riesgo y de oportunidad hay?
4. ¿Qué tan favorable parece el entorno **para un uso** (vivienda, renta corta, comercial, oficina/bodega, terreno)?
5. ¿Cómo se compara con otras ubicaciones analizadas con el mismo método?

Fuera de alcance: avalúo en pesos, predicción de precio, dictamen pericial, y cualquier cifra que una foto no pueda demostrar.

## 2. Principios

- **Observar, no suponer**: solo se califica lo que se ve; lo que no se ve es **«no evaluable»**, nunca «ausente».
- **Evidencia vs. inferencia** (cada indicador lleva su etiqueta): **Visible** (se ve directamente), **Estimado** (inferido de lo visible, ej. altura aparente, nivel de conservación) y **Por verificar en campo**.
- **La IA extrae evidencias con un cuestionario cerrado; las reglas del sistema calculan** los puntajes (reproducible y recalculable sin volver a pagar IA).
- **Multidimensional y orientado al uso**: un promedio no debe ocultar una debilidad; lo mismo puede ser ventaja para un local y desventaja para vivienda.
- **Explicable**: cada resultado abre su evidencia (imágenes, fecha, regla).

## 3. Qué permite y qué no permite Street View

### 3.1 Sí se puede observar (a nivel de calle)
Fachadas y tipo de edificación · altura aparente (niveles) · materiales y estado de conservación · rótulos y giros comerciales · locales cerrados/en renta · escuelas, hospitales, plazas comerciales, templos (si hay letrero o son reconocibles) · tipo y estado de la vialidad (carriles, camellón, puentes, distribuidores, cruces, paradas de transporte) · banquetas, rampas, cruces peatonales · pavimento y baches · postes de alumbrado, semáforos, señales, rejillas pluviales, cableado aéreo · arbolado y áreas verdes visibles, parques y canchas · basura, escombro, grafitis, rejas, bardas, casetas, cámaras · lotes baldíos, obra nueva, abandono · puestos ambulantes y vehículos presentes **en el momento de la captura** · arroyos/canales, taludes, líneas de alta tensión, ductos visibles, industria visible · señales de inundación o erosión.

### 3.2 Límites (hay que declararlos en cada informe)
- **Foto fija, de una fecha**: puede tener años de antigüedad; el comercio ambulante, los autos y la actividad dependen del día y hora de captura. Se exige **fecha de cada imagen** y se baja la confianza si es antigua; cuando exista **Street View histórico**, se usan varias fechas.
- **Solo calles con cobertura**: interiores de manzana, privadas y calles sin captura quedan «no evaluables».
- **Luz diurna**: el alumbrado se califica por **infraestructura instalada** (postes/luminarias), no por si funciona de noche.
- **No mide** densidad poblacional, ingreso, nivel socioeconómico real, incidencia delictiva, ruido real, tráfico/congestión, riesgo oficial de inundación, uso de suelo permitido, precios ni distancias a lugares que no se alcanzan a ver. Esas variables se **difieren** (sección 13).
- **No se diagnostica**: daños estructurales, ocupación efectiva ni hacinamiento desde el exterior.
- Rejas, cámaras y grafitis son **señales ambiguas**, no prueban criminalidad alta o baja.
- Una **vista cenital** (cobertura vegetal en %, forma de manzanas, ocupación del suelo) **no se puede medir con Street View**; solo se aproxima con lo que se ve desde la calle.

## 4. Estructura del proceso

```
1 Coordenada, radio, uso objetivo
2 Muestreo de calles y puntos de captura  →  3 Obtención y control de calidad de imágenes
4 IA: cuestionario cerrado por imagen  →  5 Agregación imagen → tramo → anillo
6 Motor de puntuación (normalización, pesos, cobertura, confianza, reglas críticas)
7 Diagnóstico: tipología visual, ICE / IRE / IOI, FODA, comparación  →  8 Informe, evidencia, historial
```

### 4.1 Muestreo y captura
- **Calles dentro del radio** (con trazado de calles de la propia cobertura de Street View; se descartan las que no tienen captura y se registran como «sin cobertura»).
- **Puntos cada ≈ 40–60 m** a lo largo de cada calle y **2–4 direcciones** por punto (frente, atrás, laterales); mínimo ≈ 12–24 imágenes por análisis (configurable).
- Anillos: **0–100 m** (entorno inmediato, mayor peso), **100–300 m** (microentorno), **300–500 m** (opcional). Pesos del anillo: 0.5 / 0.35 / 0.15 (editables; sin anillo C: 0.6 / 0.4).
- Se guarda por imagen: identificador de panorama, **fecha**, ubicación, dirección, calidad y cobertura.
- **Control de calidad**: imagen borrosa, obstruida (camión, árbol), de noche o demasiado antigua → «no evaluable» o confianza baja.
- **Términos de uso**: usar la API oficial de Street View; revisar permisos de almacenamiento/procesamiento masivo, atribución y cuotas; **capa de fuentes intercambiables** por si luego se usa otro proveedor. Se analiza el entorno, no a las personas; difuminar rostros y placas si se guardan imágenes.

### 4.2 Extracción por IA
Por cada imagen, un **cuestionario cerrado** (pregunta → respuesta en escala fija 0–4 o categoría, «no se ve/no aplica» y una justificación corta). Se agregan las respuestas a **tramo de calle** y luego a **anillo**, ponderando por cobertura. Cada pregunta tiene **ejemplos de imagen por nivel** para calibrar a la IA y a los revisores.

## 5. Dimensiones e indicadores (12 dimensiones observables + 1 derivada)

**Tipo**: V = visible · E = estimado. **Sentido**: (+) más es mejor · (−) más es peor · (Ó) existe un rango óptimo.

| # | Dimensión | Indicadores observables (cuestionario / medición) | Tipo |
|---|---|---|---|
| **S1** | **Uso aparente y vocación** | Proporción de frentes por uso: vivienda, comercio, oficinas, industria/bodega, institucional, baldío, en obra; diversidad de usos (mezcla); conflictos aparentes (industria o bar junto a vivienda); % de lotes baldíos o subutilizados | V + E |
| **S2** | **Morfología urbana visible** | Altura aparente (niveles); vivienda horizontal vs. vertical; ancho de frente de lote (tamaño aparente); conjuntos cerrados/torres; continuidad de fachadas; vacíos entre construcciones | E |
| **S3** | **Vialidad y accesibilidad (visual)** | Tipo de vía (local, colectora, avenida, bulevar, carretera); carriles y camellón; sentido; puentes, pasos a desnivel, distribuidores, segundos pisos; glorietas/retornos; cruces peatonales y semáforos; paradas/estaciones de transporte visibles; ciclovías; estacionamiento en vía; acceso directo al predio; barreras (muros, canal, vía férrea, autopista) | V |
| **S4** | **Comercio y servicios (visible)** | Giros por rótulo (conveniencia, supermercado, farmacia, banco, restaurantes, bares, gimnasio, talleres, mayoreo); frentes comerciales activos y continuidad; **locales cerrados o en renta**; anclas visibles; estacionamiento comercial | V |
| **S5** | **Generadores de afluencia (visibles)** | Escuelas, universidades, hospitales/clínicas, centros comerciales, oficinas/corporativos, templos, recintos, terminales o estacionamientos grandes **identificables en imagen** (cantidad, tamaño aparente, distancia aproximada al punto de captura) | V |
| **S6** | **Ambiente y paisaje** | Arbolado de calle (cantidad/porte), áreas verdes, plazas y parques visibles; arroyos/canales visibles; basura, escombro o tiraderos; polvo/humo; industria o fuentes de contaminación visibles; sombra; calidad paisajística, vistas y barreras visuales | V + E |
| **S7** | **Infraestructura urbana** | Pavimento (tipo, baches, calidad); banquetas (existencia, ancho, continuidad, estado, obstáculos); guarniciones; rampas de accesibilidad; **alumbrado instalado** (postes/luminarias y estado); señalización y nomenclatura; semáforos; rejillas y drenaje pluvial; mobiliario urbano; **cableado aéreo** (ordenado/caótico) | V |
| **S8** | **Calidad constructiva y mantenimiento** | Materiales y acabados de fachada; conservación (pintura, muros, techos); deterioro visible; edificaciones abandonadas o desocupadas; obra nueva y remodelaciones; homogeneidad de conservación; mantenimiento de accesos y jardines | E |
| **S9** | **Seguridad física visible** | Visibilidad de recorridos y vigilancia natural (ventanas, actividad en planta baja); muros ciegos y rincones ocultos; rejas, bardas altas, concertina, casetas, controles de acceso; cámaras visibles; grafitis y vandalismo; lotes abandonados; vehículos abandonados | V + E |
| **S10** | **Tipología habitacional y perfil aparente** | Casa sola, dúplex, condominio, vecindad, departamentos, autoconstrucción, fraccionamiento cerrado; tamaño aparente de lote y vivienda; calidad aparente de materiales; estacionamiento en predio; saturación y tipo de autos en calle. **Todo es indicio (no medida) del nivel socioeconómico**: se muestra como «perfil aparente» y no se usa para afirmar ingreso | E |
| **S11** | **Informalidad y ocupación del espacio público** | Puestos ambulantes y tipo; tianguis o mercados en banqueta; carga/descarga; doble fila; banquetas obstruidas; terrazas/mobiliario en vía; recurrencia si hay varias fechas. **Foto fija**: se reporta como «presencia en la fecha de captura». No es automáticamente desventaja: depende del uso | V |
| **S12** | **Movilidad y ruido potencial (indicios)** | Jerarquía y número de carriles; presencia de transporte pesado o autobuses; colas visibles; cruces peligrosos; tráfico peatonal/ciclista visible; vías rápidas, ferrocarril o industria cercanos. **No mide congestión ni ruido reales** | V + E |
| **S13** | **Riesgos físicos visibles (señales)** | Cauces, canales y zonas bajas; marcas de inundación; erosión o socavación; taludes, cortes y muros de contención; pendiente aparente; líneas y torres de alta tensión; ductos; gasolineras e industria de riesgo; vía férrea. Solo **señales a verificar**, no confirmación de riesgo | V |
| **S14** | **Equipamiento recreativo y calidad de vida (visible)** | Parques, plazas, canchas, áreas de juego, ciclovías, bancas, espacios para niños y adultos mayores, accesibilidad universal visible | V |
| **S15** | **Dinamismo y transformación (visible)** | Obra nueva y remodelaciones; predios subutilizados; casas convertidas a comercio; abandono progresivo; **comparación entre fechas de Street View** cuando existan | E |
| **S16** | **Implicaciones por uso** *(derivada)* | Aptitud por uso (renta, ejecutivo, corta estancia, comercio, oficina/bodega, terreno); ventajas, desventajas y recomendaciones. Se deriva de las demás; **no vuelve a sumar** los mismos indicadores | Derivada |

> Las dimensiones que en la v0.2 dependían de bases externas (demografía, nivel socioeconómico oficial, seguridad efectiva, movilidad real, riesgos oficiales, mercado, regulación) **salen de esta fase**. Las dimensiones S1, S5, S10, S12 y S13 quedan **reducidas a lo observable** y con confianza menor.

## 6. Medición y calificación por indicador

### 6.1 Tipos de medición (todos desde imagen)
Conteo (elementos por tramo) · Proporción (% de frentes o tramos que cumplen una condición) · Continuidad (banquetas continuas) · Calidad visual (rúbrica 0–4) · Diversidad (variedad de giros/usos) · Categoría (tipo de vía, tipología) · Distancia **aproximada** entre el punto de captura y el elemento · Cambio temporal (entre fechas de Street View).

### 6.2 Escala 0–100
| Puntaje | Nivel | Significado |
|---|---|---|
| 0–19 | Muy desfavorable | Condición claramente adversa para el uso evaluado |
| 20–39 | Desfavorable | Desventajas relevantes |
| 40–59 | Intermedio | Mixta o promedio |
| 60–79 | Favorable | Positiva |
| 80–100 | Muy favorable | Ventaja clara con evidencia suficiente |

### 6.3 Funciones de normalización
- **(+) Positiva**: `S = 100·clip((x−L)/(U−L), 0, 1)`; **(−) Negativa**: `S = 100·clip((U−x)/(U−L), 0, 1)`.
- **(Ó) Rango óptimo**: ej. densidad de comercio frente a vivienda (poco resta conveniencia; mucho suma ruido y tráfico).
- **Categórica**: matriz explícita por uso (vía local favorable a vivienda; avenida favorable a comercio).
- **Cambio temporal**: por dirección y magnitud.
- Límites (L, U): inicialmente **por juicio experto** (rúbrica); al acumular zonas, **por percentiles** de zonas comparables de la misma ciudad (invirtiendo los negativos); en fases posteriores, calibrados con precios y rentas. **Topes absolutos**: ej. «sin alumbrado instalado» nunca pasa de 40.

### 6.4 Ficha técnica por indicador
Dimensión · definición operativa · unidad · dirección · tipo (V/E) · **pregunta y escala para la IA con ejemplos por nivel** · regla de puntuación y umbrales por uso · evidencia requerida · advertencias (qué no puede concluirse).
*Ejemplo — continuidad de banquetas: tramos con banqueta continua y transitable ÷ tramos evaluables; si la imagen está obstruida o es antigua, el tramo es «no evaluable», no «sin banqueta».*

### 6.5 Campos que guarda cada indicador
Valor observado · puntuación 0–100 · **imágenes de evidencia** · **fecha de captura** · **confianza** · **cobertura** (% de tramos/imágenes evaluados) · regla aplicada y versión · estado de validación (automático / revisado / corregido).

## 7. Calificación por dimensión
`D_j = Σ(w_i·S_i) / Σ(w_i)` sobre indicadores **evaluables**, pesos que suman 100 % dentro de la dimensión.
- **Cobertura mínima**: 70 % del peso aplicable; si no se alcanza, la dimensión es **incompleta**.
- **Ausencia ≠ cero** y **sin duplicidad** entre indicadores correlacionados.
- **Compensación limitada** y **topes por señal crítica** (ej. señal de inundación o alta tensión cercana limita su dimensión).
- Se reporta **dispersión** (homogeneidad entre calles/anillos), cobertura y confianza.
- Pesos y umbrales **versionados**; reanalizar con otra versión conserva los resultados históricos.

## 8. Índices (no un solo promedio)

**ICE — Índice de Calidad del Entorno (0–100, por uso)**: `ICE_u = Σ W_{j,u}·D_j` con S1–S12 y S14. Pesos **iniciales sin calibrar**, editables:

| Dimensión | Vivienda | Renta corta | Comercial | Terreno |
|---|---|---|---|---|
| S1 Uso aparente | 8 | 6 | 12 | 14 |
| S2 Morfología | 3 | 2 | 4 | 8 |
| S3 Vialidad y accesibilidad | 9 | 10 | 17 | 14 |
| S4 Comercio y servicios | 7 | 11 | 13 | 4 |
| S5 Generadores visibles | 5 | 10 | 15 | 8 |
| S6 Ambiente y paisaje | 9 | 7 | 3 | 7 |
| S7 Infraestructura urbana | 11 | 8 | 8 | 12 |
| S8 Calidad constructiva | 8 | 9 | 5 | 3 |
| S9 Seguridad física | 14 | 14 | 9 | 6 |
| S10 Tipología / perfil aparente | 10 | 4 | 3 | 5 |
| S11 Informalidad | 3 | 3 | 2 | 2 |
| S12 Movilidad y ruido (indicios) | 6 | 6 | 6 | 8 |
| S14 Equipamiento recreativo | 7 | 10 | 3 | 9 |
| **Total** | 100 | 100 | 100 | 100 |

Clases del ICE: **A** 80–100 muy favorable · **B** 60–79 favorable · **C** 40–59 intermedio · **D** 20–39 desfavorable · **E** 0–19 muy desfavorable. No es un precio ni una categoría oficial de plusvalía.

**IRE — Índice de Riesgo (aparte, no resta al ICE)**: alimentado por S13 y señales críticas de S6, S9 y S12. Cada riesgo con categoría, puntuación, evidencia y confianza; distingue **señal observada** de **riesgo confirmado** (esto último requiere fuentes externas, fase posterior). Las **alertas críticas** se muestran aunque el ICE sea alto.

**IOI — Índice de Oportunidad**: alimentado por S15 y brechas visibles (ej. mucha afluencia y pocos servicios, locales vacíos en corredor activo, lotes subutilizados). No equivale a rentabilidad.

**Compuertas**: se degrada un nivel si hay señal crítica de riesgo, **seguridad física crítica** (S9 < 40) o **cobertura < 70 %**. Siempre se muestran juntos: perfil por dimensiones + ICE + IRE + IOI + confianza + alertas.

## 9. Tipología visual de zona
Se asigna con **reglas** sobre proporciones de uso, tipo de edificación y actividad visibles (no con el promedio de puntajes), permite mixta y tiene **confianza propia**. Primaria: Z1 Residencial predominante · Z2 Residencial de densidad media-alta · Z3 Comercial y de servicios · Z4 Corporativa/institucional · Z5 Industrial/logística · Z6 Mixta · Z7 Turística/recreativa · Z8 Periférica o en consolidación · Z9 Deterioro o subutilización. Secundarias (visuales): densidad aparente, consolidación, accesibilidad, calidad urbana, presión de movilidad, presión ambiental, dinamismo, señales de riesgo.

## 10. Resultados
- **Resumen**: tipología, ICE (y clase), IRE, IOI, confianza y cobertura.
- **Perfil por dimensión** (radar + barras por indicador con semáforo).
- **FODA automático** con evidencia, por uso: fortalezas (indicadores ≥ 75 con confianza alta) · debilidades (≤ 50) · amenazas (alertas del IRE) · oportunidades (IOI); efecto esperado por dimensión (↑↑ ↑ = ↓ ↓↓) sobre valor, renta, liquidez y riesgo.
- **Galería de evidencia**: cada hallazgo enlazado a su imagen, ubicación, dirección y fecha; mapa con los puntos de captura.
- **Comparativo** entre ubicaciones; **informe PDF**; exportación CSV/JSON; **historial** con versión del método.
- **Recomendaciones de qué verificar en campo o con datos externos** cuando la evidencia sea insuficiente.

## 11. Requerimientos funcionales

| ID | Requerimiento |
|---|---|
| RF-01 | Seleccionar coordenada (lat/lng, dirección, clic en mapa o desde un inmueble del sistema) |
| RF-02 | Configurar radio, anillos, uso objetivo, densidad de muestreo e imágenes por punto |
| RF-03 | Obtener imágenes de Street View con la API oficial; registrar panorama, fecha, dirección y cobertura |
| RF-04 | Control de calidad de imágenes (borrosas, obstruidas, nocturnas, antiguas) y marca «sin cobertura» |
| RF-05 | Cuestionario cerrado por IA por imagen, con justificación y confianza |
| RF-06 | Agregar imagen → tramo → anillo ponderando cobertura |
| RF-07 | Normalizar, calificar indicadores y dimensiones con pesos, cobertura mínima y topes |
| RF-08 | Calcular ICE, IRE e IOI por uso; clasificar tipología visual |
| RF-09 | Generar FODA, ventajas/desventajas y recomendaciones por uso |
| RF-10 | Evidencia y explicabilidad: abrir el indicador y ver imágenes, regla y cálculo |
| RF-11 | Comparar ubicaciones; ranking y mapa |
| RF-12 | Administrar indicadores, preguntas, pesos, umbrales y **versiones**; recalcular sin repetir la IA |
| RF-13 | Validación humana: corregir respuestas/puntajes con registro de quién y por qué |
| RF-14 | Historial y auditoría; comparar fechas de un mismo punto |
| RF-15 | Exportar ficha, tabla de indicadores y PDF |
| RF-16 | Análisis por lote con avance, estimación de costo previa, tope y botón detener |
| RF-17 | Permisos por rol |
| RF-18 | Alertas críticas y de evidencia insuficiente |

**Interfaz (5 secciones)**: mapa con puntos de captura y radios · diagnóstico general · perfil por dimensiones · ventajas/desventajas/riesgos con evidencia · comparador.

## 12. Calidad, validación y encaje en tu sistema
- **Criterios de aceptación**: resultados reproducibles (misma fuente, parámetros y versión) · imagen no disponible ≠ ausencia · inferencias marcadas · puntajes con cobertura y confianza · alertas críticas siempre visibles · ediciones manuales registradas · pesos versionables.
- **Validación**: muestra de zonas **inspeccionadas por personas**; meta inicial ≥ 85 % de acuerdo por indicador. Para el efecto en valor, comprobar luego si los puntajes explican precios/rentas.
- **Costo y tiempo**: ≈ 15–30 imágenes por análisis + IA; ≈ 1–3 min por coordenada; cachear imágenes por punto; mostrar costo estimado antes de correr.
- **Encaje técnico**: mismo patrón que «Clasificación por nichos» (rúbrica JSON versionada; se guardan los puntajes por indicador y todo lo demás se recalcula al leer); datos en Cloud Storage (`geoval/…`) con imágenes en bucket privado; mapa Leaflet con el estilo de Investigación de mercados; PDF vectorial; nuevo módulo admin con el checklist de 7 lugares; arranque desde un alojamiento, una Renta LP o un inmueble propio.

## 13. Diferido (se agrega después de la Fase 1)
| Variable / capa | Por qué no entra ahora | Fuente futura |
|---|---|---|
| Densidad poblacional, hogares, edad | Una foto no la mide | Censo/AGEB INEGI |
| Nivel socioeconómico real, ingreso | Solo hay indicio visual (S10) | INEGI / AMAI |
| Incidencia delictiva | No es observable | Estadística oficial |
| Uso de suelo cuantificado y comercios por giro | Solo se ve el frente de calle | DENUE, catastro, OSM |
| Distancias reales por red, área caminable | Requiere red vial | OSM/red peatonal |
| Tráfico y congestión reales, aforos | Foto fija | Capas de tráfico/movilidad |
| Riesgos oficiales (inundación, fallas) | Solo se ven señales | Atlas de riesgos, estudios |
| Cobertura vegetal %, morfología y ocupación (vista cenital) | Street View no es cenital | Satélite |
| Servicios efectivos (agua, drenaje, internet) | No se ve | Operadores |
| Mercado (precio/m², renta, vacancia) | Calibración de pesos | Tu base propia y comparables |
| Regulación (uso permitido, densidad) | No se ve | Planes urbanos |

## 14. Fases
0. **Catálogo y motor (sin IA)**: indicadores, preguntas, rúbrica, normalización y puntuación; validar con tu criterio.
1. **Piloto (1–2 semanas)**: 10 coordenadas conocidas de Saltillo (premium, media, baja, industrial, mixta, centro, periferia, con arroyo…); comparar IA vs. revisión humana y afinar la rúbrica.
2. **Módulo base**: muestreo, captura, cuestionario, agregación, ICE/IRE/IOI, tipología, FODA, informe en pantalla y PDF.
3. **Comparador, lote e historial** (incluye fechas históricas de Street View → S15).
4. **Capas externas** (sección 13), una por una, mostrando cada indicador con su fuente.
5. **Calibración con mercado**: ligar ICE a precios y rentas; pesos por segmento.

## 15. Decisiones pendientes
1. ¿Street View únicamente, o también un apoyo de **satélite** para vegetación/morfología (sigue siendo imagen)?
2. ¿Uso principal para arrancar: vivienda, renta corta, comercial o terreno?
3. ¿Coordenadas sueltas o también **barrido de la ciudad** en cuadrícula?
4. ¿Qué 10 puntos usamos para el piloto (con zonas que ya conoces bien)?
5. Presupuesto por análisis y por lote.
6. ¿Los informes serán para terceros? Define formalidad y advertencias.
7. ¿Quién revisará las muestras del piloto?
