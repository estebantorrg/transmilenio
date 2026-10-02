import { test, expect } from '@playwright/test';
import { renderLlmsTxt } from '../server/src/llms_txt.ts';

/**
 * `/llms.txt` (`server/src/llms_txt.ts`): the site described for a language
 * model in the llmstxt.org shape, built from the same page lists the sitemaps
 * are, so it names every published page and nothing else.
 */

const O = 'https://transmilenio.onrender.com';

test.describe('llms.txt', () => {
  const txt = renderLlmsTxt({
    origin: O,
    routes: [
      { url: '/ruta/f19/', codigo: 'F19', origen: 'Portal Américas', destino: 'Portal Norte', tipo: 'TRONCAL' },
      { url: '/ruta/b11/', codigo: 'B11', origen: 'Portal Norte', destino: 'Av. Jiménez', tipo: 'TRONCAL' },
      { url: '/ruta/8-4/', codigo: '8-4', origen: 'Portal Américas', destino: 'Patio Bonito', tipo: 'ALIMENTADOR' },
      { url: '/ruta/m86/', codigo: 'M86', origen: '', destino: '', tipo: 'PADRON' },
      { url: '/ruta/x1/', codigo: 'X1', origen: 'A', destino: 'B', tipo: 'NUEVO' },
    ],
    stations: [
      { url: '/estacion/toberin-tm0028/', nombre: 'Toberín', corredor: 'Autonorte' },
      { url: '/estacion/calle-100-tm0018/', nombre: 'Calle 100 [Marketmedios]' },
    ],
    extra: [{ url: '/terminos/', titulo: 'Términos y condiciones de uso' }],
    repo: 'https://github.com/estebantorrg/transmilenio',
  });
  const lines = txt.split('\n');

  test('opens with a title and a one-paragraph summary', () => {
    expect(lines[0]).toBe('# TransMilenio Explorer');
    expect(lines[2]).toMatch(/^> .*no oficial.*No está afiliada a TRANSMILENIO S\.A\.$/);
  });

  test('lists every page as an absolute link, grouped and in order', () => {
    const secciones = lines.filter((l) => l.startsWith('## '));
    expect(secciones).toEqual([
      '## Páginas principales',
      '## Estaciones (2)',
      '## Rutas troncales (2)',
      '## Alimentadores (1)',
      '## Padrones y rutas urbanas (1)',
      '## Otras rutas de TransMilenio (1)',
      '## Optional',
    ]);
    // Codes in numeric order; a route without ends says nothing after its link.
    expect(txt.indexOf('[Ruta B11]')).toBeLessThan(txt.indexOf('[Ruta F19]'));
    expect(txt).toContain(`- [Ruta F19](${O}/ruta/f19/): Portal Américas ↔ Portal Norte`);
    expect(lines).toContain(`- [Ruta M86](${O}/ruta/m86/)`);
    expect(txt).toContain(`- [Toberín](${O}/estacion/toberin-tm0028/): Troncal Autonorte`);
    // A bracket in a name would break the link.
    expect(txt).toContain(`- [Calle 100 Marketmedios](${O}/estacion/calle-100-tm0018/)`);
    expect(txt).toContain(`- [Términos y condiciones de uso](${O}/terminos/)`);
    for (const l of lines.filter((x) => x.startsWith('- ['))) expect(l).toMatch(/^- \[[^\]]+\]\(https:\/\/[^)]+\)/);
  });
});
