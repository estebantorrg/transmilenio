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
- [x] Extractor estructural: filas → (corredor, hito), destacado por color de chip — `ruteros.mjs`
- [x] Horarios (`L-S` / `D-F`) — `ruteros.mjs`; la vigencia (p. ej. `ABRIL-2024`) aún no
- [ ] Página 2: listado de paraderos ordenado por sentido
- [x] Lote + informe de confianza — sobre las **482 artes vectoriales** de la Respuesta A, no sobre los 207 PDF rasterizados

---

# Artes finales → ruteros tradicionales (`ruteros.mjs`)

TRANSMILENIO entregó las artes finales de las piezas TransMiZonal (radicado
2026-ER-47262): 482 PDF **vectoriales** en `peticiones/Respuesta A/09-2026_Artesfinales TransMiZonales/`.
No tienen capa de texto — las letras están convertidas a curvas —, pero cada
celda del rutero es un trazado relleno con su color exacto. Eso cambia el método:

```
node ruteros.mjs                        # las 482
node ruteros.mjs --only "AH 605" 139    # solo las que contengan esto
node ruteros.mjs --jobs 3               # workers de render en paralelo
```

Escribe `_ruteros/ruteros.json` (borrador, no se publica solo) e imprime un informe.

1. **La geometría sale del dibujo, no de los píxeles.** pdf.js entrega cada
   relleno con su caja y su color: el contorno oscuro es la tabla entera, la
   pestaña es el código, la franja de ancho completo es el destino, los chips
   amarillos (`#ffeb3d`) y oscuros (`#2c2e35`) de ~40–48pt son los corredores.
   El hito va del borde del chip al borde de la tabla.
2. **Solo se renderizan y leen esas celdas**, con `@napi-rs/canvas` en Node
   (sin navegador): la franja de las tablas a 6×.
3. **Binarizado contra el relleno declarado de cada celda**, no contra la
   luminancia: los colores de zona van del azul al naranja, y el texto blanco
   en negrita puede cubrir más celda que su fondo.
4. **Cada celda se lee en cinco variantes y votan.** El motor lee mal esta
   tipografía condensada de forma *sistemática* (`H605` → `11605`, `KR 24` →
   `n 24` a todo tamaño); **estirarla 1,8× en horizontal** lo corrige.
5. **Lo que el OCR no puede, lo dan otras fuentes exactas:** el código de una
   pieza de doble sentido sale del **color de la pestaña** (es el color de la
   zona de destino); el destino se contrasta con el nombre del catálogo para
   ese código, y si la lectura es ruido (`ARBORMDOUANM`), se toma el del
   catálogo y se marca `destinoFuente: "catálogo"`.
6. **Los corredores pasan por el vocabulario oficial** (`shared/nomenclatura.js`,
   el listado de abreviaturas del Manual V.6): `AKIO` → `AK 10`, `CL48LS` →
   `CL 48L S`, `AV. 1/MAYO` → `AV. 1° DE MAYO`.

7. **El motor no ve una línea de dos o tres letras sola** (`L-S`, `KR` sobre
   `72D`, el `12` de una pestaña). Por eso: el código de una pieza de un solo
   código sale del **nombre del archivo**; las celdas de dos líneas se leen
   también **con las líneas puestas una al lado de la otra** (`KR 72D`); y el
   tipo de día de un horario sale del **catálogo**, solo si **todas** las
   franjas de la pieza coinciden con las del catálogo — si alguna no, los dos
   horarios difieren y una coincidencia de horas es casualidad (TC14 imprime
   `S 5:00–8:00 p.m.`, que son exactamente las horas del `D-F` del catálogo).

Trampas del dibujo que ya se manejan:

- chips pintados dos veces con 0,6pt de diferencia (580) — se deduplican por solape;
- un chip por línea de texto, a media altura (`AV.` / `1/MAYO`);
- un chip oscuro que abarca varias filas con un hito por fila (el corredor destacado);
- **un hito que abarca varias filas** (TC14: `AV. V/CIO` │ `JACQUELINE`): no hay
  rectángulo de hito, pero sí regla separadora; donde falta, las filas son una;
- **una fila sin chip** al pie de la tabla (F425: `EST. BANDERAS`): el contorno
  de la tabla baja una fila más que el último chip;
- **tablas solo para domingos y festivos**: la leyenda bajo la tabla lo dice
  ("Operación domingos y festivos") y se marca `operacion`.

Auditoría a ojo contra las artes (8 piezas, las tres familias): tras estas
correcciones, todas las filas coinciden salvo un hito que pierde su número
(`11 DE NOVIEMBRE` → `DE NOVIEMBRE`). Los destinos ilegibles de una sola pieza
(`CIRCULAR TIMIZA` → ruido) quedan marcados en `avisos`, no adivinados.

**Lo que las artes dicen y el catálogo no:** cada franja que no coincide con el
catálogo queda en `avisos`. No es ruido: F425 imprime una segunda franja de
tarde que el catálogo no tiene, y TC14 un horario L-V / S / D-F donde el
catálogo dice L-S / D-F.

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
