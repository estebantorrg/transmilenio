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

---

# Planos de estación → vagones y mobiliario

Los *planos de ubicación* oficiales (`_planos/`, 154 hojas, vía
`tramites.transmilenio.gov.co/station-maps/api/map`) son la **única** fuente que
sabe cómo es una estación por dentro. Ni el catálogo, ni el registro oficial, ni
las coordenadas de los recorridos distinguen una estación de dos plataformas
escalonadas de una barra segmentada — se midió, y las tres se equivocan igual.

Dos herramientas leen esas hojas:

- `planos.mjs` — **cuántos** vagones imprime la hoja y con qué forma. Cuenta las
  placas amarillas y las losas grises, y solo confía en el número cuando ambas
  concuerdan. No escribe nada: propone.
- `detalle.mjs` — **qué hay alrededor**: vestíbulos, taquillas, torniquetes,
  salidas con su calle, puentes peatonales. Escribe un borrador en
  `_planos/detalle_draft.json` y nada más.

```
node detalle.mjs              # todas las hojas que nadie ha leído
node detalle.mjs TM0005 …     # solo estas
node detalle.mjs --check      # relee las dos leídas a mano y compara
DEBUG=1 node detalle.mjs TM0052   # además, el perfil de columnas crudo
```

## Cómo lee una hoja

1. **Las placas ubican todo.** Son las únicas barras amarillas saturadas y del
   mismo tamaño entre sí; dan la banda de andén, las filas y la x de cada vagón.
2. **Un perfil por columna** da la forma. Para cada x, el gris no blanco más
   frecuente: el gris claro es superficie de andén, cualquiera más oscuro es
   huella de estación. **El valor exacto del gris no significa nada** — los
   canales son 200 en Guatoque y 156 en Calle 85 —, así que las carreras se
   nombran por estructura: placa encima → `vagones`; alta y estrecha sin placa →
   `puente`; huella entre dos andenes → `paso`; huella pasado el último andén →
   `vestibulo`.
3. **La leyenda de la propia hoja** clasifica los iconos. Se comparan siluetas
   normalizadas (el plano los dibuja en blanco sobre negro y la leyenda en gris
   sobre blanco) y también **en espejo**: en el extremo derecho la hoja voltea
   sus símbolos igual que voltea el bloque.
4. **OCR solo sobre recortes**, nunca sobre la página. Con eso el número de
   vagón sí se lee — lo que la pasada de página completa no lograba.

## Qué no se puede leer

- **Los nombres de calle en hoja densa.** `Carrera 27` (88×22 px) se lee;
  `Calle 72` (38×10 px) no se lee de ninguna manera. Salen como `calle: null`.
- **Estación de una sola fila.** El dibujo detallado reparte en dos bandas y
  solo hay una; queda anotado y no se propone.
- **Hojas que no son un plano de andenes.** Las de *cierre de estación* dibujan
  las placas en rojo (Calle 72, obras del Metro) y las intermodales dibujan
  varios niveles en diagonal (Banderas). No se leen y no deben leerse.

Los huecos son deliberados. Media estación bien dibujada vale más que una
estación entera dibujada con seguridad y mal: un plano equivocado manda al
pasajero al extremo que no es.
