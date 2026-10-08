// Keeps asking OCI for the Always Free relay VM in Bogotá until it gets one
// (spec §5.2.2a) — a Cloudflare Worker on a one-minute cron.
//
// Bogotá offers this tenancy a single Always Free compute shape —
// VM.Standard.A1.Flex (Ampere) — and it is usually "Out of host capacity".
// Capacity frees up at random and is taken again within minutes, so the asking
// has to be frequent and has to go on for as long as it takes: one launch
// request a minute, the pace the common retry scripts use against the launch
// API's rate limit.
//
// Each minute: look whether `transmi-relay` already exists (so there are never
// two, whatever happened to the previous attempt), then ask for it once. A 429
// is answered by sitting out a few minutes; an error that waiting won't fix by
// sitting out longer, so a broken setup doesn't hammer the API. Once the VM
// exists the worker does nothing more.
//
// State lives in one KV key (`state`): `done`, `pauseUntil`, and `last` — the
// latest outcome, refreshed every 10 minutes while nothing changes (the free
// plan allows 1,000 KV writes a day; a write per attempt would not fit). Every
// attempt is also logged (Workers Logs).

import { importKey, ociFetch } from './oci.mjs';

const NAME = 'transmi-relay';
// Public half only; the private key never leaves the maintainer's machine.
const SSH_PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBLmk666G716DTUh2g3kYzISOxlpY5lJ+znSZYv07TQC transmi-relay';
// The smallest this shape allows, every time: a host with room for a bigger
// machine has room for this one, so asking for more can only fail more often
// (it used to alternate 6 and 2 GB — half the attempts were harder to place for
// memory the relay doesn't need). Memory can be raised later on the same VM.
const MEMORY_GB = 1;
const THROTTLE_PAUSE_MS = 5 * 60_000;
const ERROR_PAUSE_MS = 10 * 60_000;
const HEARTBEAT_EVERY_MIN = 10;

async function readMessage(response) {
  const text = await response.text().catch(() => '');
  try {
    return String(JSON.parse(text).message ?? text).slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}

/** A response that is not the hoped-for one → what to do about it. */
async function refusal(response) {
  const message = await readMessage(response);
  if (response.status === 429) return { kind: 'throttled', status: 429, message };
  if (response.status >= 500) {
    // "Out of host capacity" comes as a 500. Any other 5xx is Oracle's trouble,
    // not ours: neither is a reason to slow down.
    return { kind: /capacity/i.test(message) ? 'capacity' : 'unclear', status: response.status, message };
  }
  return { kind: 'error', status: response.status, message };
}

/** One look and, if there is no VM, one launch request. */
export async function attempt(now, env, fetchImpl = fetch) {
  const api = `https://iaas.${env.OCI_REGION}.oraclecloud.com/20160918/instances/`;
  const call = {
    key: await importKey(env.OCI_PRIVATE_KEY),
    keyId: `${env.OCI_TENANCY_OCID}/${env.OCI_USER_OCID}/${env.OCI_FINGERPRINT}`,
    fetchImpl,
  };
  try {
    const query = new URLSearchParams({ compartmentId: env.OCI_TENANCY_OCID, displayName: NAME });
    const listed = await ociFetch({ ...call, method: 'GET', url: `${api}?${query}` });
    // Not knowing whether it exists is a reason not to launch this minute.
    if (!listed.ok) return refusal(listed);
    const existing = (await listed.json()).find((instance) => instance.lifecycleState !== 'TERMINATED');
    if (existing) return { kind: 'exists', instanceId: existing.id };

    const memory = MEMORY_GB;
    const launched = await ociFetch({
      ...call,
      method: 'POST',
      url: api,
      body: JSON.stringify({
        availabilityDomain: env.AVAILABILITY_DOMAIN,
        compartmentId: env.OCI_TENANCY_OCID,
        displayName: NAME,
        shape: 'VM.Standard.A1.Flex',
        shapeConfig: { ocpus: 1, memoryInGBs: memory },
        sourceDetails: { sourceType: 'image', imageId: env.IMAGE_ID, bootVolumeSizeInGBs: 50 },
        createVnicDetails: { subnetId: env.SUBNET_ID, assignPublicIp: true },
        metadata: { ssh_authorized_keys: SSH_PUBLIC_KEY },
      }),
    });
    if (!launched.ok) return { ...(await refusal(launched)), memory };
    return { kind: 'launched', instanceId: (await launched.json()).id, memory };
  } catch (error) {
    // A timeout or a dropped connection: the VM may or may not have been
    // created. The next minute's look settles it.
    return { kind: 'unclear', message: String(error?.message ?? error).slice(0, 200) };
  }
}

/** One cron minute. Returns the outcome, or null when it sat this one out. */
export async function tick(now, env, fetchImpl = fetch) {
  // Deployed before its secrets were set: nothing to ask with yet.
  if (!env.OCI_PRIVATE_KEY) return null;
  const state = (await env.STATE.get('state', 'json')) ?? {};
  if (state.done || (state.pauseUntil ?? 0) > now) return null;

  const outcome = await attempt(now, env, fetchImpl);
  console.log(JSON.stringify(outcome));

  const next = { last: { at: new Date(now).toISOString(), ...outcome } };
  if (outcome.kind === 'launched' || outcome.kind === 'exists') next.done = true;
  if (outcome.kind === 'throttled') next.pauseUntil = now + THROTTLE_PAUSE_MS;
  if (outcome.kind === 'error') next.pauseUntil = now + ERROR_PAUSE_MS;
  // "No capacity" again is the ordinary minute: only worth a write as a heartbeat.
  const sameOldNo = outcome.kind === 'capacity' && state.last?.kind === 'capacity';
  const heartbeat = new Date(now).getUTCMinutes() % HEARTBEAT_EVERY_MIN === 0;
  if (!sameOldNo || heartbeat) await env.STATE.put('state', JSON.stringify(next));
  return outcome;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(event.scheduledTime, env));
  },
};
