/**
 * How the app tells a new catalog from the one it cached (`catalogSignature`,
 * client/mobile/src/lib/cache.ts, spec §5.2.1b). It compared station and route
 * counts, so a release that only moved services between platforms changed no
 * count and every phone that updated kept the cached catalog: K43 stayed drawn
 * at CAD, F26/F51/M51 at Tintal while its vagones were under works.
 */

import { expect, test } from '@playwright/test';
import { catalogSignature } from '../client/mobile/src/lib/cache';
import type { MasterCatalogResponse } from '../client/src/types/catalog';

// One station, one route: the counts never move between the bodies below.
const body = (version?: string): MasterCatalogResponse =>
  ({ success: true, version, count: 1, data: { stations: { TM0001: {} }, routes: { K43: [] } } }) as unknown as MasterCatalogResponse;

test('two catalogs with the same counts are told apart by their content', () => {
  expect(catalogSignature(body('a1b2c3d4e5f60718'))).not.toBe(catalogSignature(body('0f9e8d7c6b5a4938')));
  expect(catalogSignature(body('a1b2c3d4e5f60718'))).toBe(catalogSignature(body('a1b2c3d4e5f60718')));
});

test('a catalog cached before the content hash existed is replaced', () => {
  expect(catalogSignature(body())).not.toBe(catalogSignature(body('a1b2c3d4e5f60718')));
});
