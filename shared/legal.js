/**
 * The site's legal pages — `/privacidad/` today (spec §5.5.7) — as one copy of
 * the text that both the prerender and the app render.
 *
 * A legal text read two ways has to say the same thing both ways: the static
 * page is what a crawler indexes and what a reader without JS gets, the overlay
 * page is what someone clicking the link inside the app gets, and a clause that
 * differs between them is two policies. So the text lives here once, as plain
 * ESM like `tabla_rutero.js`, and `server/src/prerender_seo.ts` and
 * `client/src/ui/legalPage.ts` only wrap it in their own chrome.
 *
 * **Every sentence here is a claim about the code.** The policy describes what
 * the web client, the server and the APK actually send and keep — which host
 * receives what, what is logged, what stays on the device — and each of those
 * was read off the code, not assumed (spec §1, certainty). A change to a data
 * flow (a new third-party host, a new stored key, a new log line carrying user
 * input) is a change to this file in the same commit, or the policy is false.
 * Where each fact lives:
 *
 *   card number        server/src/services/card_balance.ts, routes/api.ts (masked log),
 *                      client/mobile/src/views/saldo.ts (remembered locally, MAX_CARDS)
 *   public CO proxies  server/src/services/proxy_manager.ts (CONNECT + verified TLS)
 *   location           client/src/main.ts, ui/planner.ts, utils/sessionLocation.ts,
 *                      services/router.ts (walking legs → FOSSGIS, `tm.walkroutes.v2`)
 *   IP fallback        server/src/routes/api.ts `/geoip` → get.geojs.io
 *   search text        server/src/services/geocode.ts, client/src/services/officialApi.ts
 *   install id         client/src/services/installId.ts (sent by the APK only)
 *   voice              mobile/…/VoicePlugin.java (platform recognizer, offline preferred)
 *   analytics / map    client/index.html (Cloudflare beacon), client/src/map.ts (CARTO)
 *
 * The text is Spanish (Colombia) and addresses the reader as "tú", as the app
 * does. Section content is trusted, authored HTML; the only interpolated values
 * are the constants below, and they are escaped.
 */

/** @param {unknown} value */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

/** The data controller (Ley 1581 de 2012, art. 3 e): a natural person, not a company. */
export const RESPONSABLE = {
  nombre: 'E. T. G.',
  correo: 'estebantorrg.dev@proton.me',
  ciudad: 'Bogotá D.C., Colombia',
};

const CORREO = `<a href="mailto:${esc(RESPONSABLE.correo)}">${esc(RESPONSABLE.correo)}</a>`;

/** One destinatario row of the privacy policy's section 3. */
function destinatario(nombre, pais, recibe) {
  return `<li><p class="legal-dest-head"><strong>${nombre}</strong> <span class="legal-dest-pais">${pais}</span></p><p>${recibe}</p></li>`;
}

/** One data item of section 2: what, why, on what authorisation, who gets it, how long. */
function dato(titulo, filas) {
  const rows = filas
    .map(([label, html]) => `<div class="legal-row"><dt>${label}</dt><dd>${html}</dd></div>`)
    .join('');
  return `<div class="legal-item"><h3>${titulo}</h3><dl>${rows}</dl></div>`;
}

/** @type {import('./legal').LegalDoc} */
export const PRIVACIDAD = {
  path: '/privacidad/',
  // The page names the controller, a natural person. It is there for the people
  // whose data it describes, which the law requires; it need not be a search
  // result that ties that person to the site for everyone else.
  noindex: true,
  titulo: 'Política de tratamiento de datos personales',
  breadcrumb: 'Política de privacidad',
  descripcion:
    'Qué datos trata este servicio de rutas de Bogotá, para qué, quién los recibe, cuánto tiempo se guardan y cómo ejercer tus derechos (Ley 1581 de 2012).',
  vigencia: '26 de septiembre de 2026',
  resumen: `
<p><strong>Aviso de privacidad.</strong> ${esc(RESPONSABLE.nombre)}, persona natural con domicilio en Bogotá, es el responsable del tratamiento de los datos personales que se procesan al usar este sitio web y su aplicación para Android (en adelante, «el servicio»).</p>
<p>El servicio no tiene cuentas de usuario: no te pide nombre, cédula, correo ni teléfono. Solo trata los datos que necesita para lo que tú le pides: el número de tu tarjeta tu llave cuando consultas su saldo, tu ubicación cuando la compartes para ver estaciones cercanas o planear un viaje, lo que escribes al buscar una dirección, y los datos técnicos de la conexión (como tu dirección IP) que recibe cualquier sitio web. No vende datos ni los usa para publicidad.</p>
<p>Tienes derecho a conocer, actualizar, rectificar y suprimir tus datos y a revocar tu autorización. Escribe a ${CORREO}. El detalle está en esta misma página.</p>`,
  secciones: [
    {
      titulo: '1. Quién es el responsable',
      html: `
<dl class="legal-facts">
  <div class="legal-row"><dt>Responsable</dt><dd>${esc(RESPONSABLE.nombre)} (persona natural)</dd></div>
  <div class="legal-row"><dt>Domicilio</dt><dd>${esc(RESPONSABLE.ciudad)}</dd></div>
  <div class="legal-row"><dt>Correo</dt><dd>${CORREO}, canal de atención para consultas y reclamos</dd></div>
</dl>
<p>El servicio es un proyecto independiente. No está afiliado a TRANSMILENIO S.A., ni patrocinado o respaldado por ella ni por ninguna otra entidad del Distrito.</p>
<p>Esta política cumple la Ley Estatutaria 1581 de 2012 y el Decreto 1377 de 2013, compilado en el Decreto Único Reglamentario 1074 de 2015.</p>`,
    },
    {
      titulo: '2. Qué datos tratamos, para qué y por cuánto tiempo',
      html: `
<p>Cada dato se usa solo para la finalidad que se indica. La base del tratamiento es tu autorización (artículo 9 de la Ley 1581 de 2012), que das de forma expresa o mediante conductas inequívocas (artículo 7 del Decreto 1377 de 2013), como se explica en cada caso. No tratamos datos sensibles: no usamos tu voz ni ningún otro rasgo para identificarte.</p>
${dato('2.1 Número de tu tarjeta tu llave', [
  ['Qué', 'El número de tu tarjeta, cuando lo escribes en la consulta de saldo. En la app para Android también puedes leer la tarjeta acercándola al teléfono (NFC).'],
  ['Para qué', 'Solo para consultar el saldo al sistema de TRANSMILENIO S.A. y mostrártelo. La respuesta trae el saldo y la fecha de la última transacción registrada, que puede tener hasta un día de atraso.'],
  ['Autorización', 'Expresa: la das al pulsar «Consultar» después de leer el aviso que aparece junto al campo.'],
  ['Quién lo recibe', 'En el sitio web, el número viaja cifrado a nuestro servidor, que lo envía al servidor de TRANSMILENIO S.A. Ese servidor solo responde a conexiones desde Colombia, así que el nuestro puede enviar la consulta a través de servidores proxy públicos ubicados en Colombia (sección 4). La conexión va cifrada de extremo a extremo y esos servidores no ven el número. En la app para Android, el teléfono consulta directamente a TRANSMILENIO S.A., sin pasar por nuestro servidor. La lectura NFC se hace dentro del teléfono y no se envía a nadie.'],
  ['Cuánto tiempo', 'No guardamos el número. Nuestro servidor lo tiene en memoria solo mientras dura la consulta, y en sus registros técnicos aparece enmascarado: solo los cuatro primeros y los cuatro últimos dígitos. La app para Android recuerda en el teléfono los últimos cinco números consultados, para que no tengas que escribirlos otra vez. Quedan ahí hasta que los quites de la lista, borres los datos de la app o la desinstales.'],
])}
${dato('2.2 Tu ubicación', [
  ['Qué', 'Las coordenadas de tu dispositivo, solo si concedes el permiso de ubicación del navegador o de Android. Si no lo concedes, el sitio web puede estimar una ubicación aproximada, a nivel de ciudad, a partir de tu dirección IP.'],
  ['Para qué', 'Mostrarte estaciones y paraderos cercanos, usar tu posición como punto de partida del planificador y, en la app, guiarte durante el viaje y responder preguntas por voz según dónde estás.'],
  ['Autorización', 'Expresa: la das con el permiso de ubicación del navegador o de Android, y puedes retirarla en cualquier momento en su configuración.'],
  ['Quién la recibe', 'Tu ubicación se procesa en tu dispositivo, con una excepción: para dibujar los tramos a pie de un viaje se envían el punto de inicio y el de llegada de cada tramo, que pueden ser tu ubicación, al servicio de rutas peatonales de FOSSGIS e.V. (routing.openstreetmap.de, Alemania). En el sitio web pasan por nuestro servidor; en la app salen directamente del teléfono. Para la ubicación aproximada, nuestro servidor envía tu dirección IP al servicio GeoJS (get.geojs.io).'],
  ['Cuánto tiempo', 'Nuestro servidor no guarda ubicaciones, aunque los puntos de un tramo a pie pueden quedar en los registros técnicos del alojamiento (2.3). En tu dispositivo, tu posición se guarda solo en memoria mientras usas la página. Las rutas a pie ya calculadas (hasta 250) y, en la app, los viajes recientes y el viaje en curso se guardan en el dispositivo hasta que borres los datos del sitio o de la app.'],
])}
${dato('2.3 Dirección IP y datos técnicos de la conexión', [
  ['Qué', 'Tu dirección IP, el tipo de navegador y de sistema operativo, la dirección de la página o del recurso que pides, y la fecha y hora. Los recibe cualquier servidor web al que te conectas.'],
  ['Para qué', 'Entregarte el sitio, mantenerlo seguro y funcionando (detectar errores y abusos) y medir su uso de forma agregada.'],
  ['Autorización', 'Por conducta inequívoca: al usar el servicio después de haber sido informado en este aviso. Sin estos datos no es técnicamente posible entregarte las páginas.'],
  ['Quién los recibe', 'Render Services, Inc. aloja nuestro servidor y guarda sus registros de acceso. Cloudflare, Inc. mide las visitas al sitio web con Cloudflare Web Analytics, que no usa cookies ni un identificador que te siga entre visitas o entre sitios. CARTO sirve las imágenes del mapa: tu navegador las descarga de sus servidores, que reciben tu dirección IP y la zona del mapa que estás viendo.'],
  ['Cuánto tiempo', 'Render conserva los registros del servidor por un máximo de 30 días y luego los elimina; no los exportamos ni los copiamos. Cloudflare Web Analytics nos muestra solo cifras agregadas.'],
])}
${dato('2.4 Búsquedas de direcciones y lugares', [
  ['Qué', 'El texto que escribes como origen o destino en el planificador, que puede ser una dirección.'],
  ['Para qué', 'Encontrar el lugar y sus coordenadas.'],
  ['Autorización', 'Expresa: la das al escribir la búsqueda.'],
  ['Quién la recibe', 'En el sitio web, nuestro servidor busca ese texto en Photon (Komoot GmbH, Alemania), Nominatim (OpenStreetMap Foundation, Reino Unido) y el geocodificador de ArcGIS (Esri, Estados Unidos). Esos servicios ven la dirección IP de nuestro servidor, no la tuya. En la app, el teléfono busca directamente en Photon.'],
  ['Cuánto tiempo', 'No guardamos las búsquedas, aunque pueden quedar en los registros técnicos del alojamiento (2.3). Tu navegador recuerda los últimos resultados solo mientras la página está abierta.'],
])}
${dato('2.5 Consultas de la app a TRANSMILENIO S.A. e identificador de instalación', [
  ['Qué', 'La app para Android pide directamente a los servidores de TRANSMILENIO S.A. la posición de los buses, las llegadas, los saldos y las capas del mapa, y esos servidores ven la dirección IP de tu teléfono. En las consultas en vivo y de saldo, la app envía además un identificador de instalación: un código aleatorio que crea al instalarse y que no contiene ni se deriva de ningún dato tuyo o de tu teléfono.'],
  ['Para qué', 'Recibir la información del sistema. El servidor de TRANSMILENIO S.A. exige un identificador de instalación en cada consulta y no responde sin él.'],
  ['Autorización', 'Por conducta inequívoca: al usar esas funciones de la app después de haber sido informado en este aviso.'],
  ['Quién lo recibe', 'Solo TRANSMILENIO S.A. Nosotros no recibimos ni el identificador ni tus consultas, porque la app no pasa por nuestro servidor. El sitio web también crea este código en tu navegador, pero no lo envía a ningún lado.'],
  ['Cuánto tiempo', 'El identificador se guarda en tu dispositivo hasta que borres los datos del sitio o de la app, o la desinstales. Lo que haga TRANSMILENIO S.A. con él se rige por su propia política.'],
])}
${dato('2.6 Voz (app para Android)', [
  ['Qué', 'Lo que dices cuando usas la función de voz.'],
  ['Para qué', 'Entender por qué ruta o parada preguntas y responderte en voz alta.'],
  ['Autorización', 'Expresa: la das con el permiso de micrófono de Android y al activar la función de voz.'],
  ['Quién la recibe', 'El audio lo procesa el servicio de reconocimiento de voz de tu teléfono. Si tienes instalado el paquete de español sin conexión, se procesa dentro del teléfono. Si no, ese servicio (normalmente el de Google) puede enviar el audio a sus servidores, según los términos que tienes aceptados con él. La app solo recibe el texto reconocido y no nos lo envía. La respuesta hablada también la genera el teléfono.'],
  ['Cuánto tiempo', 'No guardamos audio ni texto. La app guarda en el teléfono cuántas veces consultas cada ruta por voz, para sugerirte primero las que más usas, hasta que borres los datos de la app.'],
])}
${dato('2.7 Preferencias guardadas en tu dispositivo', [
  ['Qué', 'Tus favoritos, búsquedas recientes y capas del mapa y, en la app, las tarjetas y los viajes recientes (2.1, 2.2).'],
  ['Para qué', 'Que el servicio recuerde tus preferencias la próxima vez.'],
  ['Autorización', 'Por conducta inequívoca: al marcar un favorito, cambiar una capa o hacer una consulta.'],
  ['Quién las recibe', 'Nadie: se guardan en el almacenamiento local de tu navegador o de la app y no se envían. Si tienes activada la copia de seguridad de Android, el sistema puede incluir los datos de la app en la copia que Google guarda en tu cuenta, según los términos que tienes aceptados con Google.'],
  ['Cuánto tiempo', 'Hasta que las borres: en el navegador, borrando los datos de este sitio; en Android, desde Ajustes, Aplicaciones, Almacenamiento, Borrar datos, o desinstalando la app.'],
])}`,
    },
    {
      titulo: '3. Quién recibe datos y transferencias internacionales',
      html: `
<p>Estos son todos los terceros que reciben datos al usar el servicio. Ninguno los recibe para publicidad.</p>
<ul class="legal-dest">
${destinatario('Render Services, Inc.', 'Estados Unidos', 'Aloja nuestro servidor. Recibe tu dirección IP y las solicitudes que hace el sitio web, incluidos, mientras se procesan, el número de tarjeta, los puntos de los tramos a pie y las búsquedas. Actúa como encargado del tratamiento.')}
${destinatario('Cloudflare, Inc.', 'Estados Unidos', 'Mide las visitas al sitio web, sin cookies. Recibe tu dirección IP, la página visitada, la página de la que vienes, el tipo de navegador y los tiempos de carga. Actúa como encargado del tratamiento.')}
${destinatario('CARTO', 'Estados Unidos y España', 'Sirve las imágenes del mapa. Recibe tu dirección IP y la zona del mapa que estás viendo.')}
${destinatario('TRANSMILENIO S.A.', 'Colombia', 'Recibe el número de tarjeta que consultas. Desde la app, también tu dirección IP y el identificador de instalación (2.5). Trata esos datos como responsable de su propio sistema.')}
${destinatario('FOSSGIS e.V.', 'Alemania', 'Calcula las rutas a pie. Recibe los puntos de inicio y llegada de cada tramo; desde la app, también tu dirección IP.')}
${destinatario('Komoot GmbH (Photon)', 'Alemania', 'Busca direcciones. Recibe el texto de la búsqueda; desde la app, también tu dirección IP.')}
${destinatario('OpenStreetMap Foundation (Nominatim)', 'Reino Unido', 'Busca direcciones para el sitio web. Recibe el texto de la búsqueda desde nuestro servidor.')}
${destinatario('Esri (ArcGIS)', 'Estados Unidos', 'Busca direcciones para el sitio web. Recibe el texto de la búsqueda desde nuestro servidor.')}
${destinatario('GeoJS', 'Fuera de Colombia', 'Estima una ubicación aproximada. Recibe tu dirección IP, solo cuando no compartes tu ubicación y el sitio web la necesita.')}
${destinatario('Servidores proxy públicos', 'Colombia', 'Transportan tráfico cifrado entre nuestro servidor y TRANSMILENIO S.A. No pueden leer tus datos (sección 4).')}
</ul>
<p>Render y Cloudflare tratan los datos por nuestra cuenta, según los términos de protección de datos de sus servicios. Los demás los reciben como terceros independientes y los tratan según sus propias políticas.</p>
<p>Varios de estos destinatarios están fuera de Colombia. Estados Unidos, Alemania, España y el Reino Unido figuran en la lista de países con un nivel adecuado de protección de datos de la Superintendencia de Industria y Comercio (Circular Externa 005 de 2017), por lo que el artículo 26 de la Ley 1581 de 2012 permite enviarles datos. Para cualquier otro destino, al usar la función correspondiente después de conocer esta política autorizas de forma expresa esa transferencia.</p>`,
    },
    {
      titulo: '4. Los proxies públicos, en palabras simples',
      html: `
<p>El servidor de TRANSMILENIO S.A. que informa el saldo de las tarjetas y la posición de los buses solo responde a conexiones que vienen de Colombia, y nuestro servidor está fuera del país. Para llegar a él, nuestro servidor puede enviar la consulta a través de servidores proxy públicos: equipos de terceros ubicados en Colombia, tomados de listas públicas, que no controlamos ni conocemos.</p>
<ul>
  <li><strong>Lo que ven:</strong> la dirección IP de nuestro servidor, que la conexión va al servidor de TRANSMILENIO S.A., y cuándo.</li>
  <li><strong>Lo que no ven:</strong> tu número de tarjeta, la ruta que consultas ni la respuesta. El contenido viaja cifrado (HTTPS) de extremo a extremo, y nuestro servidor verifica el certificado de TRANSMILENIO S.A., así que un proxy no puede leerlo ni hacerse pasar por el destino.</li>
  <li><strong>Tu dirección IP tampoco:</strong> para ellos, quien pregunta es nuestro servidor, no tú.</li>
</ul>
<p>Si un proxy falla, la consulta se intenta por otro o no se completa; en ningún caso queda expuesto su contenido. La app para Android no usa estos proxies: tu teléfono, que ya está en Colombia, consulta directamente.</p>`,
    },
    {
      titulo: '5. Seguridad',
      html: `
<ul>
  <li>Las conexiones con el sitio web y con los servicios externos usan HTTPS.</li>
  <li>No tenemos bases de datos de usuarios. No guardamos números de tarjeta, ubicaciones, búsquedas ni audio.</li>
  <li>En los registros del servidor, los números de tarjeta aparecen enmascarados.</li>
  <li>A través de los proxies, el contenido va cifrado y se verifica el certificado del destino (sección 4).</li>
  <li>Solo el responsable tiene acceso a las cuentas de alojamiento y de analítica.</li>
</ul>`,
    },
    {
      titulo: '6. Niñas, niños y adolescentes',
      html: `
<p>El servicio no pide datos que identifiquen a nadie, tampoco a menores de edad. Si eres menor de edad, usa la consulta de saldo, la ubicación y la voz con la autorización de tu madre, tu padre o tu representante legal. Si eres representante de un menor y crees que tratamos sus datos, escríbenos a ${CORREO}.</p>`,
    },
    {
      titulo: '7. Tus derechos',
      html: `
<p>Como titular de los datos tienes derecho a (artículo 8 de la Ley 1581 de 2012):</p>
<ul>
  <li>Conocer, actualizar y rectificar tus datos personales.</li>
  <li>Pedir prueba de la autorización que diste, salvo en los casos en que la ley no la exige (artículo 10).</li>
  <li>Saber, si lo pides, qué uso se ha dado a tus datos.</li>
  <li>Presentar quejas ante la Superintendencia de Industria y Comercio, una vez hayas hecho la consulta o el reclamo ante nosotros.</li>
  <li>Revocar tu autorización y pedir que se supriman tus datos, salvo que un deber legal o contractual obligue a conservarlos.</li>
  <li>Acceder gratis a tus datos.</li>
</ul>
<p>Como el servicio no tiene cuentas y casi todo se guarda en tu dispositivo, la forma más rápida de suprimir esos datos es borrarlos tú mismo (2.7). Para los registros de nuestro servidor, indícanos la fecha, la hora aproximada y, si la conoces, tu dirección IP, porque sin eso no podemos saber cuáles son tuyos.</p>`,
    },
    {
      titulo: '8. Cómo ejercer tus derechos',
      html: `
<p>Escribe a ${CORREO}. Pueden hacerlo el titular, acreditando su identidad; sus causahabientes; su representante o apoderado; o quien actúe por estipulación a favor de otro.</p>
<h3>Consultas</h3>
<p>Si quieres saber qué datos tuyos tratamos, responderemos en un máximo de <strong>diez (10) días hábiles</strong> contados desde el día en que recibamos tu consulta. Si no podemos responder en ese plazo, te lo diremos antes de que venza, con los motivos y la fecha de respuesta, que no pasará de cinco (5) días hábiles después del primer plazo (artículo 14 de la Ley 1581 de 2012).</p>
<h3>Reclamos</h3>
<p>Si quieres corregir, actualizar o suprimir tus datos, revocar tu autorización o denunciar un incumplimiento, tu reclamo debe incluir tu identificación, la descripción de los hechos, la dirección física o electrónica donde quieres recibir la respuesta y los documentos que quieras hacer valer.</p>
<ul>
  <li>Si el reclamo está incompleto, te pediremos completarlo dentro de los cinco (5) días siguientes a recibirlo. Si pasan dos (2) meses sin que lo completes, se entenderá que desististe de él.</li>
  <li>Una vez recibido el reclamo completo, marcaremos los datos afectados con la leyenda «reclamo en trámite» en un máximo de dos (2) días hábiles.</li>
  <li>Responderemos en un máximo de <strong>quince (15) días hábiles</strong> contados desde el día siguiente a recibirlo. Si no podemos hacerlo en ese plazo, te diremos antes de que venza los motivos y la fecha de respuesta, que no pasará de ocho (8) días hábiles después del primer plazo (artículo 15 de la Ley 1581 de 2012).</li>
</ul>
<p>Si no estás conforme con la respuesta, puedes acudir a la Superintendencia de Industria y Comercio (<a href="https://www.sic.gov.co" rel="noopener">www.sic.gov.co</a>).</p>`,
    },
    {
      titulo: '9. Cambios a esta política',
      html: `
<p>Publicaremos cualquier cambio en esta página, con su nueva fecha. Si un cambio es sustancial, por ejemplo un nuevo responsable, nuevos datos o nuevas finalidades, lo avisaremos en el sitio web y en la app antes de aplicarlo. Si cambia la finalidad para la que tratamos un dato, te pediremos una nueva autorización.</p>`,
    },
    {
      titulo: '10. Vigencia',
      html: `
<p>Esta política rige desde el 26 de septiembre de 2026. Los datos se tratan durante los plazos que se indican en la sección 2 y, en todo caso, solo mientras el servicio esté en funcionamiento. Si el servicio se cierra, se eliminarán los registros que queden en nuestro servidor.</p>`,
    },
  ],
};

/** Every legal page, in the order the site lists them. */
export const LEGAL_DOCS = [PRIVACIDAD];

/**
 * The legal page that lives at `pathname`, or null. Matches with or without the
 * trailing slash (Express 301s `/privacidad` to `/privacidad/`, but a link typed
 * by hand or a Back entry can carry either) and case-insensitively, as the
 * route and estación pages do.
 *
 * @param {string} pathname
 */
export function legalDocForPath(pathname) {
  const clean = String(pathname ?? '').toLowerCase().replace(/\/+$/, '') + '/';
  return LEGAL_DOCS.find((doc) => doc.path === clean) ?? null;
}

/**
 * The document itself — title, date, notice, sections — without any page
 * chrome. The caller supplies the masthead (the app) or the rail and crumbs
 * (the prerender), so this is identical in both.
 *
 * @param {import('./legal').LegalDoc} doc
 */
export function legalDocHtml(doc) {
  const sections = doc.secciones
    .map((sec) => `<section class="legal-sec"><h2>${esc(sec.titulo)}</h2>${sec.html}</section>`)
    .join('\n');
  return `<article class="legal">
<header class="legal-head">
  <h1>${esc(doc.titulo)}</h1>
  <p class="legal-date">Vigente desde el ${esc(doc.vigencia)}</p>
</header>
<aside class="legal-summary" aria-label="Aviso de privacidad">${doc.resumen}</aside>
${sections}
</article>`;
}

/**
 * The legal pages' stylesheet, shared by the prerender (inlined, like
 * `TABLA_RUTERO_CSS`) and the app (`ensureLegalStyle`). Literal colours rather
 * than the app's tokens, because the static page ships before any stylesheet of
 * ours is guaranteed to exist; they are the same values the tokens hold. The
 * only token read is `--page-accent` / `--accent`, the tick every section title
 * carries on both page kinds.
 */
export const LEGAL_CSS = `
.legal { --legal-accent: var(--page-accent, var(--accent, #D8102D)); padding: 18px 0 8px; line-height: 1.6; color: #fff; }
.legal h1 { font-size: 1.6rem; font-weight: 700; line-height: 1.2; letter-spacing: -0.02em; margin: 0; }
.legal-date { margin: 6px 0 0; font-size: 0.85rem; color: rgba(255,255,255,.6); }
.legal-summary { margin: 18px 0 0; padding: 14px 16px; border: 1px solid rgba(255,255,255,.08); border-left: 3px solid var(--legal-accent); border-radius: 12px; background: rgba(18,18,18,.78); }
.legal-summary p { margin: 0; }
.legal-summary p + p { margin-top: 8px; }
.legal-sec { margin-top: 24px; padding-top: 18px; border-top: 1px solid rgba(255,255,255,.08); }
.legal-sec h2 { display: flex; align-items: center; gap: 9px; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: rgba(255,255,255,.6); margin: 0 0 12px; }
.legal-sec h2::before { content: ""; width: 3px; height: 13px; border-radius: 2px; background: var(--legal-accent); flex: none; }
.legal-sec h3 { font-size: 1rem; font-weight: 700; margin: 18px 0 6px; }
.legal-sec p { margin: 8px 0 0; color: rgba(255,255,255,.85); }
.legal-sec ul { margin: 8px 0 0; padding-left: 1.25rem; color: rgba(255,255,255,.85); }
.legal-sec li + li { margin-top: 4px; }
.legal a { color: #7DD3FC; text-decoration: underline; text-underline-offset: 3px; }
.legal-item { margin-top: 14px; padding: 12px 16px; border: 1px solid rgba(255,255,255,.08); border-radius: 12px; background: rgba(18,18,18,.78); }
.legal-item h3 { margin: 0 0 6px; }
.legal dl { margin: 0; }
.legal-row { display: grid; grid-template-columns: 8.5rem 1fr; gap: 2px 14px; padding: 6px 0; }
.legal-row + .legal-row { border-top: 1px solid rgba(255,255,255,.06); }
.legal-row dt { font-size: 0.75rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: rgba(255,255,255,.45); padding-top: 3px; }
.legal-row dd { margin: 0; color: rgba(255,255,255,.85); }
.legal-dest { list-style: none; padding: 0 !important; }
.legal-dest li { padding: 10px 0; border-top: 1px solid rgba(255,255,255,.06); margin: 0 !important; }
.legal-dest p { margin: 0; }
.legal-dest-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
.legal-dest-pais { font-size: 0.75rem; color: rgba(255,255,255,.45); }
@media (max-width: 560px) {
  .legal h1 { font-size: 1.3rem; }
  .legal-row { grid-template-columns: 1fr; }
}
`;

/** Adds `LEGAL_CSS` to the document once (client only). */
export function ensureLegalStyle() {
  if (typeof document === 'undefined' || document.getElementById('legal-css')) return;
  const style = document.createElement('style');
  style.id = 'legal-css';
  style.textContent = LEGAL_CSS;
  document.head.append(style);
}
