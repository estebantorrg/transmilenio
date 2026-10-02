import { test, expect } from '@playwright/test';
import { contentHash, dateLedger, shellHash } from '../server/src/seo_lastmod.ts';

/**
 * A sitemap page's `lastmod` is the day its content last changed
 * (`server/src/seo_lastmod.ts`). Every deploy used to date all 363 URLs today,
 * a signal Google learns to ignore.
 */

test.describe('sitemap lastmod', () => {
  test('a page keeps its date until what it says changes', () => {
    const previous = {
      '/ruta/b11/': ['aaaa', '2026-08-01'] as [string, string],
      '/ruta/f19/': ['bbbb', '2026-08-01'] as [string, string],
      '/ruta/gone/': ['cccc', '2026-08-01'] as [string, string],
    };
    const hashes = new Map([
      ['/ruta/b11/', 'aaaa'], // unchanged
      ['/ruta/f19/', 'dddd'], // changed
      ['/ruta/new/', 'eeee'], // new
    ]);
    expect(dateLedger(hashes, previous, '2026-10-02')).toEqual({
      '/ruta/b11/': ['aaaa', '2026-08-01'],
      '/ruta/f19/': ['dddd', '2026-10-02'],
      '/ruta/new/': ['eeee', '2026-10-02'],
    });
  });

  test('without a ledger to read, every page is dated today', () => {
    const ledger = dateLedger(new Map([['/', 'aaaa']]), null, '2026-10-02');
    expect(ledger['/']).toEqual(['aaaa', '2026-10-02']);
  });

  test('the hash follows the content, not the build', () => {
    expect(contentHash('t', 'd', [], '<p>x</p>')).toBe(contentHash('t', 'd', [], '<p>x</p>'));
    expect(contentHash('t', 'd', [], '<p>x</p>')).not.toBe(contentHash('t', 'd', [], '<p>y</p>'));
    // The home page is the shell, whose asset names change on every build.
    const shell = (h: string) =>
      `<script type="module" src="/assets/index-${h}.js"></script><link rel="stylesheet" href="/assets/index-${h}.css">`;
    expect(shellHash(shell('Bx9f3kQa'))).toBe(shellHash(shell('C7tZ01pe')));
    expect(shellHash(shell('Bx9f3kQa'))).not.toBe(shellHash(shell('Bx9f3kQa') + '<h1>nuevo</h1>'));
  });
});
