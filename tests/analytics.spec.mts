import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * Cloudflare Web Analytics (`client/index.html`, spec §5.5.4) loads on the
 * published site and never on a development copy: the dev server and this very
 * test runner (127.0.0.1) used to count as visits and outnumbered the real ones.
 *
 * The rule is an inline script, so it is read out of the page source and asked
 * about each kind of host; the page test then checks that this run — a
 * loopback host — really stays silent.
 */

const source = readFileSync(new URL('../client/index.html', import.meta.url), 'utf8');
const rule = /if \((\/.+\/)\.test\(host\)\) return;/.exec(source);

/** Whether the page would skip analytics on this hostname. */
function skipped(host: string): boolean {
  const [, body, flags] = /^\/(.*)\/([a-z]*)$/.exec(rule![1])!;
  return new RegExp(body, flags).test(host);
}

test.describe('analytics stay off development copies', () => {
  test('the page decides by hostname', () => {
    expect(rule).toBeTruthy();
  });

  test('skips localhost, loopback and private-network hosts', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]', 'app.localhost', '192.168.1.20', '10.0.2.2', '172.16.0.5', '172.31.255.1']) {
      expect(skipped(host), host).toBe(true);
    }
  });

  test('loads on the published site and on any other public host', () => {
    for (const host of ['transmilenio.onrender.com', 'example.com', 'localhost.example.com', '172.15.0.1', '172.32.0.1', '11.0.0.1', '8.8.8.8']) {
      expect(skipped(host), host).toBe(false);
    }
  });

  test('this run, on a loopback host, sends nothing to Cloudflare', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('cloudflareinsights.com')) asked.push(request.url());
    });
    await page.goto('/');
    await page.waitForLoadState('load');
    await expect(page.locator('script[data-cf-beacon]')).toHaveCount(0);
    expect(asked).toEqual([]);
  });
});
