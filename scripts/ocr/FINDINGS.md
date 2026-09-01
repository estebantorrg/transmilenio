# Verificación contra varios plegables

Censo sobre muestra de 16 PDF (1 de cada 13, ordenados por nombre):

| clase | n | % | qué es |
|---|---|---|---|
| con rutero (2 anclas "va hacia") | 9 | 56% | plantillas Plegable y Volante estándar |
| sin rutero (0 anclas) | 5 | 31% | alimentadores: códigos `16-5`, `16-2`, `9-3`, `3-10` |
| ambiguo (1 ancla) | 2 | 13% | `15-4`, `T53` — por revisar |

Extrapolado a 199 códigos: **~110–120 rutas con rutero**, no 199.

## Plantillas encontradas (al menos tres)

1. **Plegable** (73 archivos) — página ~612pt, tema azul/negro, 4 filas en la
   muestra, horario debajo de los dos ruteros.
2. **Volante** (96 archivos) — página ~397pt, tema turquesa, 3 filas en la
   muestra, horario a la derecha del segundo rutero.
3. **Sin rutero** — alimentadores/circulares. Encabezado único
   `código + destino`, **horario pico y horario valle** con "Primera llegada al
   portal" / "Última salida del portal", y dos mapas por variante. No hay tabla
   de rutero que extraer. Ej.: `566_Volante_WEB_10-4`.

## Resolución

El renderizado debe normalizarse a **ancho de píxel objetivo**, no a escala fija:
las dos plantillas tienen tamaños de página muy distintos y una escala fija
submuestrea la pequeña hasta perder filas enteras.

`1700px` de ancho es el mejor punto medido. **Más no es mejor**: a `2400px`
apareció una fila que faltaba pero desaparecieron otros elementos y el código de
ruta se degradó de `L815` a `1815` en ambos lados.

## Por qué el OCR de página completa no basta

| elemento | fiabilidad | nota |
|---|---|---|
| código de ruta | mala | `L815` → `1815`; la L se confunde con 1 |
| destino | media | `VILLA DEL CERRO` → `VILLADEL CERRO`; `EST. AV. 1 MAYO` → `EST, AV,I MAYO` |
| hitos | buena | se leen bien |
| corredores | mala | `AK 10` → `AKIO`; `CL 48L S` → `CL48LS`; a veces no aparecen |
| celdas oscuras | nula | el motor las descarta como región no textual |

Pero **el OCR de una celda recortada y ampliada es excelente**: `PALERMO` y
`AV. AMÉRICAS` (ambas invisibles en la pasada completa) se leen perfectas, con
acentos.

## Diseño que se deriva

1. **El código de ruta no se OCR-ea** — sale de `plegables_manifest.csv`, exacto y gratis.
2. Clasificar plantilla contando anclas "va hacia" antes de intentar extraer.
3. Localizar el bloque de rutero por geometría (anclas + posición del código).
4. **Segmentar las celdas por color**, no por agrupación de líneas del OCR: los
   chips tienen bordes de color duros (amarillo / negro / blanco).
5. Recortar y OCR-ear **cada celda por separado**.
6. El color de fondo del chip da gratis el flag de *corredor destacado*.
7. Corregir corredores contra vocabulario cerrado (`AK|AC|CL|KR|DG|TV|AV` +
   número + letra opcional + `S`/`Sur` opcional). El listado oficial de
   Abreviaturas pedido en la Petición A haría esto exacto.
