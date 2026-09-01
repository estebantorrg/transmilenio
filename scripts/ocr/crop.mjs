// Crops a region out of a PNG and upscales it, via a chromium canvas.
// Windows OCR skips large solid-dark blocks on a busy page (it treats them as
// non-text); the same cell read in isolation, enlarged, comes back cleanly.
//
//   node crop.mjs <src.png> <out.png> <x> <y> <w> <h> [zoom]
//
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

export async function cropImage(page, srcPath, outPath, x, y, w, h, zoom = 3) {
  const b64 = readFileSync(srcPath).toString('base64');
  const url = await page.evaluate(
    async ({ b64, x, y, w, h, zoom }) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const cv = document.createElement('canvas');
      cv.width = Math.round(w * zoom);
      cv.height = Math.round(h * zoom);
      const ctx = cv.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, x, y, w, h, 0, 0, cv.width, cv.height);
      return cv.toDataURL('image/png');
    },
    { b64, x, y, w, h, zoom }
  );
  writeFileSync(outPath, Buffer.from(url.split(',')[1], 'base64'));
  return outPath;
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  const [src, out, x, y, w, h, zoom] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('about:blank');
  await cropImage(page, src, out, +x, +y, +w, +h, Number(zoom) || 3);
  console.log('ok', out);
  await browser.close();
}
