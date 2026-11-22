# Paquete de prompts · maquetas urbanas con IA (imagen → video)

Objetivo: obtener maquetas isométricas tipo diorama, con el mismo estilo que el video de referencia (casco colonial, techos de teja, plaza con iglesia, autos y gente), y variantes para los 6 perfiles de morfología urbana.

## Flujo (2 pasos)
1. **Imagen fija** con un generador de imágenes (Midjourney, Imagen, Flux, DALL·E o similar). Generar 4 variantes y elegir la mejor.
2. **Imagen → video** con una herramienta de video (Veo, Runway, Kling, Luma, Sora o similar), subiendo la imagen elegida y usando el prompt de movimiento.

Consejos de consistencia
- Usar siempre el **mismo bloque de estilo** (abajo) y cambiar solo el bloque de morfología.
- Subir 1 o 2 **fotogramas del video de referencia** como imagen de referencia de estilo (la mayoría de las herramientas lo permite).
- Formato 16:9. Pedir 4 variantes por perfil y repetir si salen cielos, horizonte o texto.
- Guardar la **semilla** o la imagen elegida para poder regenerar.

## Bloque de estilo (pegar siempre)
```
Ultra-detailed 3D isometric architectural scale model, miniature diorama, photorealistic render, 3/4 aerial view from about 40 degrees, clean cut-out base showing the ground cross-section layers, no sky, no horizon, plain neutral gray studio background, soft diffused daylight with gentle shadows, realistic materials (terracotta roof tiles, whitewashed and ochre stucco walls, cobblestone streets), tiny cars and tiny people, shallow depth of field, professional architectural visualization, 16:9
```

## Prompt negativo (si la herramienta lo admite)
```
sky, clouds, horizon, text, watermark, logo, cartoon, low poly, blurry, distorted buildings, duplicated buildings, extra floating objects, people larger than doors
```

## Bloque de morfología (uno por perfil; se pega después del bloque de estilo)

1. **Estrella radial (céntrico-convergente)**
```
A city that grew symmetrically from a dense historic core with a main square and a church, with wide avenues radiating outward like the spokes of a star, blocks shaped like orange slices between the avenues, density decreasing toward the edges
```
2. **Lineal / de valle o costera (eje longitudinal)**
```
A long narrow city squeezed between a steep mountain range on one side and a river or coast on the other, one main avenue running along the whole length, short perpendicular streets that climb or stop at the obstacle, buildings stretched in a single strip
```
3. **Policéntrica en red (archipiélago metropolitano)**
```
A metropolis with several distinct centers of different sizes, each with its own plaza and taller buildings, connected by ring roads and highways, green gaps between the clusters, a fragmented mosaic of neighborhoods
```
4. **Ortogonal / damero rígido (cuadrícula consolidada)**
```
A planned colonial grid city with perfectly regular square blocks, equal streets crossing at right angles, a central plaza taking one block, uniform two-story houses with courtyards, very regular repeating pattern
```
5. **Fragmentada / mancha de aceite (periferia dispersa)**
```
An old compact historic center surrounded by a sprawl of disconnected housing developments of identical small houses, connected only by a few narrow secondary roads, long tentacle-like streets following the only available paths, empty land between the pieces
```
6. **Anular / de circunvalación (modelo de anillos)**
```
A city organized in concentric rings: an inner ring road around the historic center, a middle beltway and an outer highway ring, clear terraces of density between the rings, radial connectors crossing the rings, buildings getting lower toward the outside
```

## Prompt de imagen a video (movimiento)
```
Slow smooth orbital camera movement around the miniature city model, about 120 degrees in 10 seconds, constant distance and angle, subtle realistic motion: small cars driving along the streets, tiny people walking, trees moving slightly in the breeze, window lights flickering softly; keep the neutral gray background, no sky, no camera shake, seamless loop feeling
```
Ajustes útiles: duración 10 s · cámara «orbit / arc shot» si la herramienta tiene ese control · movimiento de cámara en intensidad media · sin cambios de escena.

## Plantilla completa de ejemplo (perfil 4)
```
[BLOQUE DE ESTILO] + A planned colonial grid city with perfectly regular square blocks, equal streets crossing at right angles, a central plaza taking one block, uniform two-story houses with courtyards, very regular repeating pattern
```

## Si algo sale mal
- **Aparece cielo u horizonte:** repetir «no sky, no horizon, plain gray background» al inicio del prompt.
- **Edificios deformes o repetidos:** pedir una escena más pequeña («a single city block» o «16 blocks»).
- **No se parece al video:** subir un fotograma del video como referencia de estilo y reducir adjetivos.
- **El video cambia el modelo durante el giro:** usar movimientos más cortos (6 a 8 s) y unirlos.
