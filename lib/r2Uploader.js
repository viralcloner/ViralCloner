const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Minimal extension -> MIME map for the media types this app uploads.
const EXT_MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".m4v": "video/x-m4v",
};

function guessContentType(filePath) {
  const ext = path.extname(filePath || "").toLowerCase();
  return EXT_MIME[ext] || "application/octet-stream";
}

/**
 * Parse the pipe-delimited Cloudflare R2 credential string.
 * Expected format: accountId|accessKeyId|secretAccessKey|bucket|publicBaseUrl
 */
function parseR2Credentials(api) {
  const parts = String(api || "").split("|").map((s) => (s || "").trim());
  const [accountId, accessKeyId, secretAccessKey, bucket, publicBaseUrl] = parts;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket || !publicBaseUrl) {
    return {
      error:
        "Missing Cloudflare R2 credentials. Required: Account ID, Access key ID, Secret access key, Bucket name, Public base URL.",
    };
  }
  if (publicBaseUrl.includes(".r2.cloudflarestorage.com")) {
    return {
      error:
        "The Public base URL must be your bucket\u2019s public r2.dev URL (e.g. https://pub-xxxx.r2.dev) or a custom domain \u2014 not the storage endpoint (*.r2.cloudflarestorage.com). Enable \u2018Allow Public Access\u2019 on your R2 bucket in the Cloudflare dashboard to get a pub-xxxx.r2.dev URL.",
    };
  }
  return { accountId, accessKeyId, secretAccessKey, bucket, publicBaseUrl };
}

/**
 * Upload a local file to a Cloudflare R2 bucket using the S3-compatible API.
 * Streams the file (multipart when large) so big videos don't load fully into memory.
 *
 * @param {string} api  Pipe-delimited credential string (see parseR2Credentials).
 * @param {string} filePath  Absolute path to the local file to upload.
 * @param {object} [options]
 * @param {number} [options.timeoutMs]  Per-request socket timeout in milliseconds.
 * @returns {Promise<{success:boolean, url?:string, error?:string}>}
 */
async function uploadToR2(api, filePath, options = {}) {
  const creds = parseR2Credentials(api);
  if (creds.error) return { success: false, error: creds.error };

  if (!filePath || !fs.existsSync(filePath)) {
    return { success: false, error: `File not found at path: ${filePath}` };
  }

  let S3Client;
  let Upload;
  try {
    ({ S3Client } = require("@aws-sdk/client-s3"));
    ({ Upload } = require("@aws-sdk/lib-storage"));
  } catch (loadError) {
    return { success: false, error: `Cloudflare R2 SDK unavailable: ${loadError.message}` };
  }

  const clientConfig = {
    region: "auto",
    endpoint: `https://${creds.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    },
  };

  if (options.timeoutMs) {
    clientConfig.requestHandler = {
      requestTimeout: options.timeoutMs,
      connectionTimeout: Math.min(options.timeoutMs, 30000),
    };
  }

  const client = new S3Client(clientConfig);

  const ext = path.extname(filePath) || "";
  const key = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext.toLowerCase()}`;

  try {
    const upload = new Upload({
      client,
      params: {
        Bucket: creds.bucket,
        Key: key,
        Body: fs.createReadStream(filePath),
        ContentType: guessContentType(filePath),
      },
    });
    await upload.done();

    const base = creds.publicBaseUrl.replace(/\/+$/, "");
    return { success: true, url: `${base}/${key}` };
  } catch (error) {
    const remote =
      error?.message || error?.Code || error?.name || "Unknown Cloudflare R2 error";
    return { success: false, error: `Cloudflare R2 upload failed: ${remote}` };
  } finally {
    if (typeof client.destroy === "function") {
      try {
        client.destroy();
      } catch (_) {
        /* ignore */
      }
    }
  }
}

module.exports = { uploadToR2, parseR2Credentials, guessContentType };
