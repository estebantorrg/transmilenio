import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * The logo is the name as outlines (`client/public/wordmark.svg`). One file is
 * drawn by the site, the app and the share cards, and it must never depend on
 * a font being there to draw it.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const svg = read('client/public/wordmark.svg');

test.describe('the wordmark', () => {
  test('is outlines only — no text, no font to wait for', () => {
    expect(svg).toMatch(/<path [^>]*d="M/);
    expect(svg).not.toMatch(/<text|font-family|@font-face|<image|href=/);
  });

  test('has the box and the single path the share cards read', () => {
    // `prepareWordmark` (server/src/seo_og.ts) takes exactly these two.
    expect(svg).toMatch(/viewBox="0 0 [\d.]+ [\d.]+"/);
    expect(svg.match(/ d="/g)).toHaveLength(1);
  });

  test('names the site for a reader who cannot see it', () => {
    expect(svg).toContain('aria-label="MiTrasto"');
    for (const page of ['client/index.html', 'client/mobile/index.html']) {
      expect(read(page), page).toMatch(/<img [^>]*src="\/wordmark\.svg" alt="MiTrasto"/);
    }
  });
});
