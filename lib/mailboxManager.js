const { app, safeStorage } = require("electron");
const Database = require("better-sqlite3");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const crypto = require("crypto");
const net = require("net");
const tls = require("tls");
const fs = require("fs/promises");
const path = require("path");
const axios = require("axios");
const { decryptWithMigration } = require("./utils");

const CONNECTION_TIMEOUT_MS = 20_000;
const SYNC_BATCH_SIZE = 100;
const MAX_CACHED_MESSAGES = 1_000;
const MAX_BATCH_CONCURRENCY = 12;
const IMAP_CONNECT_ATTEMPTS = 3;
const IMAP_RETRY_BASE_DELAY_MS = 1_200;

function now() {
  return new Date().toISOString();
}

function id() {
  return crypto.randomUUID();
}

const PINTEREST_SUSPENSION_SUBJECT = "your pinterest account has been suspended";

function normalizeSubject(subject) {
  return String(subject || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function detectSuspensionAlert(payload) {
  if (!payload) return null;
  if (normalizeSubject(payload.subject) !== PINTEREST_SUSPENSION_SUBJECT) return null;
  return { platform: "Pinterest" };
}

// Microsoft's IMAP XOAUTH2 failure returns a base64 SASL continuation holding
// JSON like {"status":"401","schemes":"Bearer","scope":"..."}. The status code
// is the real diagnostic and contains NO token material. This extracts only the
// numeric status from whatever ImapFlow surfaced, without logging the token.
function imapOAuthStatus(error) {
  const fields = [error?.response, error?.responseText, error?.authenticationFailedMessage]
    .filter((value) => typeof value === "string");
  for (const field of fields) {
    // The blob may already be decoded JSON, or still base64-encoded.
    const candidates = [field];
    const base64 = field.match(/[A-Za-z0-9+/=]{16,}/);
    if (base64) {
      try { candidates.push(Buffer.from(base64[0], "base64").toString("utf8")); } catch (_) { /* not base64 */ }
    }
    for (const candidate of candidates) {
      const match = candidate.match(/"status"\s*:\s*"?(\d{3})"?/);
      if (match) return Number(match[1]);
    }
  }
  return null;
}

function userError(error) {
  // ImapFlow deliberately keeps the public Error message generic (usually
  // "Command failed") but marks authentication failures and attaches the
  // server response separately. Only use that metadata to classify the
  // problem; do not return or log the server response because it can contain
  // account-specific information.
  const message = [error?.message, error?.response, error?.responseText, error?.serverResponseCode, error?.code]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (message.includes("outlook authorization")) {
    return "Outlook authorization expired. Reconnect the mailbox to continue.";
  }
  // Classify Outlook/IMAP OAuth rejections by the SASL status when available so
  // the cause is actionable. 401 = the token's audience or identity does not
  // match the mailbox; 403/insufficient_scope = the IMAP scope was not granted.
  const oauthStatus = imapOAuthStatus(error);
  if (oauthStatus === 403 || message.includes("insufficient_scope")) {
    return "Outlook did not grant mailbox (IMAP) access. Reconnect and approve the IMAP permission.";
  }
  if (oauthStatus === 401 || message.includes("invalid_token")) {
    return "Outlook rejected the access token for this mailbox. Reconnect to issue a fresh token.";
  }
  if (oauthStatus === 400) {
    return "The Outlook sign-in could not be completed. Reconnect the mailbox to try again.";
  }
  // The token was accepted but the consumer mailbox would not attach the IMAP
  // session even after retries. This is a mailbox-side state, not a credential
  // problem - usually IMAP is turned off in the account's own Outlook.com sync
  // settings, or the mailbox is temporarily unavailable.
  if (message.includes("not connected")) {
    return "Outlook accepted the sign-in but would not open the mailbox over IMAP. Turn on IMAP in the Outlook.com mail sync settings, then reconnect. If it was just enabled, wait a few minutes and retry.";
  }
  if (error?.authenticationFailed || message.includes("authenticate")) {
    return "Mailbox authentication was rejected. Reconnect the mailbox to continue.";
  }
  if (message.includes("authentication") || message.includes("auth") || message.includes("login")) {
    return "The mailbox rejected the username or password.";
  }
  if (message.includes("certificate") || message.includes("tls") || message.includes("ssl")) {
    return "The secure connection could not be verified. Check the host, port, and TLS setting.";
  }
  if (message.includes("timeout") || message.includes("timed out")) {
    return "The mailbox did not respond in time. Check the server details and network connection.";
  }
  if (message.includes("encryption") || message.includes("secure storage")) {
    return "Operating-system encryption is unavailable, so mailbox data cannot be stored securely.";
  }
  return "The mailbox operation could not be completed. Check the server details and try again.";
}

// Machine-readable classification so the UI can react (e.g. show IMAP-enable
// steps) instead of only printing a generic message.
function errorReason(error) {
  const message = [error?.message, error?.response, error?.responseText, error?.serverResponseCode, error?.code]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (message.includes("not connected")) return "imap_not_connected";
  if (message.includes("insufficient_scope")) return "imap_scope_missing";
  if (message.includes("invalid_token") || message.includes("authenticate") || error?.authenticationFailed) return "auth_rejected";
  return "generic";
}

// Detect a transient consumer-Exchange backend refusal where the OAuth token was
// accepted but the mailbox session was not attached. These resolve on retry and
// are unrelated to the token, scope, or any IMAP enablement setting.
function isTransientBackendError(error, serverLines) {
  const haystack = [error?.response, error?.responseText, ...(Array.isArray(serverLines) ? serverLines : [])]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return /authenticated but not connected|user is not connected|server unavailable|try again|temporarily|backend busy|imap4 service is unavailable/.test(haystack);
}

// Classify an access token by SHAPE only (never its contents): AAD work/school
// tokens are 3-part JWTs we can inspect; personal Outlook tokens are opaque.
function tokenShape(accessToken) {
  if (typeof accessToken !== "string" || !accessToken) return "none";
  return accessToken.split(".").length === 3 ? "jwt" : "opaque";
}

// Remove any token material from a string before it is written to disk. Redacts
// the live access token, XOAUTH2/SASL AUTHENTICATE arguments, and Bearer values.
function scrubTokens(value, accessToken) {
  let text = String(value);
  if (typeof accessToken === "string" && accessToken.length > 8) {
    text = text.split(accessToken).join("[redacted-token]");
  }
  return text
    .replace(/(AUTHENTICATE\s+XOAUTH2\s+)\S+/gi, "$1[redacted]")
    .replace(/(auth=Bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/gi, "$1[redacted]");
}

// Build an ImapFlow logger that records ONLY server-sent protocol lines into a
// bounded buffer. Client lines (which carry the XOAUTH2 token) are never read,
// so the access token is never even observed by the logger.
function makeServerLineLogger(buffer) {
  const capture = (entry) => {
    if (!entry || entry.src !== "s" || typeof entry.msg !== "string") return;
    buffer.push(entry.msg.slice(0, 300));
    if (buffer.length > 40) buffer.shift();
  };
  const noop = () => {};
  return { debug: capture, info: capture, warn: noop, error: noop };
}

// Append token-safe diagnostics for an IMAP/OAuth failure so the actual cause is
// recoverable from userData/Logs/mailbox-auth.log without ever storing a token.
async function logImapAuthDiagnostics(error, context) {
  try {
    const token = context?.accessToken;
    const sasl = imapOAuthStatus(error) ?? imapOAuthStatus({ response: (context?.serverLines || []).join("\n") });
    const record = {
      at: now(),
      stage: context?.stage || "connect",
      host: context?.host,
      port: context?.port,
      authType: context?.authType,
      // Mailbox address is not a secret; the token is. Log shape/length only.
      username: context?.username,
      tokenShape: tokenShape(token),
      tokenLength: typeof token === "string" ? token.length : 0,
      saslStatus: sasl,
      attempts: context?.attempts,
      transient: context?.transient === true,
      serverLines: Array.isArray(context?.serverLines)
        ? context.serverLines.map((line) => scrubTokens(line, token))
        : [],
      error: {
        name: scrubTokens(error?.name || "", token),
        message: scrubTokens(error?.message || "", token),
        code: scrubTokens(error?.code || "", token),
        serverResponseCode: scrubTokens(error?.serverResponseCode || "", token),
        responseStatus: scrubTokens(error?.responseStatus || "", token),
        authenticationFailed: error?.authenticationFailed === true,
        command: scrubTokens(error?.command || "", token),
        response: scrubTokens(error?.response || "", token).slice(0, 600),
        responseText: scrubTokens(error?.responseText || "", token).slice(0, 600),
        stack: scrubTokens(error?.stack || "", token).slice(0, 1200),
      },
    };
    const dir = path.join(app.getPath("userData"), "Logs");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "mailbox-auth.log");
    // Keep the log bounded so it never grows without limit.
    try {
      const stat = await fs.stat(file);
      if (stat.size > 512 * 1024) await fs.rm(file, { force: true });
    } catch (_) { /* file does not exist yet */ }
    await fs.appendFile(file, JSON.stringify(record) + "\n", "utf8");
  } catch (_) {
    // Diagnostics must never break the connection flow.
  }
}

function asString(value, max = 500) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function safeFileName(value) {
  const cleaned = asString(value, 180).replace(/[\\/:*?"<>|]/g, "_");
  return cleaned || "attachment";
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Email HTML is rendered in a sandboxed iframe as a second boundary. This sanitizer
// removes executable and remote-content vectors before it ever reaches the renderer.
function sanitizeEmailHtml(html) {
  return String(html || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|iframe|object|embed|form|base|meta|link)[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|iframe|object|embed|form|base|meta|link)\b[^>]*\/?\s*>/gi, "")
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(href|src|action)\s*=\s*(?:"\s*(?:javascript|data):[^"]*"|'\s*(?:javascript|data):[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(src|background)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

class Pop3Client {
  constructor(config) {
    this.config = config;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.waiter = null;
  }

  _attach(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    socket.setTimeout(CONNECTION_TIMEOUT_MS);
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.waiter) this.waiter();
    });
    socket.on("error", (error) => {
      if (this.waiter) this.waiter(error);
    });
    socket.on("timeout", () => {
      if (this.waiter) this.waiter(new Error("Connection timed out"));
    });
  }

  _waitForResponse(multiline = false) {
    const marker = Buffer.from(multiline ? "\r\n.\r\n" : "\r\n");
    return new Promise((resolve, reject) => {
      const check = (error) => {
        if (error) {
          this.waiter = null;
          reject(error);
          return;
        }
        const index = this.buffer.indexOf(marker);
        if (index === -1) return;
        const end = index + marker.length;
        const raw = this.buffer.subarray(0, end);
        this.buffer = this.buffer.subarray(end);
        this.waiter = null;
        const firstLineEnd = raw.indexOf(Buffer.from("\r\n"));
        const status = raw.subarray(0, firstLineEnd === -1 ? raw.length : firstLineEnd).toString("utf8");
        if (!status.startsWith("+OK")) {
          reject(new Error("POP3 server rejected the command"));
          return;
        }
        resolve({ status, raw, body: multiline && firstLineEnd !== -1 ? raw.subarray(firstLineEnd + 2, raw.length - marker.length) : Buffer.alloc(0) });
      };
      this.waiter = check;
      check();
    });
  }

  async _command(command, multiline = false) {
    const response = this._waitForResponse(multiline);
    this.socket.write(`${command}\r\n`, "utf8");
    return response;
  }

  async connect() {
    const { host, port, tlsMode } = this.config;
    const directTls = tlsMode === "tls";
    const socket = directTls
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: true })
      : net.createConnection({ host, port });
    await new Promise((resolve, reject) => {
      const onError = (error) => { socket.removeListener("connect", onConnect); socket.removeListener("secureConnect", onConnect); reject(error); };
      const onConnect = () => { socket.removeListener("error", onError); resolve(); };
      socket.once("error", onError);
      socket.once(directTls ? "secureConnect" : "connect", onConnect);
      socket.setTimeout(CONNECTION_TIMEOUT_MS, () => reject(new Error("Connection timed out")));
    });
    this._attach(socket);
    await this._waitForResponse(false);
    if (tlsMode === "starttls") {
      await this._command("STLS");
      const original = this.socket;
      original.removeAllListeners();
      const secureSocket = tls.connect({ socket: original, servername: host, rejectUnauthorized: true });
      await new Promise((resolve, reject) => {
        secureSocket.once("secureConnect", resolve);
        secureSocket.once("error", reject);
        secureSocket.setTimeout(CONNECTION_TIMEOUT_MS, () => reject(new Error("Connection timed out")));
      });
      this._attach(secureSocket);
    }
    await this._command(`USER ${this.config.username}`);
    await this._command(`PASS ${this.config.password}`);
  }

  async list() {
    const list = await this._command("LIST", true);
    const uidl = await this._command("UIDL", true);
    const uidlBySequence = new Map();
    uidl.body.toString("utf8").split(/\r?\n/).forEach((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (match) uidlBySequence.set(Number(match[1]), match[2]);
    });
    return list.body.toString("utf8").split(/\r?\n/).map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)$/);
      return match ? { sequence: Number(match[1]), size: Number(match[2]), uid: uidlBySequence.get(Number(match[1])) || String(match[1]) } : null;
    }).filter(Boolean);
  }

  async retrieve(sequence) {
    const result = await this._command(`RETR ${Number(sequence)}`, true);
    // RFC 1939 dot-stuffs a line beginning with a dot.
    return Buffer.from(result.body.toString("binary").replace(/\r\n\.\./g, "\r\n."), "binary");
  }

  async delete(sequence) {
    await this._command(`DELE ${Number(sequence)}`);
  }

  async close() {
    if (!this.socket) return;
    try { await this._command("QUIT"); } catch (_) { /* connection is already unusable */ }
    this.socket.destroy();
    this.socket = null;
  }
}

class MailboxManager {
  constructor() {
    this.db = new Database(path.join(app.getPath("userData"), "mailboxes.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.testTokens = new Map();
    this.jobs = new Map();
    this._initSchema();
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mailboxes (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        email TEXT NOT NULL,
        protocol TEXT NOT NULL CHECK(protocol IN ('imap', 'pop3')),
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        tls_mode TEXT NOT NULL CHECK(tls_mode IN ('tls', 'starttls')),
        auth_type TEXT NOT NULL DEFAULT 'password' CHECK(auth_type IN ('password', 'oauth2')),
        tags TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '',
        secret_blob TEXT NOT NULL,
        health TEXT NOT NULL DEFAULT 'untested',
        health_message TEXT,
        last_tested_at TEXT,
        last_refreshed_at TEXT,
        unread_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mailboxes_updated ON mailboxes(updated_at DESC);
      CREATE TABLE IF NOT EXISTS mailbox_folders (
        mailbox_id TEXT NOT NULL,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        special_use TEXT,
        cached_at TEXT NOT NULL,
        PRIMARY KEY (mailbox_id, path),
        FOREIGN KEY(mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS mailbox_messages (
        id TEXT PRIMARY KEY,
        mailbox_id TEXT NOT NULL,
        folder_path TEXT NOT NULL,
        server_uid TEXT NOT NULL,
        server_sequence INTEGER,
        received_at TEXT,
        unread INTEGER NOT NULL DEFAULT 0,
        flagged INTEGER NOT NULL DEFAULT 0,
        has_attachments INTEGER NOT NULL DEFAULT 0,
        payload_blob TEXT NOT NULL,
        cached_at TEXT NOT NULL,
        UNIQUE(mailbox_id, folder_path, server_uid),
        FOREIGN KEY(mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_mailbox_messages_list ON mailbox_messages(mailbox_id, folder_path, received_at DESC);
    `);
    try { this.db.exec("ALTER TABLE mailboxes ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'password'"); } catch (_) { /* existing database already migrated */ }
  }

  _secureAvailable() {
    return safeStorage.isEncryptionAvailable();
  }

  _encrypt(value) {
    if (!this._secureAvailable()) throw new Error("Secure storage is unavailable");
    return safeStorage.encryptString(JSON.stringify(value)).toString("base64");
  }

  _decrypt(value) {
    if (!this._secureAvailable()) throw new Error("Secure storage is unavailable");
    return JSON.parse(safeStorage.decryptString(Buffer.from(value, "base64")));
  }

  _validateConfig(raw, existingSecret = null) {
    const protocol = raw?.protocol === "pop3" ? "pop3" : raw?.protocol === "imap" ? "imap" : "";
    const host = asString(raw?.host, 253).toLowerCase();
    const port = Number(raw?.port);
    const tlsMode = raw?.tlsMode === "starttls" ? "starttls" : raw?.tlsMode === "tls" ? "tls" : "";
    const email = asString(raw?.email, 254).toLowerCase();
    const username = asString(raw?.username, 320) || existingSecret?.username || email;
    const authType = raw?.authType === "oauth2" || (!raw?.authType && existingSecret?.authType === "oauth2") ? "oauth2" : "password";
    const password = typeof raw?.password === "string" && raw.password.length ? raw.password : existingSecret?.password;
    const accessToken = typeof raw?.accessToken === "string" && raw.accessToken ? raw.accessToken : existingSecret?.accessToken;
    const refreshToken = typeof raw?.refreshToken === "string" && raw.refreshToken ? raw.refreshToken : existingSecret?.refreshToken;
    const expiresAtRaw = Number(raw?.expiresAt || existingSecret?.expiresAt || 0);
    const expiresAt = expiresAtRaw > 0 && expiresAtRaw < 1_000_000_000_000 ? expiresAtRaw * 1000 : expiresAtRaw;
    const label = asString(raw?.label, 120) || email;
    const tags = Array.from(new Set((Array.isArray(raw?.tags) ? raw.tags : String(raw?.tags || "").split(","))
      .map((tag) => asString(tag, 40)).filter(Boolean))).slice(0, 25);
    const notes = asString(raw?.notes, 2000);
    if (!protocol || !host || /\s/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535 || !tlsMode) {
      throw new Error("Invalid mailbox server details");
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !username || (authType === "password" && !password) || (authType === "oauth2" && (!accessToken || !refreshToken || protocol !== "imap"))) {
      throw new Error("Invalid mailbox credentials");
    }
    return { label, email, protocol, host, port, tlsMode, tags, notes, authType, username, password, accessToken, refreshToken, expiresAt };
  }

  _publicMailbox(row) {
    if (!row) return null;
    return {
      id: row.id, label: row.label, email: row.email, protocol: row.protocol, authType: row.auth_type || "password",
      host: row.host, port: row.port, tlsMode: row.tls_mode, tags: JSON.parse(row.tags || "[]"),
      notes: row.notes || "", health: row.health, healthMessage: row.health_message || "",
      lastTestedAt: row.last_tested_at, lastRefreshedAt: row.last_refreshed_at,
      unreadCount: row.unread_count || 0, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  _mailboxSuspensionAlert(mailboxId) {
    const rows = this.db.prepare(`
      SELECT payload_blob
      FROM mailbox_messages
      WHERE mailbox_id = ?
      ORDER BY received_at DESC, cached_at DESC
      LIMIT 100
    `).all(mailboxId);
    for (const row of rows) {
      try {
        const payload = this._decrypt(row.payload_blob);
        const alert = detectSuspensionAlert(payload);
        if (alert) return alert;
      } catch (_) {
        // Ignore corrupted cached rows and keep scanning the recent batch.
      }
    }
    return null;
  }

  _mailboxWithSecret(mailboxId) {
    const row = this.db.prepare("SELECT * FROM mailboxes WHERE id = ?").get(mailboxId);
    if (!row) throw new Error("Mailbox not found");
    const secret = this._decrypt(row.secret_blob);
    return { ...this._publicMailbox(row), ...secret, authType: secret.authType || row.auth_type || "password" };
  }

  listMailboxIds() {
    return this.db.prepare("SELECT id FROM mailboxes ORDER BY label").all().map((row) => row.id);
  }

  getTotalUnreadCount() {
    const rows = this.db.prepare("SELECT unread_count FROM mailboxes").all();
    return rows.reduce((total, row) => total + (row.unread_count || 0), 0);
  }

  listMailboxes(options = {}) {
    const query = asString(options.query, 160).toLowerCase();
    const tag = asString(options.tag, 40);
    const health = ["healthy", "error", "untested"].includes(options.health) ? options.health : "";
    const protocol = ["imap", "pop3"].includes(options.protocol) ? options.protocol : "";
    const sort = ["label", "lastRefreshedAt", "unreadCount", "health"].includes(options.sort) ? options.sort : "label";
    const direction = options.direction === "desc" ? -1 : 1;
    const pageSize = Math.max(1, Math.min(50, Number(options.pageSize) || 50));
    const page = Math.max(1, Number(options.page) || 1);
    let rows = this.db.prepare("SELECT * FROM mailboxes").all().map((row) => ({
      ...this._publicMailbox(row),
      suspensionAlert: this._mailboxSuspensionAlert(row.id),
    }));
    const summary = {
      total: rows.length,
      healthy: rows.filter((mailbox) => mailbox.health === "healthy").length,
      error: rows.filter((mailbox) => mailbox.health === "error").length,
      unread: rows.reduce((totalUnread, mailbox) => totalUnread + (mailbox.unreadCount || 0), 0),
    };
    rows = rows.filter((mailbox) => {
      const matchesQuery = !query || [mailbox.label, mailbox.email, mailbox.host, ...(mailbox.tags || [])]
        .join(" ").toLowerCase().includes(query);
      return matchesQuery && (!tag || mailbox.tags.includes(tag)) && (!health || mailbox.health === health) && (!protocol || mailbox.protocol === protocol);
    });
    const sortKey = { label: "label", lastRefreshedAt: "lastRefreshedAt", unreadCount: "unreadCount", health: "health" }[sort];
    rows.sort((a, b) => String(a[sortKey] || "").localeCompare(String(b[sortKey] || ""), undefined, { numeric: true }) * direction);
    const tags = Array.from(new Set(rows.flatMap((row) => row.tags))).sort();
    const total = rows.length;
    return { items: rows.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize, tags, summary };
  }

  getMailbox(mailboxId) {
    const row = this.db.prepare("SELECT * FROM mailboxes WHERE id = ?").get(mailboxId);
    if (!row) return null;
    return {
      ...this._publicMailbox(row),
      suspensionAlert: this._mailboxSuspensionAlert(row.id),
    };
  }

  async testConfig(raw, mailboxId = null) {
    if (!this._secureAvailable()) throw new Error("Secure storage is unavailable");
    const existing = mailboxId ? this._mailboxWithSecret(mailboxId) : null;
    const config = this._validateConfig(existing ? { ...existing, ...(raw || {}), tags: raw?.tags ?? existing.tags } : raw, existing);
    const client = await this._connect(config);
    try {
      if (config.protocol === "imap") await client.list();
      else await client.list();
    } finally {
      await this._close(client, config.protocol);
    }
    const token = id();
    this.testTokens.set(token, { mailboxId: mailboxId || null, config, expiresAt: Date.now() + 5 * 60_000 });
    if (mailboxId) this._setHealth(mailboxId, "healthy", "", true);
    return { success: true, testToken: token };
  }

  saveMailbox(raw, testToken, mailboxId = null) {
    const verified = this.testTokens.get(testToken);
    if (!verified || verified.expiresAt < Date.now() || verified.mailboxId !== (mailboxId || null)) {
      throw new Error("Mailbox settings must be tested before saving");
    }
    this.testTokens.delete(testToken);
    const config = verified.config;
    const timestamp = now();
    const mailbox = mailboxId || id();
    const existing = mailboxId ? this.db.prepare("SELECT id FROM mailboxes WHERE id = ?").get(mailboxId) : null;
    if (mailboxId && !existing) throw new Error("Mailbox not found");
    const duplicate = this.db.prepare("SELECT id FROM mailboxes WHERE protocol = ? AND host = ? AND email = ? AND id != ?").get(config.protocol, config.host, config.email, mailbox);
    if (duplicate) throw new Error("A mailbox with the same email and server already exists");
    const values = {
      id: mailbox, label: config.label, email: config.email, protocol: config.protocol, host: config.host,
      port: config.port, tlsMode: config.tlsMode, tags: JSON.stringify(config.tags), notes: config.notes,
      authType: config.authType,
      secret: this._encrypt(config.authType === "oauth2"
        ? { authType: "oauth2", username: config.username, accessToken: config.accessToken, refreshToken: config.refreshToken, expiresAt: config.expiresAt }
        : { authType: "password", username: config.username, password: config.password }), timestamp,
    };
    if (existing) {
      this.db.prepare(`UPDATE mailboxes SET label = @label, email = @email, protocol = @protocol, host = @host, port = @port,
        tls_mode = @tlsMode, auth_type = @authType, tags = @tags, notes = @notes, secret_blob = @secret, health = 'healthy', health_message = '',
        last_tested_at = @timestamp, updated_at = @timestamp WHERE id = @id`).run(values);
    } else {
      this.db.prepare(`INSERT INTO mailboxes (id,label,email,protocol,host,port,tls_mode,auth_type,tags,notes,secret_blob,health,last_tested_at,created_at,updated_at)
        VALUES (@id,@label,@email,@protocol,@host,@port,@tlsMode,@authType,@tags,@notes,@secret,'healthy',@timestamp,@timestamp,@timestamp)`).run(values);
    }
    return this.getMailbox(mailbox);
  }

  deleteMailbox(mailboxId) {
    this.db.prepare("DELETE FROM mailboxes WHERE id = ?").run(mailboxId);
  }

  clearCache(mailboxId) {
    this.db.prepare("DELETE FROM mailbox_messages WHERE mailbox_id = ?").run(mailboxId);
    this.db.prepare("DELETE FROM mailbox_folders WHERE mailbox_id = ?").run(mailboxId);
    this.db.prepare("UPDATE mailboxes SET unread_count = 0, updated_at = ? WHERE id = ?").run(now(), mailboxId);
  }

  resetUnreadCount(mailboxId) {
    this.db.prepare("UPDATE mailboxes SET unread_count = 0, updated_at = ? WHERE id = ?").run(now(), mailboxId);
  }

  _setHealth(mailboxId, health, message = "", tested = false) {
    this.db.prepare(`UPDATE mailboxes SET health = ?, health_message = ?, ${tested ? "last_tested_at = ?," : ""} updated_at = ? WHERE id = ?`)
      .run(health, message, ...(tested ? [now()] : []), now(), mailboxId);
  }

  async _connect(config) {
    config = await this._ensureOAuthAccess(config);
    if (config.protocol === "pop3") {
      const client = new Pop3Client(config);
      await client.connect();
      return client;
    }
    // Personal Outlook (consumer Exchange) mailboxes frequently answer a valid
    // OAuth login with "NO User is authenticated but not connected" on the first
    // attempt - the token is accepted but the backend has not attached the IMAP
    // session yet. This is transient, so retry a few times with backoff before
    // surfacing the failure. No mailbox/admin IMAP enablement is involved.
    let lastError;
    for (let attempt = 1; attempt <= IMAP_CONNECT_ATTEMPTS; attempt++) {
      const serverLines = [];
      const client = new ImapFlow({
        host: config.host, port: config.port, secure: config.tlsMode === "tls",
        doSTARTTLS: config.tlsMode === "starttls", auth: config.authType === "oauth2"
          ? { user: config.username, accessToken: config.accessToken }
          : { user: config.username, pass: config.password },
        logger: makeServerLineLogger(serverLines), tls: { servername: config.host, rejectUnauthorized: true },
        connectionTimeout: CONNECTION_TIMEOUT_MS, greetingTimeout: CONNECTION_TIMEOUT_MS, socketTimeout: CONNECTION_TIMEOUT_MS,
      });
      try {
        await client.connect();
        return client;
      } catch (error) {
        lastError = error;
        try { await client.logout(); } catch (_) { /* discard the failed connection */ }
        const transient = isTransientBackendError(error, serverLines);
        if (transient && attempt < IMAP_CONNECT_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, IMAP_RETRY_BASE_DELAY_MS * attempt));
          continue;
        }
        await logImapAuthDiagnostics(error, {
          stage: "connect", host: config.host, port: config.port, authType: config.authType,
          username: config.username, accessToken: config.authType === "oauth2" ? config.accessToken : undefined,
          serverLines, attempts: attempt, transient,
        });
        throw error;
      }
    }
    throw lastError;
  }

  async _ensureOAuthAccess(config) {
    if (config.authType !== 'oauth2') return config;
    throw new Error('Hosted Outlook authorization is unavailable. Configure the mailbox with direct IMAP credentials.');
  }

  async saveOutlookMailbox(tokens) {
    if (!this._secureAvailable()) throw new Error("Secure storage is unavailable");
    const config = this._validateConfig({
      label: tokens?.email, email: tokens?.email, username: tokens?.email, protocol: "imap", host: "outlook.office365.com", port: 993,
      tlsMode: "tls", authType: "oauth2", accessToken: tokens?.accessToken, refreshToken: tokens?.refreshToken, expiresAt: tokens?.expiresAt,
    });
    const duplicate = this.db.prepare("SELECT id FROM mailboxes WHERE protocol = 'imap' AND host = ? AND email = ? LIMIT 1").get(config.host, config.email);
    if (duplicate) throw new Error("This Outlook mailbox is already connected");
    const client = await this._connect(config);
    try { await client.list(); } finally { await this._close(client, "imap"); }
    const timestamp = now();
    const mailboxId = id();
    this.db.prepare(`INSERT INTO mailboxes (id,label,email,protocol,host,port,tls_mode,auth_type,tags,notes,secret_blob,health,last_tested_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'oauth2','[]','',?,'healthy',?,?,?)`).run(
      mailboxId, config.label, config.email, "imap", config.host, 993, "tls",
      this._encrypt({ authType: "oauth2", username: config.username, accessToken: config.accessToken, refreshToken: config.refreshToken, expiresAt: config.expiresAt }), timestamp, timestamp, timestamp,
    );
    return this.getMailbox(mailboxId);
  }

  async _close(client, protocol) {
    try {
      if (protocol === "imap") await client.logout();
      else await client.close();
    } catch (_) { /* connection cleanup must never hide the original result */ }
  }

  async getFolders(mailboxId, refresh = false) {
    const mailbox = this._mailboxWithSecret(mailboxId);
    if (!refresh) {
      const cached = this.db.prepare("SELECT path,name,special_use AS specialUse FROM mailbox_folders WHERE mailbox_id = ? ORDER BY path").all(mailboxId);
      if (cached.length) return cached;
    }
    let folders;
    const client = await this._connect(mailbox);
    try {
      if (mailbox.protocol === "pop3") {
        folders = [{ path: "INBOX", name: "Inbox", specialUse: "\\Inbox" }];
      } else {
        const listed = await client.list();
        folders = listed.map((folder) => ({
          path: folder.path, name: folder.name || folder.path,
          specialUse: folder.specialUse || (Array.from(folder.flags || []).find((flag) => /^\\(Inbox|Trash|Sent|Drafts|Junk)$/i.test(flag)) || ""),
        }));
      }
      this._storeFolders(mailboxId, folders);
      this._setHealth(mailboxId, "healthy", "", true);
      return folders;
    } catch (error) {
      await logImapAuthDiagnostics(error, {
        stage: "folders", host: mailbox.host, port: mailbox.port, authType: mailbox.authType,
        username: mailbox.username, accessToken: mailbox.authType === "oauth2" ? mailbox.accessToken : undefined,
      });
      this._setHealth(mailboxId, "error", userError(error), true);
      throw error;
    } finally {
      await this._close(client, mailbox.protocol);
    }
  }

  _storeFolders(mailboxId, folders) {
    const replace = this.db.transaction(() => {
      this.db.prepare("DELETE FROM mailbox_folders WHERE mailbox_id = ?").run(mailboxId);
      const insert = this.db.prepare("INSERT INTO mailbox_folders (mailbox_id,path,name,special_use,cached_at) VALUES (?,?,?,?,?)");
      folders.forEach((folder) => insert.run(mailboxId, folder.path, folder.name, folder.specialUse || null, now()));
    });
    replace();
  }

  async _parseMessage(source, fallback = {}) {
    const parsed = await simpleParser(source);
    const text = String(parsed.text || stripHtml(parsed.html || "")).slice(0, 2_000_000);
    const html = sanitizeEmailHtml(parsed.html || "").slice(0, 2_000_000);
    const attachments = (parsed.attachments || []).map((attachment) => ({
      filename: safeFileName(attachment.filename || "attachment"), contentType: attachment.contentType || "application/octet-stream",
      size: attachment.size || attachment.content?.length || 0,
    }));
    return {
      subject: asString(parsed.subject || fallback.subject || "(No subject)", 500),
      from: asString(parsed.from?.text || fallback.from || "", 500),
      to: asString(parsed.to?.text || fallback.to || "", 1000),
      date: (parsed.date || fallback.date || new Date()).toISOString(), text, html, attachments,
      preview: asString(text || stripHtml(html), 240),
    };
  }

  _upsertMessages(mailboxId, folderPath, messages) {
    if (!Array.isArray(messages) || !messages.length) {
      this._trimCache(mailboxId);
      return { inserted: 0, updated: 0 };
    }

    const serverUids = messages.map((message) => String(message.serverUid));
    const placeholders = serverUids.map(() => "?").join(",");
    const existingRows = this.db.prepare(
      `SELECT server_uid FROM mailbox_messages WHERE mailbox_id = ? AND folder_path = ? AND server_uid IN (${placeholders})`
    ).all(mailboxId, folderPath, ...serverUids);
    const existingUidSet = new Set(existingRows.map((row) => String(row.server_uid)));
    let inserted = 0;
    let updated = 0;

    const insert = this.db.prepare(`INSERT INTO mailbox_messages (id,mailbox_id,folder_path,server_uid,server_sequence,received_at,unread,flagged,has_attachments,payload_blob,cached_at)
      VALUES (@id,@mailboxId,@folderPath,@serverUid,@serverSequence,@receivedAt,@unread,@flagged,@hasAttachments,@payload,@cachedAt)
      ON CONFLICT(mailbox_id,folder_path,server_uid) DO UPDATE SET server_sequence=excluded.server_sequence,received_at=excluded.received_at,
      unread=excluded.unread,flagged=excluded.flagged,has_attachments=excluded.has_attachments,payload_blob=excluded.payload_blob,cached_at=excluded.cached_at`);
    const transaction = this.db.transaction(() => messages.forEach((message) => {
      const serverUid = String(message.serverUid);
      if (existingUidSet.has(serverUid)) updated += 1;
      else inserted += 1;

      insert.run({
        id: id(), mailboxId, folderPath, serverUid, serverSequence: message.serverSequence || null,
        receivedAt: message.payload.date, unread: message.unread ? 1 : 0, flagged: message.flagged ? 1 : 0,
        hasAttachments: message.payload.attachments.length ? 1 : 0, payload: this._encrypt(message.payload), cachedAt: now(),
      });
    }));
    transaction();
    this._trimCache(mailboxId);
    return { inserted, updated };
  }

  _trimCache(mailboxId) {
    const overflow = this.db.prepare("SELECT COUNT(*) AS count FROM mailbox_messages WHERE mailbox_id = ?").get(mailboxId).count - MAX_CACHED_MESSAGES;
    if (overflow > 0) {
      this.db.prepare(`DELETE FROM mailbox_messages WHERE id IN (
        SELECT id FROM mailbox_messages WHERE mailbox_id = ? ORDER BY cached_at ASC LIMIT ?
      )`).run(mailboxId, overflow);
    }
  }

  async refreshMailbox(mailboxId, options = {}) {
    const mailbox = this._mailboxWithSecret(mailboxId);
    const folderPath = asString(options.folderPath, 500) || "INBOX";
    const beforeUid = options.beforeUid ? String(options.beforeUid) : null;
    const client = await this._connect(mailbox);
    try {
      let parsedMessages = [];
      let unreadCount = 0;
      if (mailbox.protocol === "pop3") {
        const entries = await client.list();
        const selected = entries.sort((a, b) => a.sequence - b.sequence)
          .filter((entry) => !beforeUid || entry.sequence < Number(beforeUid)).slice(-SYNC_BATCH_SIZE).reverse();
        for (const entry of selected) {
          const payload = await this._parseMessage(await client.retrieve(entry.sequence));
          parsedMessages.push({ serverUid: entry.uid, serverSequence: entry.sequence, unread: false, flagged: false, payload });
        }
      } else {
        const folders = (await client.list()).map((folder) => ({
          path: folder.path, name: folder.name || folder.path,
          specialUse: folder.specialUse || (Array.from(folder.flags || []).find((flag) => /^\\(Inbox|Trash|Sent|Drafts|Junk)$/i.test(flag)) || ""),
        }));
        this._storeFolders(mailboxId, folders);
        if (!folders.some((folder) => folder.path === folderPath)) throw new Error("Folder not found");
        await client.mailboxOpen(folderPath, { readOnly: true });
        const uids = (await client.search({ all: true }, { uid: true })).map(Number).sort((a, b) => a - b);
        const selected = uids.filter((uid) => !beforeUid || uid < Number(beforeUid)).slice(-SYNC_BATCH_SIZE).reverse();
        if (selected.length) {
          for await (const message of client.fetch(selected, { uid: true, source: true, flags: true, envelope: true }, { uid: true })) {
            const flags = Array.from(message.flags || []);
            const unread = !flags.includes("\\Seen");
            if (unread) unreadCount += 1;
            const payload = await this._parseMessage(message.source, {
              subject: message.envelope?.subject, from: message.envelope?.from?.[0]?.address,
              date: message.envelope?.date,
            });
            parsedMessages.push({ serverUid: message.uid, serverSequence: null, unread, flagged: flags.includes("\\Flagged"), payload });
          }
        }
      }
      const upsertStats = this._upsertMessages(mailboxId, folderPath, parsedMessages);
      if (folderPath.toUpperCase() === "INBOX" && !beforeUid) {
        this.db.prepare("UPDATE mailboxes SET unread_count = ?, last_refreshed_at = ?, health = 'healthy', health_message = '', updated_at = ? WHERE id = ?")
          .run(unreadCount, now(), now(), mailboxId);
      } else {
        this.db.prepare("UPDATE mailboxes SET last_refreshed_at = ?, health = 'healthy', health_message = '', updated_at = ? WHERE id = ?")
          .run(now(), now(), mailboxId);
      }
      return {
        synced: parsedMessages.length,
        newMessages: upsertStats.inserted,
        folderPath,
        hasMore: parsedMessages.length === SYNC_BATCH_SIZE,
      };
    } catch (error) {
      await logImapAuthDiagnostics(error, {
        stage: "refresh", host: mailbox.host, port: mailbox.port, authType: mailbox.authType,
        username: mailbox.username, accessToken: mailbox.authType === "oauth2" ? mailbox.accessToken : undefined,
      });
      this._setHealth(mailboxId, "error", userError(error), true);
      throw error;
    } finally {
      await this._close(client, mailbox.protocol);
    }
  }

  getMessages(mailboxId, folderPath = "INBOX", options = {}) {
    const pageSize = Math.max(1, Math.min(50, Number(options.pageSize) || 50));
    const page = Math.max(1, Number(options.page) || 1);
    const total = this.db.prepare("SELECT COUNT(*) AS count FROM mailbox_messages WHERE mailbox_id = ? AND folder_path = ?").get(mailboxId, folderPath).count;
    const rows = this.db.prepare(`SELECT * FROM mailbox_messages WHERE mailbox_id = ? AND folder_path = ?
      ORDER BY received_at DESC, cached_at DESC LIMIT ? OFFSET ?`).all(mailboxId, folderPath, pageSize, (page - 1) * pageSize);
    const items = rows.map((row) => {
      const payload = this._decrypt(row.payload_blob);
      return { id: row.id, serverUid: row.server_uid, serverSequence: row.server_sequence, unread: Boolean(row.unread), flagged: Boolean(row.flagged),
        hasAttachments: Boolean(row.has_attachments), subject: payload.subject, from: payload.from, date: payload.date, preview: payload.preview };
    });
    const oldest = this.db.prepare("SELECT server_uid, server_sequence FROM mailbox_messages WHERE mailbox_id = ? AND folder_path = ? ORDER BY received_at ASC LIMIT 1").get(mailboxId, folderPath);
    return { items, total, page, pageSize, oldest: oldest ? { serverUid: oldest.server_uid, serverSequence: oldest.server_sequence } : null };
  }

  getMessage(mailboxId, messageId) {
    const row = this.db.prepare("SELECT * FROM mailbox_messages WHERE mailbox_id = ? AND id = ?").get(mailboxId, messageId);
    if (!row) throw new Error("Message is not cached");
    const payload = this._decrypt(row.payload_blob);
    return { id: row.id, folderPath: row.folder_path, serverUid: row.server_uid, serverSequence: row.server_sequence, unread: Boolean(row.unread), flagged: Boolean(row.flagged), ...payload };
  }

  _messageRows(mailboxId, messageIds) {
    if (!Array.isArray(messageIds) || !messageIds.length || messageIds.length > 100) throw new Error("Select one or more cached messages");
    const placeholders = messageIds.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM mailbox_messages WHERE mailbox_id = ? AND id IN (${placeholders})`).all(mailboxId, ...messageIds);
    if (rows.length !== messageIds.length) throw new Error("One or more messages are unavailable");
    return rows;
  }

  async updateFlags(mailboxId, messageIds, changes) {
    const mailbox = this._mailboxWithSecret(mailboxId);
    if (mailbox.protocol !== "imap") throw new Error("This action is unavailable for POP3 mailboxes");
    const rows = this._messageRows(mailboxId, messageIds);
    const folders = new Map();
    rows.forEach((row) => { if (!folders.has(row.folder_path)) folders.set(row.folder_path, []); folders.get(row.folder_path).push(row); });
    const client = await this._connect(mailbox);
    try {
      for (const [folder, messages] of folders) {
        await client.mailboxOpen(folder, { readOnly: false });
        const uids = messages.map((message) => Number(message.server_uid));
        if (typeof changes.read === "boolean") {
          await (changes.read ? client.messageFlagsAdd(uids, ["\\Seen"], { uid: true }) : client.messageFlagsRemove(uids, ["\\Seen"], { uid: true }));
        }
        if (typeof changes.flagged === "boolean") {
          await (changes.flagged ? client.messageFlagsAdd(uids, ["\\Flagged"], { uid: true }) : client.messageFlagsRemove(uids, ["\\Flagged"], { uid: true }));
        }
      }
      const update = this.db.prepare("UPDATE mailbox_messages SET unread = COALESCE(?, unread), flagged = COALESCE(?, flagged), cached_at = ? WHERE id = ?");
      rows.forEach((row) => update.run(typeof changes.read === "boolean" ? Number(!changes.read) : null, typeof changes.flagged === "boolean" ? Number(changes.flagged) : null, now(), row.id));
      return { success: true };
    } finally { await this._close(client, mailbox.protocol); }
  }

  async moveMessages(mailboxId, messageIds, targetFolder) {
    const mailbox = this._mailboxWithSecret(mailboxId);
    if (mailbox.protocol !== "imap") throw new Error("Moving messages is unavailable for POP3 mailboxes");
    const destination = asString(targetFolder, 500);
    const folders = await this.getFolders(mailboxId, true);
    if (!folders.some((folder) => folder.path === destination)) throw new Error("Choose a valid destination folder");
    const rows = this._messageRows(mailboxId, messageIds);
    const grouped = new Map(); rows.forEach((row) => { if (!grouped.has(row.folder_path)) grouped.set(row.folder_path, []); grouped.get(row.folder_path).push(row); });
    const client = await this._connect(mailbox);
    try {
      for (const [folder, messages] of grouped) {
        await client.mailboxOpen(folder, { readOnly: false });
        await client.messageMove(messages.map((message) => Number(message.server_uid)), destination, { uid: true });
      }
      const placeholders = messageIds.map(() => "?").join(",");
      this.db.prepare(`DELETE FROM mailbox_messages WHERE id IN (${placeholders})`).run(...messageIds);
      return { success: true };
    } finally { await this._close(client, mailbox.protocol); }
  }

  async deleteMessages(mailboxId, messageIds, permanent = false) {
    const mailbox = this._mailboxWithSecret(mailboxId);
    const rows = this._messageRows(mailboxId, messageIds);
    const client = await this._connect(mailbox);
    try {
      if (mailbox.protocol === "pop3") {
        for (const row of rows) await client.delete(row.server_sequence);
      } else {
        const folders = (await client.list()).map((folder) => ({
          path: folder.path, name: folder.name || folder.path,
          specialUse: folder.specialUse || (Array.from(folder.flags || []).find((flag) => /^\\(Inbox|Trash|Sent|Drafts|Junk)$/i.test(flag)) || ""),
        }));
        this._storeFolders(mailboxId, folders);
        const trash = folders.find((folder) => /\\trash/i.test(folder.specialUse || ""));
        const grouped = new Map(); rows.forEach((row) => { if (!grouped.has(row.folder_path)) grouped.set(row.folder_path, []); grouped.get(row.folder_path).push(row); });
        if (!trash && !permanent) return { requiresPermanentConfirmation: true };
        for (const [folder, messages] of grouped) {
          await client.mailboxOpen(folder, { readOnly: false });
          const uids = messages.map((message) => Number(message.server_uid));
          if (trash) await client.messageMove(uids, trash.path, { uid: true });
          else await client.messageDelete(uids, { uid: true });
        }
      }
      const placeholders = messageIds.map(() => "?").join(",");
      this.db.prepare(`DELETE FROM mailbox_messages WHERE id IN (${placeholders})`).run(...messageIds);
      return { success: true };
    } finally { await this._close(client, mailbox.protocol); }
  }

  async downloadAttachment(mailboxId, messageId, attachmentIndex, destination) {
    const mailbox = this._mailboxWithSecret(mailboxId);
    const row = this.db.prepare("SELECT * FROM mailbox_messages WHERE mailbox_id = ? AND id = ?").get(mailboxId, messageId);
    if (!row) throw new Error("Message is unavailable");
    let source;
    const client = await this._connect(mailbox);
    try {
      if (mailbox.protocol === "imap") {
        await client.mailboxOpen(row.folder_path, { readOnly: true });
        source = (await client.fetchOne(Number(row.server_uid), { source: true }, { uid: true })).source;
      } else source = await client.retrieve(row.server_sequence);
      const parsed = await simpleParser(source);
      const attachment = parsed.attachments?.[Number(attachmentIndex)];
      if (!attachment || !attachment.content || !destination) throw new Error("Attachment is unavailable");
      await fs.writeFile(destination, attachment.content);
      return { filename: safeFileName(attachment.filename), size: attachment.content.length };
    } finally { await this._close(client, mailbox.protocol); }
  }

  startBatch(type, mailboxIds, onProgress) {
    const ids = Array.from(new Set(Array.isArray(mailboxIds) ? mailboxIds.filter((value) => typeof value === "string") : [])).slice(0, 500);
    if (!ids.length) throw new Error("Select at least one mailbox");
    const jobId = id();
    const job = { cancelled: false }; this.jobs.set(jobId, job);
    const run = async () => {
      let next = 0; let completed = 0;
      const concurrency = Math.min(ids.length, MAX_BATCH_CONCURRENCY);
      const worker = async () => {
        while (!job.cancelled) {
          const index = next++; if (index >= ids.length) break;
          const mailboxId = ids[index]; let result = "success"; let error = "";
          try {
            if (type === "test") await this.testConfig({}, mailboxId);
            else await this.refreshMailbox(mailboxId, { folderPath: "INBOX" });
          } catch (caught) { result = "error"; error = userError(caught); }
          completed += 1; onProgress({ jobId, type, mailboxId, completed, total: ids.length, result, error, done: false });
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      onProgress({ jobId, type, completed, total: ids.length, cancelled: job.cancelled, done: true });
      this.jobs.delete(jobId);
    };
    setImmediate(run);
    return { jobId, total: ids.length };
  }

  cancelBatch(jobId) {
    const job = this.jobs.get(jobId);
    if (job) job.cancelled = true;
  }
}

let instance;
function getMailboxManager() {
  if (!instance) instance = new MailboxManager();
  return instance;
}

module.exports = { getMailboxManager, userError, errorReason };
