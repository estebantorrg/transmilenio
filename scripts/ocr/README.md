# OCR de plegables → ruteros

Extrae el contenido del **rutero** (código, destino, corredores e hitos) y el
**listado de paraderos** de los 207 plegables PDF de `plegables/`.

Los PDF publicados son imágenes rasterizadas sin capa de texto, así que hay que
rasterizar y pasar OCR.

## Por qué esta combinación

Esta máquina no tiene tesseract, poppler, ImageMagick ni Ghostscript, y chromium
en modo headless trata un `.pdf` como descarga en vez de renderizarlo. Lo que sí
hay es Node, el chromium de Playwright y el motor OCR de Windows con español.

- `render.mjs` — pdf.js sobre un canvas real de chromium → PNG por página.
  Levanta un servidor loopback efímero porque chromium no permite importar
  módulos ES desde `file://` ni `about:blank`.
- `crop.mjs` — recorta y amplía una región.
- `ocr.ps1` — `Windows.Media.Ocr` (es-MX), devuelve JSON con **caja por palabra**.
  Escribe con `-Out` porque redirigir la salida por el shell corrompe los acentos.

## Hallazgos que condicionan el diseño

1. **La geometría es obligatoria.** Hay dos plantillas (`Plegable` 73, `Volante`
   96) con distinto tema de color, distinta posición del horario y **distinto
   número de filas** (3 y 4 vistos). Recortes fijos no sirven; hay que ubicar
   todo a partir de las cajas de palabra.
2. **El OCR de página completa omite las celdas oscuras.** El destino sobre
   fondo negro y el chip del corredor destacado no se detectan: el motor los
   descarta como región no textual. Invertir la imagen **no** sirve — el motor
   binariza de forma adaptativa y da el mismo resultado.
   La solución es recortar esa celda y ampliarla; entonces se lee limpio.
3. El resto del rutero (código, chips amarillos, celdas blancas de hito) se lee
   bien en la pasada de página completa.

## Estado

- [x] Rasterizado sin dependencias nativas
- [x] OCR con geometría por palabra y acentos correctos
- [x] Recorte + ampliación para celdas oscuras
- [ ] Extractor estructural: filas → (corredor, hito), destacado por color de chip
- [ ] Horarios (`L-S` / `D-F`) y vigencia (p. ej. `ABRIL-2024`)
- [ ] Página 2: listado de paraderos ordenado por sentido
- [ ] Lote sobre los 207 PDF + informe de confianza
