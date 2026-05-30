// Deprecated: Google Apps Script egress is Google-hosted, not Colombian.
// Live tracking now requires server/src/colombia_live_relay.ts.

function doPost() {
  return ContentService
    .createTextOutput(JSON.stringify({
      success: false,
      error: 'Deprecated. Run the Colombia relay from a Colombian network instead.'
    }))
    .setMimeType(ContentService.MimeType.JSON);
}
