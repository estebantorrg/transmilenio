import { test, expect } from '@playwright/test';
import { getNovedades, pollNovedades } from '../server/src/services/novedades.ts';
import { ago, bannerPost, extractPosts, headline, postText } from '../shared/novedades.js';

/**
 * TransMilenio's #TMAhora posts read off its X profile page
 * (`server/src/services/novedades.ts`, spec §5.5.9). The page's server-rendered
 * data is the only contract, so the fixtures below copy its shape: one block
 * per post opening with `details:`, the id in `edit_tweet_ids`, and the full
 * text of a long post in a `note_tweet` further on.
 */

const post = (o: { id: string; at: number; text: string; note?: string }) =>
  `rest_id:"${o.id}",result:$R[1]={__typename:"Tweet",core:$R[2]={user_results:$R[3]={result:$R[4]={core:$R[5]={screen_name:"TransMilenio"}}}},` +
  `details:$R[6]={cashtag_entities:$R[7]=[],created_at_ms:${o.at},display_text_range:$R[8]=[0,277],full_text:${JSON.stringify(o.text)},` +
  `hashtag_entities:$R[9]=[$R[10]={indices:$R[11]=[2,10],text:"TMAhora"}]},edit_control:$R[12]={edit_tweet_ids:$R[13]=["${o.id}"]},` +
  (o.note
    ? `note_tweet:$R[14]={note_tweet_results:$R[15]={result:$R[16]={entity_set:$R[17]={hashtags:$R[18]=[$R[19]={text:"TMAhora"}]},rest_id:"9${o.id}",text:${JSON.stringify(o.note)}}}},`
    : '') +
  `legacy:$R[20]={lang:"es"}`;

const SHORT = '⏰ #TMAhora (5:13 p. m.)\n\n📍 Universidad Distrital, Sede Vivero.\n\n🔀 Los buses de TransMiZonal continúan los desvíos.';
const LONG = '⏰ #TMAhora (12:10 p. m.)\n\n👥 Usuarios afectados: 200.538\n\n📍 Carrera 10\n\n⛔️ Continúan los retornos de las rutas';

const page = [
  post({ id: '2110407543243546651', at: 1791997742000, text: SHORT }),
  post({ id: '2110418282796748857', at: 1791997902000, text: LONG.slice(0, 60), note: LONG }),
  post({ id: '2110000000000000001', at: 1791990000000, text: 'Recarga tu tarjeta en los puntos autorizados' }),
  post({ id: '2110000000000000002', at: 1791991000000, text: 'RT @Bogota: #TMAhora en la Caracas' }),
].join(',');

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
    expect(getNovedades().status.lastError).toBe('no #TMAhora posts in the page');

    await pollNovedades(answer('', 429) as typeof fetch, 1791998100000);
    expect(getNovedades().status.lastError).toBe('HTTP 429');

    await pollNovedades(answer(page) as typeof fetch, 1791998200000);
    const { items, status } = getNovedades();
    expect(status).toEqual({ lastAttemptAt: 1791998200000, lastOkAt: 1791998200000, lastError: null });
    expect(items.map((p) => p.id)).toEqual(['2110418282796748857', '2110407543243546651']);
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
