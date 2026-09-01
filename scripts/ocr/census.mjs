// Classifies each plegable by template. The "Cuando el bus va hacia" label
// appears once per rutero, so counting it separates the templates that carry a
// rutero from the ones that do not (circulares/alimentadores show horario
// pico/valle and no rutero at all).
//
//   node census.mjs <listfile>     # one PDF path per line
//
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import { chromium } from 'playwright';
import { startServer, renderPdf } from './render.mjs';

const OUT = '_census';
mkdirSync(OUT, { recursive: true });

const list = readFileSync(process.argv[2], 'utf8')
  .split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

const { server, port } = await startServer();
const browser = await chromium.launch();
const rows = [];

for (const pdf of list) {
  const stem = basename(pdf).replace(/\.pdf$/i, '');
  try {
    const pages = await renderPdf(browser, `http://127.0.0.1:${port}/`, pdf, OUT, 1500);
    const png = pages[0].file;
    const jf = png.replace(/\.png$/, '.json');
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'ocr.ps1',
      '-Image', png, '-Out', jf], { stdio: 'pipe' });
    const j = JSON.parse(readFileSync(jf, 'utf8'));
    const anchors = j.lines.filter((l) => /va\s*hacia/i.test(l.text)).length;
    const pico = j.lines.some((l) => /funcionamiento\s+pico|operation\s+pico/i.test(l.text));
    rows.push({ stem, pages: pages.length, anchors, pico });
    const tag = anchors === 2 ? 'RUTERO' : anchors === 0 ? 'SIN   ' : `RARO(${anchors})`;
    console.log(`${tag} ${pico ? 'pico' : '    '} p${pages.length}  ${stem}`);
  } catch (e) {
    rows.push({ stem, err: true });
    console.log(`ERROR           ${stem}  ${String(e.message).slice(0, 45)}`);
  }
}

const n = (f) => rows.filter(f).length;
console.log(`\nRESUMEN n=${rows.length}  rutero=${n(r => r.anchors === 2)}  sin=${n(r => r.anchors === 0)}  raro=${n(r => r.anchors > 0 && r.anchors !== 2)}  pico=${n(r => r.pico)}  error=${n(r => r.err)}`);

await browser.close();
server.close();
rmSync(OUT, { recursive: true, force: true });
