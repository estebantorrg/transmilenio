import { test, expect } from '@playwright/test';
import { getNovedades, pollNovedades } from '../server/src/services/novedades.ts';
import { ago, bannerPost, extractPosts, headline, postText } from '../shared/novedades.js';

/**
 * TransMilenio's #TMAhora posts read off its X profile page
 * (`server/src/services/novedades.ts`, spec §5.5.9). The page's server-rendered
 * data is the only contract, so the fixtures below copy its shape (October
 * 2026): the timeline as JSON serialised into a `value:"…"` string, one object
 * per post with `details`, the id in `edit_tweet_ids`, and the full text of a
 * long post in a `note_tweet`.
 */

const post = (o: { id: string; at: number; text: string; note?: string }) => ({
  content: {
    tweet_results: {
      rest_id: o.id,
      result: {
        __typename: 'Tweet',
        core: { user_results: { result: { core: { screen_name: 'TransMilenio' } } } },
        details: { created_at_ms: o.at, full_text: o.text, hashtag_entities: [{ indices: [2, 10], text: 'TMAhora' }] },
        edit_control: { edit_tweet_ids: [o.id] },
        ...(o.note && { note_tweet: { note_tweet_results: { result: { entity_set: { hashtags: [{ text: 'TMAhora' }] }, text: o.note } } } }),
        rest_id: o.id,
      },
    },
  },
});
const pageOf = (entries: ReturnType<typeof post>[]) =>
  `<script>…query:"{\\"count\\":20}",result:$R[22]={kind:"Result.Ok",value:${JSON.stringify(
    JSON.stringify({ data: { timeline: { instructions: [{ entries }] } } })
  )}}…</script>`;

const SHORT = '⏰ #TMAhora (5:13 p. m.)\n\n📍 Universidad Distrital, Sede Vivero.\n\n🔀 Los buses de TransMiZonal continúan los desvíos.';
const LONG = '⏰ #TMAhora (12:10 p. m.)\n\n👥 Usuarios afectados: 200.538\n\n📍 Carrera 10\n\n⛔️ Continúan los retornos de las rutas';

const page = pageOf([
  post({ id: '2110407543243546651', at: 1791997742000, text: SHORT }),
  post({ id: '2110418282796748857', at: 1791997902000, text: LONG.slice(0, 60), note: LONG }),
  post({ id: '2110000000000000001', at: 1791990000000, text: 'Recarga tu tarjeta en los puntos autorizados' }),
  post({ id: '2110000000000000002', at: 1791991000000, text: 'RT @Bogota: #TMAhora en la Caracas' }),
]);

test.describe('reading #TMAhora off the profile page', () => {
  test('one notice per post, newest first, with its link', () => {
    const posts = extractPosts(page);
    expect(posts.map((p) => p.id)).toEqual(['2110418282796748857', '2110407543243546651']);
    expect(posts[1]).toEqual({
      id: '2110407543243546651',
      at: 1791997742000,
      text: SHORT,
      url: 'https://x.com/TransMilenio/status/2110407543243546651',
    });
  });

  test('a long post is read from its note, not the cut-off text', () => {
    expect(extractPosts(page)[0].text).toBe(LONG);
  });

  test('posts that are not #TMAhora, and retweets, are left out', () => {
    expect(extractPosts(page).some((p) => /Recarga|RT @/.test(p.text))).toBe(false);
  });

  test('a page with no posts in it is a failed read, not a quiet city', async () => {
    const answer = (body: string, status = 200) => async () => new Response(body, { status });
    await pollNovedades(answer('<html>Inicia sesión</html>') as typeof fetch, 1791998000000);
    expect(getNovedades().status.lastError).toBe('no posts in the page');

    await pollNovedades(answer('', 429) as typeof fetch, 1791998100000);
    expect(getNovedades().status.lastError).toBe('HTTP 429');

    await pollNovedades(answer(page) as typeof fetch, 1791998200000);
    const { items, status } = getNovedades();
    expect(status).toEqual({ lastAttemptAt: 1791998200000, lastOkAt: 1791998200000, lastError: null });
    expect(items.map((p) => p.id)).toEqual(['2110418282796748857', '2110407543243546651']);
  });

  test('posts with no #TMAhora among them are a quiet stretch, and a good read', async () => {
    // 24 October 2026: the five newest were an opening, a campaign and a good-morning.
    const quiet = pageOf([
      post({ id: '2110000000000000003', at: 1791998300000, text: '🎉🚉 ¡Ya está en operación la nueva estación Calle 53!' }),
      post({ id: '2110000000000000004', at: 1791998250000, text: '¡Arrancamos! Bogotá ya se mueve' }),
    ]);
    await pollNovedades((async () => new Response(quiet)) as typeof fetch, 1791998400000);
    const { status } = getNovedades();
    expect(status.lastOkAt).toBe(1791998400000);
    expect(status.lastError).toBeNull();
  });

  test('a post reads as written, without its photo link or blank lines; its headline is what happened', () => {
    const text = '⏰ #TMAhora (5:13 p. m.)\n\n⚠️ Manifestación en la Circunvalar\n\n📍 Calle 10 https://t.co/abc123';
    expect(postText(text)).toBe('⏰ #TMAhora (5:13 p. m.)\n⚠️ Manifestación en la Circunvalar\n📍 Calle 10');
    expect(headline(text)).toBe('⚠️ Manifestación en la Circunvalar');
  });

  test('how long ago, as a rider says it', () => {
    const now = 1791998000000;
    expect(ago(now - 20_000, now)).toBe('hace un momento');
    expect(ago(now - 12 * 60_000, now)).toBe('hace 12 min');
    expect(ago(now - 150 * 60_000, now)).toBe('hace 2 h');
  });

  test('a notice is kept for a day', async () => {
    const dayLater = 1791997902000 + 24 * 3_600_000 + 1;
    await pollNovedades((async () => new Response('', { status: 503 })) as typeof fetch, dayLater);
    expect(getNovedades().items.map((p) => p.id)).toEqual([]);
  });
});

test('the banner shows a recent post the rider has not seen yet, and nothing else', () => {
  const now = Date.UTC(2026, 9, 14, 20);
  const post = (minutesAgo: number) => ({ id: String(minutesAgo), at: now - minutesAgo * 60_000, text: '#TMAhora', url: '' });
  const items = [post(12), post(40)];
  expect(bannerPost(items, 0, now)).toBe(items[0]);
  // Seen (opened or closed): down until TransMilenio posts again.
  expect(bannerPost(items, items[0].at, now)).toBeNull();
  expect(bannerPost([post(2), ...items], items[0].at, now)?.id).toBe('2');
  // Unseen but old: an old detour shown as current is worse than none.
  expect(bannerPost([post(4 * 60)], 0, now)).toBeNull();
  expect(bannerPost([], 0, now)).toBeNull();
});
