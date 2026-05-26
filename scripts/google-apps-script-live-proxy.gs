var LIVE_API_HOST = 'tmsa-transmiapp-shvpc.uc.r.appspot.com';
var COLOMBIA_CLIENT_IP = '181.50.0.1';

function jsonOutput(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function addName(candidates, value) {
  var text = String(value || '').trim();
  if (!text) return;

  var parts = text.split(/\s+[-–—]\s+/).map(function (part) {
    return part.trim();
  }).filter(Boolean);

  if (parts.length > 1) parts.reverse();
  parts.forEach(function (part) {
    if (candidates.indexOf(part) === -1) candidates.push(part);
  });

  if (candidates.indexOf(text) === -1) candidates.push(text);
}

function liveRequest(payload, name) {
  var isZonal = payload.action === 'zonal' || payload.type === 'zonal';
  var ruta = String(payload.ruta || '').trim();
  var url = isZonal
    ? 'https://' + LIVE_API_HOST + '/location/ruta?ruta=' + encodeURIComponent(ruta)
    : 'https://' + LIVE_API_HOST + '/buses';

  var headers = {
    'Accept-Encoding': 'identity',
    'Appid': '9a2c3b48f0c24ae9bfba38e94f27c3ea',
    'User-Agent': 'okhttp/4.12.0',
    'uuid': 'fd1be953-d85e-4c63-8c23-234f143f445d',
    'version': '2.9.5',
    'X-Forwarded-For': COLOMBIA_CLIENT_IP,
    'X-Real-IP': COLOMBIA_CLIENT_IP,
    'Forwarded': 'for=' + COLOMBIA_CLIENT_IP
  };

  var options = {
    method: 'post',
    headers: headers,
    muteHttpExceptions: true
  };

  if (!isZonal) {
    options.contentType = 'application/json; charset=UTF-8';
    options.payload = JSON.stringify({ ruta: ruta, Nombre: name });
  }

  var response = UrlFetchApp.fetch(url, options);
  var text = response.getContentText();
  var parsed = JSON.parse(text);
  if (response.getResponseCode() !== 200 || parsed.status >= 400) {
    throw new Error('Status: ' + response.getResponseCode() + ' ' + text.slice(0, 160));
  }
  return parsed;
}

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    var isZonal = payload.action === 'zonal' || payload.type === 'zonal';
    var candidates = [];

    if (Array.isArray(payload.nombreCandidates)) {
      payload.nombreCandidates.forEach(function (name) { addName(candidates, name); });
    }
    addName(candidates, payload.Nombre);
    addName(candidates, payload.nombre);

    if (isZonal) {
      return jsonOutput(liveRequest(payload, ''));
    }

    var errors = [];
    for (var i = 0; i < candidates.length; i++) {
      try {
        return jsonOutput(liveRequest(payload, candidates[i]));
      } catch (err) {
        errors.push(candidates[i] + ': ' + err.toString());
      }
    }

    return jsonOutput({ success: false, error: errors.join(' | ') });
  } catch (err) {
    return jsonOutput({ success: false, error: err.toString() });
  }
}
