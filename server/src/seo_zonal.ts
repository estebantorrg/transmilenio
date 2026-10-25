/**
 * The zonal códigos that get a prerendered page (spec §5.5.4, §5.5.10).
 *
 * Batch 1, 2026-10-24: the 100 busiest SITP zonal códigos by weekday buses in
 * the 2026-09-29 GTFS (172 or more a weekday; 37 % of all zonal weekday buses),
 * leaving out the four códigos the catalog also files as TransMilenio (7, C15,
 * C25, 10-3), which already have a page.
 *
 * A fixed list rather than a ranking recomputed each build on purpose: a page
 * that appears with one GTFS build and goes with the next is a 404 Google has
 * already crawled. The next batch is added here once this one shows in Search
 * Console — at least ~60 % indexed, the troncal pages not losing ground — and
 * is measured through its own sitemap (`sitemap-zonales.xml`).
 */
export const ZONAL_PAGES: ReadonlySet<string> = new Set([
  '5-1', '5-2', '5-3', '5-4', '6-3', '7-2', '7-3', '8-10', '13-8', '14-1', '15-3', '15-4', '15-5',
  '16-5', '18-3', '19-1', '19-3', '19-6', '19-7', '19-8', '19-11', '19-12', '60', '94', '99',
  '111', '117', '139', '271', '330', '442', '466', '579', '580', '593', '599', '614', '621', '634',
  '661', '731', '740', '786', '796A', '806', '927', 'A002', 'A003', 'B237', 'B926', 'C201', 'C701',
  'D204', 'D237', 'E16A', 'E25', 'E44', 'F402', 'F407', 'F409', 'F414', 'F417', 'F511', 'F512',
  'G511', 'G512', 'G514', 'G524', 'G528', 'G536', 'H604', 'H625', 'H632', 'H640', 'H641', 'H710',
  'H726', 'H737', 'L822', 'P7', 'P24', 'P49', 'SE10', 'SE14', 'T04', 'T06', 'T12', 'T13', 'T21',
  'T25', 'T27', 'T40', 'T48', 'T52', 'T53', 'T163', 'T795', 'TC14', 'TC30', 'Z8',
]);
