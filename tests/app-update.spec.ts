/**
 * The app's update notice (spec §5.2.1b).
 *
 * The APK is installed by hand, so the app asks GitHub for the latest release
 * and offers it when it is newer than the running build. These pin the two
 * decisions that matter: which release counts as newer, and that the link the
 * rider is sent to can only be this repository's own APK.
 */

import { expect, test } from '@playwright/test';
import { isNewer, parseVersion, releaseFromPayload } from '../client/mobile/src/services/appUpdate';

const APK = 'https://github.com/estebantorrg/transmilenio/releases/download/v1.26.3/transmilenio-explorer-v1.26.3.apk';
const release = (extra: object = {}) => ({
  tag_name: 'v1.26.3',
  draft: false,
  prerelease: false,
  assets: [{ name: 'transmilenio-explorer-v1.26.3.apk', browser_download_url: APK }],
  ...extra,
});

test.describe('which release is newer', () => {
  test('versions compare as numbers, part by part', () => {
    expect(parseVersion('v1.26.3')).toEqual([1, 26, 3]);
    expect(isNewer('1.26.3', '1.26.2')).toBe(true);
    // 1.9 is older than 1.10 — a string comparison says the opposite.
    expect(isNewer('1.10.0', '1.9.9')).toBe(true);
    expect(isNewer('2.0.0', '1.99.99')).toBe(true);
    expect(isNewer('1.26.2', '1.26.2')).toBe(false);
    expect(isNewer('1.26.1', '1.26.2')).toBe(false);
  });

  test('a build with no release version is offered the latest', () => {
    // A local build reports the gradle default.
    expect(isNewer('1.26.3', '1.0')).toBe(true);
    expect(isNewer('1.26.3', '')).toBe(true);
  });

  test('a tag that is not a version offers nothing', () => {
    expect(parseVersion('nightly')).toBeNull();
    expect(isNewer('nightly', '1.26.2')).toBe(false);
    expect(isNewer('1.26', '1.0')).toBe(false);
  });
});

test.describe('what the rider is sent to', () => {
  test('the latest release becomes a version and its APK', () => {
    expect(releaseFromPayload(release())).toEqual({ version: '1.26.3', url: APK });
  });

  test('a release with nothing to install offers nothing', () => {
    expect(releaseFromPayload(release({ assets: [] }))).toBeNull();
    expect(releaseFromPayload(release({ assets: [{ browser_download_url: APK.replace('.apk', '.zip') }] }))).toBeNull();
    expect(releaseFromPayload(release({ draft: true }))).toBeNull();
    expect(releaseFromPayload(release({ prerelease: true }))).toBeNull();
    expect(releaseFromPayload(release({ tag_name: 'latest' }))).toBeNull();
    expect(releaseFromPayload({ message: 'API rate limit exceeded' })).toBeNull();
    expect(releaseFromPayload(null)).toBeNull();
  });

  test('the link can only be this repository\'s own release', () => {
    // The link is opened as it arrives, so a look-alike host must not pass.
    for (const url of [
      'https://evil.example/transmilenio-explorer-v1.26.3.apk',
      'https://github.com/someone-else/transmilenio/releases/download/v1.26.3/app.apk',
      'https://github.com.evil.example/estebantorrg/transmilenio/releases/download/v1.26.3/app.apk',
      'http://github.com/estebantorrg/transmilenio/releases/download/v1.26.3/app.apk',
    ]) {
      expect(releaseFromPayload(release({ assets: [{ browser_download_url: url }] })), url).toBeNull();
    }
  });
});
