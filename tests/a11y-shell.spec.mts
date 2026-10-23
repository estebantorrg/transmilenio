import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * What WAVE (wave.webaim.org) flagged on the home page, kept from coming back:
 * icons a screen reader announced as unlabelled images, a search box with only
 * a placeholder, <label>s pointing at nothing, no <h1>.
 */

const ROOT = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');
const html = read('client/index.html');
const templates = readdirSync(new URL('client/src/', ROOT), { recursive: true })
  .map((f) => `client/src/${String(f).replaceAll('\\', '/')}`)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => [f, read(f)] as const);

test.describe('the app shell for a screen reader', () => {
  test('every inline icon is hidden or named', () => {
    for (const [file, source] of [['client/index.html', html] as const, ...templates]) {
      const bare = [...source.matchAll(/<svg\b[^>]*>/g)]
        .map((m) => m[0])
        .filter((tag) => !/aria-hidden="true"|role="img"|aria-label=/.test(tag));
      expect(bare, file).toEqual([]);
    }
  });

  test('every field has a name and every label a field', () => {
    const inputs = [...html.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]).filter((t) => !/type="hidden"/.test(t));
    for (const input of inputs) {
      const id = input.match(/id="([^"]+)"/)?.[1];
      const named = /aria-label(ledby)?=/.test(input) || (id !== undefined && html.includes(`for="${id}"`));
      expect(named, input).toBe(true);
    }
    for (const label of html.match(/<label\b[^>]*>/g) ?? []) expect(label).toMatch(/ for="/);
  });

  test('has one <h1>, and the logo beside the wordmark is decorative', () => {
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    for (const logo of html.match(/<img [^>]*src="\/icon-192\.png"[^>]*>/g) ?? []) expect(logo).toContain('alt=""');
  });
});
