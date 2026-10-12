import { test, expect } from '@playwright/test';
import { retiredHostRedirect } from '../server/src/retired_host.ts';

/**
 * The move to mitrasto.app (`server/src/retired_host.ts`): pages on the old
 * host redirect for good, and everything an installed APK or a crawler still
 * needs there keeps answering in place.
 */

const OLD = 'transmilenio.onrender.com';

test.describe('pages on the retired host follow the site', () => {
  test('a page redirects to the same path and query on the new host', () => {
    expect(retiredHostRedirect('GET', OLD, '/')).toBe('https://mitrasto.app/');
    expect(retiredHostRedirect('GET', OLD, '/ruta/f19/')).toBe('https://mitrasto.app/ruta/f19/');
    expect(retiredHostRedirect('HEAD', OLD, '/privacidad/?utm=x')).toBe('https://mitrasto.app/privacidad/?utm=x');
  });

  test('the API stays on the old host — an installed APK posts to it', () => {
    for (const url of ['/api', '/api/health', '/api/troncal/master-catalog?v=2']) {
      expect(retiredHostRedirect('GET', OLD, url), url).toBeNull();
    }
    expect(retiredHostRedirect('POST', OLD, '/api/buses')).toBeNull();
    expect(retiredHostRedirect('POST', OLD, '/')).toBeNull();
  });

  test('a path that only starts like the API is still a page', () => {
    expect(retiredHostRedirect('GET', OLD, '/apicultura/')).toBe('https://mitrasto.app/apicultura/');
  });

  test('files stay: robots.txt, the Search Console token, the service worker', () => {
    for (const url of ['/robots.txt', '/googlebb8cb92194ccf198.html', '/sw.js', '/assets/index-abc.js', '/og-card.png']) {
      expect(retiredHostRedirect('GET', OLD, url), url).toBeNull();
    }
  });

  test('the new host, and any other, is served where it was asked', () => {
    for (const host of ['mitrasto.app', 'www.mitrasto.app', 'localhost', 'evil.transmilenio.onrender.com.example']) {
      expect(retiredHostRedirect('GET', host, '/'), host).toBeNull();
    }
  });
});
