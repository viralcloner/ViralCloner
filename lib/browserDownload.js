const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { getVCBrowserDirectory, getVCBrowserPath } = require('./browserPaths');
const REPOSITORY = 'viralcloner/VCBrowser';
const RELEASES_URL = `https://github.com/${REPOSITORY}/releases`;
let downloading = false;

function selectAsset(release, arch = process.arch) {
  if (!release || release.draft || release.prerelease) throw new Error('No stable VCBrowser release is available.');
  const assets = (release.assets || []).filter(asset => {
    try {
      const url = new URL(asset.browser_download_url);
      return /\.zip$/i.test(asset.name) && url.protocol === 'https:' && url.hostname === 'github.com' &&
        !url.username && !url.password && !url.port &&
        url.pathname.startsWith(`/${REPOSITORY}/releases/download/`) &&
        !/(linux|macos|darwin)/i.test(asset.name);
    } catch (_) { return false; }
  });
  const asset = assets.find(a => new RegExp(`(?:^|[-_])${arch}(?:[-_.]|$)`, 'i').test(a.name)) ||
    (arch === 'x64' ? assets.find(a => !/(arm64|ia32|x86)/i.test(a.name)) : null);
  if (!asset) throw new Error('Attach a Windows VCBrowser ZIP archive to the latest GitHub release.');
  return asset;
}
function status() {
  let version = null;
  try { version = fs.readFileSync(path.join(getVCBrowserDirectory(), 'version.txt'), 'utf8').trim(); } catch (_) {}
  return { installed: fs.existsSync(getVCBrowserPath()), path: getVCBrowserPath(), installedVersion: version,
    requiredVersion: null, needsUpdate: false, releasesUrl: RELEASES_URL };
}
function findBrowserRoot(directory, depth = 0) {
  if (fs.existsSync(path.join(directory, 'VCBrowser.exe'))) return directory;
  if (depth >= 3) return null;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const found = findBrowserRoot(path.join(directory, entry.name), depth + 1);
      if (found) return found;
    }
  }
  return null;
}
async function download(event) {
  if (downloading) return { success: false, error: 'VCBrowser is already downloading.' };
  // Preserve installed browsers and their active sessions. App releases do not
  // force browser updates; the download action only installs a missing browser.
  if (status().installed) return { success: true, ...status() };
  downloading = true;
  const target = getVCBrowserDirectory();
  let staging;
  const progress = data => { if (!event.sender.isDestroyed()) event.sender.send('vcbrowser-download-progress', data); };
  try {
    const axios = require('axios');
    const response = await axios.get(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
      timeout: 15000, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ViralCloner-OpenSource' },
    });
    const asset = selectAsset(response.data);
    if (!/^sha256:[a-f0-9]{64}$/i.test(asset.digest || '')) throw new Error('GitHub has no SHA-256 digest for the VCBrowser ZIP. Re-upload the asset.');
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    staging = await fs.promises.mkdtemp(path.join(path.dirname(target), '.vcbrowser-install-'));
    const zip = path.join(staging, 'browser.zip');
    const archive = await axios.get(asset.browser_download_url, {
      responseType: 'stream', timeout: 120000, maxRedirects: 5,
      beforeRedirect(options) {
        if (options.protocol !== 'https:' || !(options.hostname === 'github.com' || options.hostname?.endsWith('.githubusercontent.com'))) {
          throw new Error('Unexpected VCBrowser download redirect');
        }
      },
    });
    let size = 0;
    const hash = createHash('sha256');
    await pipeline(archive.data, new Transform({ transform(chunk, encoding, callback) {
      size += chunk.length;
      hash.update(chunk);
      progress({ progress: Math.min(90, Math.round(size / asset.size * 90)), status: 'Downloading VCBrowser...' });
      callback(null, chunk);
    } }), fs.createWriteStream(zip));
    if (size !== asset.size || hash.digest('hex') !== asset.digest.slice(7).toLowerCase()) throw new Error('VCBrowser checksum or size does not match GitHub.');
    progress({ progress: 92, status: 'Extracting VCBrowser...' });
    const extracted = path.join(staging, 'extracted');
    await require('extract-zip')(zip, { dir: extracted, onEntry(entry) {
      // Browser releases must contain regular files/directories, never links.
      if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new Error('Browser archive contains a symbolic link.');
    } });
    const root = findBrowserRoot(extracted);
    if (!root) throw new Error('The archive does not contain VCBrowser.exe.');
    await fs.promises.writeFile(path.join(root, 'release.json'), JSON.stringify({ tag: response.data.tag_name, digest: asset.digest }));
    if (!fs.existsSync(path.join(root, 'version.txt'))) {
      await fs.promises.writeFile(path.join(root, 'version.txt'), String(response.data.tag_name || '').replace(/^v/, ''));
    }
    // Retain any incomplete previous installation so no existing data is lost.
    const previous = target + '.previous-' + Date.now();
    const existed = fs.existsSync(target);
    if (existed) await fs.promises.rename(target, previous);
    try { await fs.promises.rename(root, target); }
    catch (error) { if (existed) await fs.promises.rename(previous, target); throw error; }
    progress({ progress: 100, status: 'VCBrowser is ready' });
    return { success: true, ...status() };
  } catch (error) {
    return { success: false, error: error.response?.status === 404 ? 'No public VCBrowser release is available yet.' : error.message };
  } finally {
    if (staging) await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
    downloading = false;
  }
}
module.exports = { selectAsset, findBrowserRoot, status, download, RELEASES_URL };
