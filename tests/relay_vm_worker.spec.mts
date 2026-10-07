import { test, expect } from '@playwright/test';
import { webcrypto, createPublicKey, createVerify } from 'node:crypto';
import { tick } from '../scripts/relay-vm/worker/src/index.mjs';

/**
 * The Cloudflare Worker that keeps asking OCI for the free relay VM
 * (`scripts/relay-vm/worker`, spec §5.2.2a): one look and one launch request a
 * minute, never two VMs, a pause after a 429 or an error that waiting won't
 * fix, and silence once the VM exists. OCI and KV are faked; the request
 * signature is checked against the key's public half.
 */

const NOW = Date.UTC(2026, 9, 7, 3, 1); // minute 01: not a heartbeat minute
const CAPACITY = { status: 500, body: { code: 'InternalError', message: 'Out of host capacity.' } };

let pem = '';
let publicPem = '';

test.beforeAll(async () => {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const der = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
  const spki = Buffer.from(await webcrypto.subtle.exportKey('spki', pair.publicKey));
  publicPem = createPublicKey({ key: spki, format: 'der', type: 'spki' }).export({ type: 'spki', format: 'pem' }) as string;
});

interface Sent { method: string; url: string; headers: Record<string, string>; body?: string }
type Reply = { status: number; body: unknown } | Error;

/** A world: what KV holds, and what OCI answers to the look and to the launch. */
function world(options: { state?: object; list?: Reply; launch?: Reply } = {}) {
  let stored: string | null = options.state ? JSON.stringify(options.state) : null;
  const sent: Sent[] = [];
  let writes = 0;
  const env = {
    OCI_PRIVATE_KEY: pem,
    OCI_USER_OCID: 'ocid1.user.oc1..u',
    OCI_FINGERPRINT: 'aa:bb',
    OCI_TENANCY_OCID: 'ocid1.tenancy.oc1..t',
    OCI_REGION: 'sa-bogota-1',
    AVAILABILITY_DOMAIN: 'AD-1',
    SUBNET_ID: 'ocid1.subnet.oc1..s',
    IMAGE_ID: 'ocid1.image.oc1..i',
    STATE: {
      get: async () => (stored === null ? null : JSON.parse(stored)),
      put: async (_key: string, value: string) => { stored = value; writes += 1; },
    },
  };
  const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    sent.push({ method: init.method, url, headers: init.headers, body: init.body });
    const reply = init.method === 'GET' ? options.list ?? { status: 200, body: [] } : options.launch ?? CAPACITY;
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  };
  return {
    env, fetchImpl, sent,
    writes: () => writes,
    state: () => (stored === null ? null : JSON.parse(stored)),
    run: (now = NOW) => tick(now, env, fetchImpl),
  };
}

/** Rebuilds what OCI would verify from the request as it was sent. */
function signatureHolds(request: Sent): boolean {
  const auth = request.headers.authorization;
  const names = /headers="([^"]+)"/.exec(auth)![1].split(' ');
  const target = new URL(request.url);
  const signingString = names.map((name) => {
    if (name === '(request-target)') return `${name}: ${request.method.toLowerCase()} ${target.pathname}${target.search}`;
    if (name === 'host') return `host: ${target.host}`;
    if (name === 'content-length') return `content-length: ${Buffer.byteLength(request.body ?? '')}`;
    return `${name}: ${request.headers[name]}`;
  }).join('\n');
  return createVerify('RSA-SHA256').update(signingString).verify(publicPem, /signature="([^"]+)"/.exec(auth)![1], 'base64');
}

test.describe('relay VM worker', () => {
  test('a minute with no capacity: one look, one launch request, both signed', async () => {
    const w = world();
    expect(await w.run()).toMatchObject({ kind: 'capacity', status: 500, memory: 2 });
    expect(w.sent.map((request) => request.method)).toEqual(['GET', 'POST']);

    const [look, launch] = w.sent;
    expect(look.url).toBe('https://iaas.sa-bogota-1.oraclecloud.com/20160918/instances/?compartmentId=ocid1.tenancy.oc1..t&displayName=transmi-relay');
    expect(/headers="([^"]+)"/.exec(look.headers.authorization)![1]).toBe('(request-target) host x-date');
    expect(/headers="([^"]+)"/.exec(launch.headers.authorization)![1])
      .toBe('(request-target) host x-date x-content-sha256 content-type content-length');
    expect(launch.headers.authorization).toContain('keyId="ocid1.tenancy.oc1..t/ocid1.user.oc1..u/aa:bb"');
    expect(signatureHolds(look)).toBe(true);
    expect(signatureHolds(launch)).toBe(true);

    expect(JSON.parse(launch.body!)).toMatchObject({
      displayName: 'transmi-relay',
      shape: 'VM.Standard.A1.Flex',
      shapeConfig: { ocpus: 1, memoryInGBs: 2 },
      sourceDetails: { sourceType: 'image', imageId: 'ocid1.image.oc1..i', bootVolumeSizeInGBs: 50 },
      createVnicDetails: { subnetId: 'ocid1.subnet.oc1..s', assignPublicIp: true },
    });
  });

  test('deployed before its secrets are set: asks nothing', async () => {
    const w = world();
    w.env.OCI_PRIVATE_KEY = '';
    expect(await w.run()).toBeNull();
    expect(w.sent).toHaveLength(0);
  });

  test('sizes alternate by the minute', async () => {
    const w = world();
    expect(await w.run(NOW + 60_000)).toMatchObject({ memory: 6 });
    expect(await w.run(NOW + 120_000)).toMatchObject({ memory: 2 });
  });

  test('"no capacity" again is written only on the heartbeat minute', async () => {
    const w = world({ state: { last: { kind: 'capacity' } } });
    await w.run(NOW);
    await w.run(NOW + 60_000);
    expect(w.writes()).toBe(0);
    await w.run(Date.UTC(2026, 9, 7, 3, 10));
    expect(w.writes()).toBe(1);
    expect(w.state().last).toMatchObject({ kind: 'capacity', at: '2026-10-07T03:10:00.000Z' });
  });

  test('a launch ends it: recorded, and no request is ever sent again', async () => {
    const w = world({ launch: { status: 200, body: { id: 'ocid1.instance.oc1..new', lifecycleState: 'PROVISIONING' } } });
    expect(await w.run()).toMatchObject({ kind: 'launched', instanceId: 'ocid1.instance.oc1..new' });
    expect(w.state()).toMatchObject({ done: true, last: { kind: 'launched', instanceId: 'ocid1.instance.oc1..new' } });
    expect(await w.run(NOW + 60_000)).toBeNull();
    expect(w.sent).toHaveLength(2);
  });

  test('a VM that already exists is never launched twice', async () => {
    const w = world({ list: { status: 200, body: [{ id: 'ocid1.instance.oc1..old', lifecycleState: 'TERMINATED' }, { id: 'ocid1.instance.oc1..live', lifecycleState: 'RUNNING' }] } });
    expect(await w.run()).toEqual({ kind: 'exists', instanceId: 'ocid1.instance.oc1..live' });
    expect(w.sent.map((request) => request.method)).toEqual(['GET']);
    expect(w.state().done).toBe(true);
  });

  test('a terminated VM does not count as existing', async () => {
    const w = world({ list: { status: 200, body: [{ id: 'ocid1.instance.oc1..old', lifecycleState: 'TERMINATED' }] } });
    expect(await w.run()).toMatchObject({ kind: 'capacity' });
  });

  test('a 429 sits out five minutes, then asks again', async () => {
    const w = world({ launch: { status: 429, body: { code: 'TooManyRequests', message: 'Too many requests for the user' } } });
    expect(await w.run()).toMatchObject({ kind: 'throttled' });
    expect(await w.run(NOW + 4 * 60_000)).toBeNull();
    expect(w.sent).toHaveLength(2);
    expect(await w.run(NOW + 5 * 60_000)).toMatchObject({ kind: 'throttled' });
  });

  test('an error that waiting will not fix sits out ten minutes', async () => {
    const w = world({ launch: { status: 404, body: { code: 'NotAuthorizedOrNotFound', message: 'Authorization failed or requested resource not found.' } } });
    expect(await w.run()).toMatchObject({ kind: 'error', status: 404 });
    expect(await w.run(NOW + 9 * 60_000)).toBeNull();
    expect(await w.run(NOW + 10 * 60_000)).toMatchObject({ kind: 'error' });
  });

  test('when the look fails, nothing is launched that minute', async () => {
    const w = world({ list: { status: 503, body: { message: 'Service unavailable' } } });
    expect(await w.run()).toMatchObject({ kind: 'unclear', status: 503 });
    expect(w.sent.map((request) => request.method)).toEqual(['GET']);
    expect(w.state().pauseUntil).toBeUndefined();
  });

  test('a dropped launch is unclear, and the next minute looks before asking', async () => {
    const w = world({ launch: new Error('The operation was aborted due to timeout') });
    expect(await w.run()).toMatchObject({ kind: 'unclear' });
    expect(w.state().done).toBeUndefined();
    await w.run(NOW + 60_000);
    expect(w.sent.map((request) => request.method)).toEqual(['GET', 'POST', 'GET', 'POST']);
  });
});
