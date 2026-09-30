const REPOSITORY = 'viralcloner/ViralCloner';
const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;
const RELEASES_URL = `${REPOSITORY_URL}/releases`;
const API_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value || ''));
  return match ? match.slice(1).map(Number) : null;
}
function isNewerVersion(latest, current) {
  const a = parseVersion(latest), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}
function isReleaseAssetUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' &&
      !url.username && !url.password && !url.port &&
      url.pathname.startsWith(`/${REPOSITORY}/releases/download/`) &&
      /\.exe$/i.test(url.pathname);
  } catch (_) { return false; }
}
function releaseInfo(release, currentVersion, arch = process.arch) {
  if (!release || release.draft || release.prerelease || !parseVersion(release.tag_name)) {
    throw new Error('GitHub did not return a stable release with a vMAJOR.MINOR.PATCH tag.');
  }
  const assets = (release.assets || []).filter(asset =>
    /setup.*\.exe$/i.test(asset.name || '') && isReleaseAssetUrl(asset.browser_download_url));
  const asset = assets.find(item => new RegExp(`-${arch}\\.exe$`, 'i').test(item.name)) ||
    (arch === 'x64' ? assets.find(item => !/-(arm64|ia32)\.exe$/i.test(item.name)) : null);
  const newer = isNewerVersion(release.tag_name, currentVersion);
  return {
    success: true, currentVersion, latestVersion: release.tag_name.replace(/^v/, ''),
    updateAvailable: newer && Boolean(asset), isMandatory: false,
    downloadUrl: asset?.browser_download_url || null,
    releaseNotes: String(release.body || ''), releasesUrl: RELEASES_URL,
    assetSize: asset?.size || 0, digest: asset?.digest || null,
    message: newer && !asset ? 'No compatible Windows installer is attached to the latest release.' : undefined,
  };
}
async function checkForUpdates(currentVersion, client = require('axios')) {
  try {
    const response = await client.get(API_URL, {
      timeout: 15000,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ViralCloner-OpenSource' },
    });
    return releaseInfo(response.data, currentVersion);
  } catch (error) {
    if (error.response?.status === 404) {
      return { success: true, updateAvailable: false, currentVersion, latestVersion: currentVersion,
        releasesUrl: RELEASES_URL, message: 'No public release is available yet.' };
    }
    return { success: false, updateAvailable: false, error: error.message, releasesUrl: RELEASES_URL };
  }
}
let installing = false;
async function downloadAndInstall(event, requestedUrl) {
  if (installing) return { success: false, error: 'An update is already downloading.' };
  installing = true;
  const { app } = require('electron');
  const fs = require('fs');
  const path = require('path');
  const { Transform } = require('stream');
  const { pipeline } = require('stream/promises');
  const { createHash } = require('crypto');
  const setupPath = path.join(app.getPath('userData'), 'updates', 'ViralCloner-Setup.exe');
  const partialPath = setupPath + '.partial';
  const progress = data => { if (!event.sender.isDestroyed()) event.sender.send('update-download-progress', data); };
  try {
    if (!isReleaseAssetUrl(requestedUrl)) throw new Error('Only this project’s GitHub release installers are allowed.');
    // Re-fetch metadata: never execute an arbitrary URL supplied by a renderer.
    const release = await checkForUpdates(app.getVersion());
    if (!release.success || !release.updateAvailable || release.downloadUrl !== requestedUrl) {
      throw new Error(release.error || 'The requested installer is not the latest compatible release.');
    }
    if (!/^sha256:[a-f0-9]{64}$/i.test(release.digest || '')) {
      throw new Error('GitHub has no SHA-256 digest for this asset. Re-upload the installer before updating.');
    }
    await fs.promises.mkdir(path.dirname(setupPath), { recursive: true });
    const response = await require('axios').get(requestedUrl, {
      responseType: 'stream', timeout: 120000, maxRedirects: 5,
      beforeRedirect(options) {
        const hostname = String(options.hostname || '').toLowerCase();
        if (options.protocol !== 'https:' ||
          !(hostname === 'github.com' || hostname.endsWith('.githubusercontent.com'))) {
          throw new Error('Unexpected installer redirect');
        }
      },
    });
    let size = 0;
    const hash = createHash('sha256');
    const inspect = new Transform({ transform(chunk, encoding, callback) {
      size += chunk.length;
      hash.update(chunk);
      progress({ progress: Math.min(90, Math.round(size / release.assetSize * 90)), status: 'Downloading...' });
      callback(null, chunk);
    } });
    await pipeline(response.data, inspect, fs.createWriteStream(partialPath));
    if (size !== release.assetSize || hash.digest('hex') !== release.digest.slice(7).toLowerCase()) {
      throw new Error('Installer checksum or size does not match GitHub.');
    }
    await fs.promises.rename(partialPath, setupPath);
    const installer = require('child_process').spawn(setupPath, ['/S'], {
      detached: true, stdio: 'ignore', windowsHide: true, shell: false,
    });
    await new Promise((resolve, reject) => { installer.once('spawn', resolve); installer.once('error', reject); });
    installer.unref();
    progress({ progress: 100, status: 'Installing...' });
    setTimeout(() => app.exit(0), 1000);
    return { success: true };
  } catch (error) {
    await fs.promises.unlink(partialPath).catch(() => {});
    return { success: false, error: error.message };
  } finally { installing = false; }
}
module.exports = { REPOSITORY_URL, RELEASES_URL, API_URL, parseVersion, isNewerVersion, isReleaseAssetUrl, releaseInfo, checkForUpdates, downloadAndInstall };
