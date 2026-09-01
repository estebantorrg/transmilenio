// Rasterises a PDF to PNG pages using pdf.js on a real chromium canvas.
//
// Why this shape: headless chromium treats a .pdf navigation as a download rather
// than rendering it, and this machine has no poppler / ImageMagick / Ghostscript.
// pdf.js needs a real http origin because chromium refuses dynamic ES-module
// imports from file:// and about:blank, hence the throwaway loopback server.
//
//   node render.mjs <input.pdf> <outDir> [targetWidthPx]
//
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join, resolve, extname } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const HERE = resolve(import.meta.dirname);
const TYPES = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.html': 'text/html', '.map': 'application/json' };

/** Serves scripts/ocr over loopback so pdf.js can be imported as a module. */
export function startServer() {
  const server = createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    if (rel === '' || rel === 'index.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><meta charset="utf-8"><title>render</title>');
    }
    const file = join(HERE, rel);
    if (!file.startsWith(HERE) || !existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port })));
}

export async function renderPdf(browser, origin, pdfPath, outDir, targetWidth = 1600) {
  const bytes = readFileSync(pdfPath);
  mkdirSync(outDir, { recursive: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(origin);

  let pngs;
  try {
    pngs = await page.evaluate(
      async ({ b64, targetWidth }) => {
        const lib = await import('/node_modules/pdfjs-dist/build/pdf.min.mjs');
        lib.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs';
        const raw = atob(b64);
        const data = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
        const doc = await lib.getDocument({ data }).promise;
        const out = [];
        for (let n = 1; n <= doc.numPages; n++) {
          const pg = await doc.getPage(n);
          const natural = pg.getViewport({ scale: 1 }).width;
          const vp = pg.getViewport({ scale: targetWidth / natural });
          const cv = document.createElement('canvas');
          cv.width = Math.ceil(vp.width);
          cv.height = Math.ceil(vp.height);
          await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
          const url = cv.toDataURL('image/png');
          // White-on-dark cells (the destino band and the highlighted corredor chip)
          // are invisible to Windows OCR; an inverted copy makes them readable and
          // the two passes get merged downstream.
          const ctx = cv.getContext('2d');
          const img = ctx.getImageData(0, 0, cv.width, cv.height);
          const px = img.data;
          for (let i = 0; i < px.length; i += 4) {
            px[i] = 255 - px[i]; px[i + 1] = 255 - px[i + 1]; px[i + 2] = 255 - px[i + 2];
          }
          ctx.putImageData(img, 0, 0);
          out.push({ n, w: cv.width, h: cv.height, url, inv: cv.toDataURL('image/png') });
        }
        return out;
      },
      { b64: bytes.toString('base64'), targetWidth }
    );
  } finally { await page.close(); }

  if (!pngs?.length) throw new Error(errors[0] ?? 'sin páginas');
  const stem = basename(pdfPath).replace(/\.pdf$/i, '');
  return pngs.map(({ n, w, h, url, inv }) => {
    const file = join(outDir, `${stem}__p${n}.png`);
    const fileInv = join(outDir, `${stem}__p${n}_inv.png`);
    writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
    writeFileSync(fileInv, Buffer.from(inv.split(',')[1], 'base64'));
    return { file, fileInv, page: n, w, h };
  });
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  const [pdf, outDir, scale] = process.argv.slice(2);
  const { server, port } = await startServer();
  const browser = await chromium.launch();
  try {
    for (const r of await renderPdf(browser, `http://127.0.0.1:${port}/`, pdf, outDir ?? '.', Number(scale) || 1600)) {
      console.log(`  ${r.file}  ${r.w}x${r.h}`);
    }
  } finally { await browser.close(); server.close(); }
}
