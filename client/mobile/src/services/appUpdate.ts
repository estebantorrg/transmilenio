/**
 * "Is there a newer release than the one running?" (spec §5.2.1b)
 *
 * The APK is installed by hand from the project's GitHub releases, so nothing
 * tells a rider that a release exists: the app they installed in August is the
 * app they have. This asks GitHub for the latest release at launch and, when it
 * is newer than the running build, hands the Inicio screen a version and a link
 * to its APK. Installing it is still the rider's tap — the releases share one
 * signing key, so it goes over the installed app and keeps its data.
 *
 * Nothing about the rider is sent: one unauthenticated GET, which GitHub sees
 * as an IP address and a user agent (privacy policy §2.3).
 *
 * shortcut: every build offers the GitHub APK, which is right while the app is
 * only sideloaded; Google Play forbids an app installed from it to point at an
 * update from anywhere else, so gate this off in a build submitted to Play
 * (`mobile/PLAY_DATA_SAFETY.md`).
 */

import { loadJSON, saveJSON } from '../lib/storage';

const REPO = 'estebantorrg/transmilenio';
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
/** The only place an update link may point: this repository's own release assets. */
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
const DISMISSED_KEY = 'tmgo.updateDismissed.v1';
const CHECK_TIMEOUT_MS = 8_000;

export interface AppRelease {
  /** `"1.26.3"` — the tag without its `v`. */
  version: string;
  /** Direct link to the release's APK. */
  url: string;
}

/** `"v1.26.3"` or `"1.26.3"` → `[1, 26, 3]`; anything else is not a release. */
export function parseVersion(text: unknown): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Whether `candidate` is a later release than `running`. A build with no
 * release version of its own (a local build reports the gradle default, `1.0`)
 * is older than every release, so it is offered the latest one.
 */
export function isNewer(candidate: string, running: string): boolean {
  const next = parseVersion(candidate);
  if (!next) return false;
  const current = parseVersion(running) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    if (next[i] !== current[i]) return next[i] > current[i];
  }
  return false;
}

/**
 * The release in GitHub's `releases/latest` answer, or `null` when it is not
 * one a rider can install: no version in the tag, no APK attached, or an APK
 * link that does not point at this repository's own releases — the link is
 * opened as it arrives, so where it may lead is checked here.
 */
export function releaseFromPayload(payload: any): AppRelease | null {
  const version = parseVersion(payload?.tag_name);
  if (!version || payload?.draft || payload?.prerelease) return null;
  const assets: any[] = Array.isArray(payload?.assets) ? payload.assets : [];
  const apk = assets.find((asset) =>
    typeof asset?.browser_download_url === 'string' &&
    asset.browser_download_url.startsWith(DOWNLOAD_PREFIX) &&
    asset.browser_download_url.endsWith('.apk')
  );
  return apk ? { version: version.join('.'), url: apk.browser_download_url } : null;
}

/** How an in-app install ended, as far as this process lived to see. */
export type InstallOutcome = 'instalada' | 'cancelada' | 'sin-permiso' | 'fallo';

/** `UpdatePlugin` reject codes → outcomes. Keep in step with `UpdatePlugin.java`. */
const INSTALL_OUTCOMES: Record<string, InstallOutcome> = {
  CANCELLED: 'cancelada',
  NOT_ALLOWED: 'sin-permiso',
};

interface UpdatePluginApi {
  install(options: { url: string }): Promise<void>;
  addListener(event: string, handler: (data: any) => void): Promise<{ remove: () => void }> | { remove: () => void };
}

function updatePlugin(): UpdatePluginApi | null {
  const cap = (window as any).Capacitor;
  const plugin = cap?.isNativePlatform?.() ? cap.Plugins?.AppUpdate : null;
  return plugin && typeof plugin.install === 'function' ? (plugin as UpdatePluginApi) : null;
}

/** Whether this build can install the release itself, or only link to it. */
export function canInstallInApp(): boolean {
  return updatePlugin() !== null;
}

/**
 * Download the release and hand it to the system installer, from inside the app
 * (`UpdatePlugin`). `onProgress` gets the download percentage, then `'instalando'`
 * once the system has the file.
 *
 * Never rejects. For an app replacing itself the usual ending is no ending at
 * all — Android stops the process to install over it — so `instalada` is only
 * seen when the system did not have to.
 */
export async function installUpdate(
  release: AppRelease,
  onProgress: (state: number | 'instalando') => void
): Promise<InstallOutcome> {
  const plugin = updatePlugin();
  if (!plugin) return 'fallo';
  // `addListener` hands back a handle on some bridge versions and a promise of
  // one on others (measured on a Pixel 6: a bare handle), so both are awaited.
  const listeners = [
    Promise.resolve(
      plugin.addListener('updateProgress', (data: { percent?: number }) => {
        if (typeof data?.percent === 'number' && data.percent >= 0) onProgress(data.percent);
      })
    ),
    Promise.resolve(plugin.addListener('updateInstalling', () => onProgress('instalando'))),
  ];
  try {
    await plugin.install({ url: release.url });
    return 'instalada';
  } catch (error) {
    console.warn('[update] in-app install did not complete:', error);
    return INSTALL_OUTCOMES[(error as { code?: string })?.code ?? ''] ?? 'fallo';
  } finally {
    for (const listener of listeners) void listener.then((handle) => handle.remove());
  }
}

/** The rider said "not now" to this version; a later one is offered again. */
export function dismissUpdate(version: string): void {
  saveJSON(DISMISSED_KEY, version);
}

/**
 * The release to offer, or `null`: not running as an installed app, nothing
 * newer, already dismissed, or GitHub could not be asked (offline, rate limit) —
 * an update notice is never worth an error on the home screen.
 *
 * shortcut: asks GitHub on every launch, and its unauthenticated limit is 60
 * requests an hour per IP — shared by everyone behind one carrier NAT. Keep the
 * answer for a day if the notice starts going missing.
 */
export async function findUpdate(): Promise<AppRelease | null> {
  const cap = (window as any).Capacitor;
  const appPlugin = cap?.Plugins?.App;
  if (!cap?.isNativePlatform?.() || typeof appPlugin?.getInfo !== 'function') return null;

  // A controller and a timer, not `AbortSignal.timeout`: the app runs on
  // whatever System WebView the phone has, and older ones do not have it.
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const { version: running } = await appPlugin.getInfo();
    const response = await fetch(LATEST_RELEASE_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;

    const release = releaseFromPayload(await response.json());
    if (!release || !isNewer(release.version, String(running ?? ''))) return null;
    return loadJSON<string>(DISMISSED_KEY) === release.version ? null : release;
  } catch (error) {
    console.warn('[update] could not check for a newer release:', error);
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}
