// Renders page 1 of each given PDF, OCRs it, and prints a compact geometric
// summary. Used to check how far the rutero layout generalises before writing
// the structural extractor against it.
//
//   node probe.mjs <pdf...>
//
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { chromium } from 'playwright';
import { startServer, renderPdf } from './render.mjs';

const OUT = '_probe';
mkdirSync(OUT, { recursive: true });

function ocr(png) {
  const out = png.replace(/\.png$/, '.json');
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'ocr.ps1',
    '-Image', png, '-Out', out], { stdio: 'pipe' });
  return JSON.parse(readFileSync(out, 'utf8'));
}

const { server, port } = await startServer();
const browser = await chromium.launch();

for (const pdf of process.argv.slice(2)) {
  const stem = basename(pdf).replace(/\.pdf$/i, '');
  let pages;
  try {
    pages = await renderPdf(browser, `http://127.0.0.1:${port}/`, pdf, OUT, 2400);
  } catch (e) { console.log(`\n### ${stem}\n  RENDER ERROR: ${e.message.slice(0, 80)}`); continue; }

  const j = ocr(pages[0].file);
  console.log(`\n### ${stem}   ${j.width}x${j.height}  paginas=${pages.length}`);

  // "Cuando el bus va hacia" appears once per rutero -> tells us how many there are
  const anchors = j.lines.filter(l => /va hacia/i.test(l.text)).map(l => l.words[0].x);
  // Big text is the rutero content: code, destino, corredor+hito rows
  const big = j.lines
    .filter(l => l.words.length && l.words[0].h >= 32 && l.words[0].y < j.height * 0.45)
    .sort((a, b) => a.words[0].y - b.words[0].y || a.words[0].x - b.words[0].x);
  const horario = j.lines.filter(l => /\d\s*:\s*\d{2}|a\.\s*m\.|p\.\s*m\./i.test(l.text)).map(l => l.text);
  const vig = j.lines.map(l => l.text).find(t => /20\d\d/.test(t) && /[A-ZÁÉÍÓÚ]{3,}/.test(t));

  console.log(`  anclas "va hacia": ${anchors.length} en x=[${anchors.join(', ')}]`);
  for (const l of big) {
    const w = l.words[0];
    console.log(`    y${String(w.y).padStart(4)} x${String(w.x).padStart(5)} h${String(w.h).padStart(3)}  ${JSON.stringify(l.text)}`);
  }
  console.log(`  horario: ${JSON.stringify(horario)}`);
  console.log(`  vigencia?: ${JSON.stringify(vig ?? null)}`);
}

await browser.close();
server.close();
