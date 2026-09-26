// inpaintOnce.js
// One function to upload -> process mask -> download result.
const { default: axios } = require("axios");
const fs = require("fs/promises");
const fss = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");

const BASE = "https://theinpaint.com";

function guessMime(p) {
    const ext = path.extname(p).toLowerCase();
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
    if (ext === ".png") return "image/png";
    if (ext === ".webp") return "image/webp";
    if (ext === ".bmp") return "image/bmp";
    if (ext === ".gif") return "image/gif";
    return "application/octet-stream";
}
function cookiesToHeader(setCookie) {
    if (!setCookie) return "";
    if (typeof setCookie === "string") return setCookie;
    return setCookie.map(c => String(c).split(";")[0]).join("; ");
}

async function inpaintOnce({ imagePath, maskPath, outPath }) {
    console.log(`[INPAINT-API] Starting inpaint process...`);
    console.log(`[INPAINT-API] Image: ${imagePath}`);
    console.log(`[INPAINT-API] Mask: ${maskPath}`);
    console.log(`[INPAINT-API] Output: ${outPath}`);

    const httpsAgent = new https.Agent({ keepAlive: true });
    const httpAgent = new http.Agent({ keepAlive: true });

    // ---- 1) Upload image (multipart/form-data) ----
    const fileName = path.basename(imagePath);
    const mime = guessMime(imagePath);
    const fileBuf = await fs.readFile(imagePath);

    console.log(`[INPAINT-API] Image file size: ${fileBuf.length} bytes, MIME: ${mime}`);

    const boundary = "----ElectronFormBoundary" + crypto.randomBytes(12).toString("hex");
    const CRLF = "\r\n";
    const head =
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="image"; filename="${fileName}"${CRLF}` +
        `Content-Type: ${mime}${CRLF}${CRLF}`;
    const tail = `${CRLF}--${boundary}--${CRLF}`;
    const body = Buffer.concat([Buffer.from(head), fileBuf, Buffer.from(tail)]);

    console.log(`[INPAINT-API] Uploading image to ${BASE}/upload...`);
    const uploadRes = await axios.post(`${BASE}/upload`, body, {
        headers: {
            "Accept": "application/json",
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "X-Requested-With": "XMLHttpRequest",
            "Origin": BASE,
            "Referer": `${BASE}/upload`,
            "User-Agent": "Mozilla/5.0",
            "Cache-Control": "no-cache",
        },
        maxBodyLength: Infinity,
        withCredentials: true,
        httpsAgent, httpAgent,
    });

    // e.g. { id, secret, date, fileName }
    const up = uploadRes.data;
    const setCookie = uploadRes.headers["set-cookie"] || [];
    const cookieHeader = cookiesToHeader(setCookie);

    console.log(`[INPAINT-API] Upload response:`, up);
    console.log(`[INPAINT-API] Upload status: ${uploadRes.status}`);

    if (!up?.id || !up?.secret) {
        throw new Error(`Unexpected upload response: ${JSON.stringify(up)}`);
    }

    // ---- 2) Send mask (application/x-www-form-urlencoded) ----
    const maskBuf = await fs.readFile(maskPath);
    const maskDataUrl = `data:image/png;base64,${maskBuf.toString("base64")}`;
    const processUrl = `${BASE}/editor/${up.id}/${up.secret}/process`;

    console.log(`[INPAINT-API] Mask file size: ${maskBuf.length} bytes`);
    console.log(`[INPAINT-API] Sending mask to: ${processUrl}`);

    const procRes = await axios.post(processUrl, `mask=${encodeURIComponent(maskDataUrl)}`, {
        headers: {
            "Accept": "*/*",
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": BASE,
            "Referer": `${BASE}/editor/${up.id}/${up.secret}/`,
            "User-Agent": "Mozilla/5.0",
            ...(cookieHeader ? { "Cookie": cookieHeader } : {}),
        },
        maxBodyLength: Infinity,
        httpsAgent, httpAgent,
    });

    // Example: {"x":300,"y":633,"width":150,"height":51}
    const rect = procRes.data;
    console.log(`[INPAINT-API] Process response:`, rect);
    console.log(`[INPAINT-API] Process status: ${procRes.status}`);

    // ---- 3) Download the edited image and save ----
    const ts = Date.now(); // cache-buster
    const imageUrl = `${BASE}/editor/${up.id}/${up.secret}/image?${ts}`;

    console.log(`[INPAINT-API] Downloading result from: ${imageUrl}`);

    const imgRes = await axios.get(imageUrl, {
        responseType: "arraybuffer",
        headers: {
            "Accept": "image/*",
            "Referer": `${BASE}/editor/${up.id}/${up.secret}/`,
            "User-Agent": "Mozilla/5.0",
            ...(cookieHeader ? { "Cookie": cookieHeader } : {}),
        },
        httpsAgent, httpAgent,
    });

    console.log(`[INPAINT-API] Download status: ${imgRes.status}`);
    console.log(`[INPAINT-API] Downloaded image size: ${imgRes.data.byteLength} bytes`);

    // Ensure output directory exists
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, imgRes.data);

    console.log(`[INPAINT-API] Result saved to: ${outPath}`);
    console.log(`[INPAINT-API] Inpainting process completed successfully`);

    return {
        upload: up,             // { id, secret, date, fileName }
        processRect: rect,      // { x, y, width, height }
        imageUrl,               // where it was fetched from
        savedTo: outPath,       // local path saved
        cookies: setCookie,     // raw Set-Cookie array (if you want to persist)
    };
}

module.exports = { inpaintOnce };
