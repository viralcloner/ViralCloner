const crypto = require("crypto");
const path = require("path");
const fs = require("fs/promises");
const fss = require("fs");
const axios = require("axios");
const { app, net } = require("electron");

const MODULE = "[FbGroupsImageStore]";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_KEYS = ["coverImage", "profilePicture"];

function isRemoteUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function isUsableLocalPath(value) {
  return typeof value === "string" &&
    value.length > 0 &&
    !isRemoteUrl(value) &&
    !value.startsWith("data:") &&
    fss.existsSync(value);
}

function entityFolderName(entityId) {
  return crypto.createHash("sha256").update(String(entityId)).digest("hex").slice(0, 32);
}

function extensionFromContentType(contentType) {
  const type = String(contentType || "").split(";")[0].trim().toLowerCase();
  const extensions = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/avif": ".avif",
    "image/bmp": ".bmp",
  };
  return extensions[type] || ".jpg";
}

class FacebookGroupsImageStore {
  constructor() {
    this.basePath = path.join(app.getPath("userData"), "FacebookGroupsMedia");
  }

  _entityPath(entityType, entityId) {
    const collection = entityType === "group" ? "groups" : "profiles";
    return path.join(this.basePath, collection, entityFolderName(entityId));
  }

  async _fetchImage(url, { logFailures = true } = {}) {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36",
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    };

    // Electron's network stack uses the app's DNS-over-HTTPS configuration,
    // which is important on networks that block fbcdn.net in system DNS.
    if (net && typeof net.fetch === "function") {
      try {
        const response = await net.fetch(url, {
          headers,
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const declaredLength = Number(response.headers.get("content-length")) || 0;
        if (declaredLength > MAX_IMAGE_BYTES) {
          throw new Error(`Image is too large: ${declaredLength} bytes`);
        }
        return {
          buffer: Buffer.from(await response.arrayBuffer()),
          contentType: response.headers.get("content-type"),
        };
      } catch (error) {
        if (logFailures) {
          console.warn(`${MODULE} Electron download failed, using fallback: ${error.message}`);
        }
      }
    }

    const response = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 30000,
      maxContentLength: MAX_IMAGE_BYTES,
      maxBodyLength: MAX_IMAGE_BYTES,
      headers,
    });
    return {
      buffer: Buffer.from(response.data),
      contentType: response.headers && response.headers["content-type"],
    };
  }

  async _downloadImage(url, entityType, entityId, imageKey, options = {}) {
    const normalizedUrl = String(url).replace(/&amp;/g, "&");
    const { buffer, contentType } = await this._fetchImage(normalizedUrl, options);
    if (contentType && !String(contentType).toLowerCase().startsWith("image/")) {
      throw new Error(`Unexpected content type: ${contentType}`);
    }

    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) {
      throw new Error(`Invalid image size: ${buffer.length} bytes`);
    }

    const entityPath = this._entityPath(entityType, entityId);
    await fs.mkdir(entityPath, { recursive: true });

    const filePrefix = imageKey === "coverImage" ? "cover" : "profile";
    const extension = extensionFromContentType(contentType);
    const targetPath = path.join(entityPath, `${filePrefix}${extension}`);
    const tempPath = path.join(
      entityPath,
      `${filePrefix}-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.tmp`,
    );

    await fs.writeFile(tempPath, buffer);
    try {
      await fs.copyFile(tempPath, targetPath);
    } finally {
      await fs.rm(tempPath, { force: true });
    }

    // This directory is intentionally outside automatic-cleaner roots. Only the
    // related account/group deletion removes it.
    const entries = await fs.readdir(entityPath);
    await Promise.all(entries
      .filter((name) => name.startsWith(`${filePrefix}.`) && name !== path.basename(targetPath))
      .map((name) => fs.rm(path.join(entityPath, name), { force: true })));

    return targetPath;
  }

  async _localizeInfo(entityType, entityId, info, existingInfo = null, options = {}) {
    const localized = { ...(info || {}) };
    const existing = existingInfo || {};

    for (const imageKey of IMAGE_KEYS) {
      const source = localized[imageKey];
      const previous = existing[imageKey];

      if (isUsableLocalPath(source)) continue;

      if (isRemoteUrl(source)) {
        try {
          localized[imageKey] = await this._downloadImage(
            source,
            entityType,
            entityId,
            imageKey,
            options,
          );
          continue;
        } catch (error) {
          if (options.logFailures !== false) {
            console.warn(`${MODULE} Could not save ${entityType} ${imageKey}: ${error.message}`);
          }
        }
      }

      // A temporary download or scan failure must not replace a durable copy.
      if (isUsableLocalPath(previous) || isRemoteUrl(previous)) {
        localized[imageKey] = previous;
      }
    }

    return localized;
  }

  localizeGroupInfo(groupId, info, existingInfo = null, options = {}) {
    return this._localizeInfo("group", groupId, info, existingInfo, options);
  }

  localizeProfileInfo(profileId, info, existingInfo = null, options = {}) {
    return this._localizeInfo("profile", profileId, info, existingInfo, options);
  }

  async removeGroupImages(groupId) {
    await fs.rm(this._entityPath("group", groupId), { recursive: true, force: true });
  }

  async removeProfileImages(profileId) {
    await fs.rm(this._entityPath("profile", profileId), { recursive: true, force: true });
  }
}

module.exports = new FacebookGroupsImageStore();
