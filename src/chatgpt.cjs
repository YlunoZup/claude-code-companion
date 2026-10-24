"use strict";

// chatgpt.cjs — signing in with ChatGPT, for the GPT models.
//
// This is OpenAI's "Sign in with ChatGPT" plan usage, the route OpenAI opened in
// September 2026 to open-source tools and personal projects that run locally:
// the user approves this tool once in the browser, and its requests count
// against their ChatGPT plan. They can cap or cut off its share at any time in
// ChatGPT's settings.
//   https://developers.openai.com/siwc/token-sharing-open-source
//
// The sign-in is this tool's own. It never reads or writes the Codex app's
// ~/.codex/auth.json: OpenAI replaces the refresh token every time it is used,
// so two programs refreshing one login would sign each other out.
//
// The tokens live in ~/.claude-profiles/chatgpt/auth.json, readable by the user
// alone, and are never printed or logged.

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");

// Overridable so the tests can stand in for OpenAI.
const AUTH_BASE = (process.env.CCC_CHATGPT_AUTH_URL || "https://auth.openai.com").replace(/\/+$/, "");
const API_BASE = (process.env.CCC_OPENAI_API_URL || "https://api.openai.com/v1").replace(/\/+$/, "");

// The API the tokens are for, which the authorization server checks by name.
const RESOURCE = "https://api.openai.com/v1";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const AGENT_NAME = "claude-multi-account";
const CALLBACK_PATH = "/auth/callback";
const PREFERRED_PORT = 1455;
const USAGE_URL = "https://chatgpt.com/settings/usage";

// Refresh this long before the access token runs out, so a request never
// starts with one that expires mid-flight.
const REFRESH_EARLY_MS = 2 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const LOCK_STALE_MS = 30 * 1000;
const LOCK_WAIT_MS = 20 * 1000;
const MODELS_MAX_AGE_MS = 12 * 60 * 60 * 1000;

class ChatGPTError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ── Files ────────────────────────────────────────────────────

function paths(home) {
  const dir = path.join(home || os.homedir(), ".claude-profiles", "chatgpt");
  return {
    dir,
    host: path.join(dir, "host.json"),
    auth: path.join(dir, "auth.json"),
    lock: path.join(dir, "auth.lock"),
    models: path.join(dir, "models.json"),
    limits: path.join(dir, "limits.json"),
    sessions: path.join(dir, "sessions"),
    log: path.join(dir, "router.log"),
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Temp file plus rename, created readable by the user only. Windows has no
// such mode bits; there the file is protected by sitting in the user's profile.
function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

// This machine's stable id, which OpenAI asks for so it can tell one install
// of a tool from another. Random, so it says nothing about the machine.
function hostState(p) {
  const existing = readJson(p.host);
  if (existing && typeof existing.ext_agent_host_id === "string") return existing;
  const state = { ext_agent_host_id: `urn:uuid:${crypto.randomUUID()}`, client_id: null };
  writePrivate(p.host, state);
  return state;
}

// ── HTTP ─────────────────────────────────────────────────────

function request(method, url, { headers = {}, body, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const mod = target.protocol === "http:" ? http : https;
    const req = mod.request(
      target,
      { method, headers: { "user-agent": `${AGENT_NAME} (ccc)`, "accept-encoding": "identity", ...headers }, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error(`timed out after ${timeoutMs / 1000}s`)));
    req.on("error", reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

function formBody(fields) {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

async function postForm(url, fields) {
  const body = formBody(fields);
  const res = await request("POST", url, {
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "content-length": Buffer.byteLength(body) },
    body,
  });
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {}
  return { status: res.status, json, text: res.body };
}

async function discovery() {
  const res = await request("GET", `${AUTH_BASE}/.well-known/openid-configuration`, { headers: { accept: "application/json" } });
  if (res.status !== 200) throw new ChatGPTError("discovery", `OpenAI's sign-in service answered ${res.status}`);
  const doc = JSON.parse(res.body);
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri || !doc.issuer) {
    throw new ChatGPTError("discovery", "OpenAI's sign-in service described itself incompletely");
  }
  return doc;
}

// ── PKCE, state, nonce ───────────────────────────────────────

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomToken = (bytes = 32) => b64url(crypto.randomBytes(bytes));
const challengeFor = (verifier) => b64url(crypto.createHash("sha256").update(verifier).digest());

// ── ID token ─────────────────────────────────────────────────

function decodeJwt(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) throw new ChatGPTError("id_token", "the ID token is malformed");
  const decode = (s) => JSON.parse(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  return { header: decode(parts[0]), payload: decode(parts[1]), signed: `${parts[0]}.${parts[1]}`, signature: Buffer.from(parts[2].replace(/-/g, "+").replace(/_/g, "/"), "base64") };
}

// Check the ID token the way OpenAI asks: signed by one of its published keys,
// issued by it, for this client, unexpired, and answering this sign-in's nonce.
async function verifyIdToken(idToken, { doc, clientId, nonce, now = Date.now() }) {
  const jwt = decodeJwt(idToken);
  if (jwt.header.alg !== "RS256") throw new ChatGPTError("id_token", `unexpected ID token algorithm ${jwt.header.alg}`);
  const res = await request("GET", doc.jwks_uri, { headers: { accept: "application/json" } });
  const keys = (JSON.parse(res.body).keys || []).filter((k) => k.kty === "RSA");
  const jwk = keys.find((k) => k.kid === jwt.header.kid) || (keys.length === 1 ? keys[0] : null);
  if (!jwk) throw new ChatGPTError("id_token", "the ID token was signed with a key OpenAI does not publish");
  const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  if (!crypto.verify("RSA-SHA256", Buffer.from(jwt.signed), key, jwt.signature)) {
    throw new ChatGPTError("id_token", "the ID token's signature does not verify");
  }
  const claims = jwt.payload;
  if (claims.iss !== doc.issuer) throw new ChatGPTError("id_token", "the ID token comes from an unexpected issuer");
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(clientId)) throw new ChatGPTError("id_token", "the ID token was issued to a different client");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < now - 60000) throw new ChatGPTError("id_token", "the ID token has expired");
  if (nonce && claims.nonce !== nonce) throw new ChatGPTError("id_token", "the ID token does not answer this sign-in");
  return claims;
}

// The plan, wherever OpenAI puts it in the claims: "pro", "plus", …
function planFrom(claims) {
  const auth = claims && claims["https://api.openai.com/auth"];
  const plan = (auth && (auth.chatgpt_plan_type || auth.plan_type)) || (claims && (claims.chatgpt_plan_type || claims.plan_type));
  return typeof plan === "string" && plan ? plan : null;
}

function planLabel(plan) {
  if (!plan) return "ChatGPT";
  const known = { pro: "Pro", plus: "Plus", go: "Go", team: "Team", business: "Business", enterprise: "Enterprise", edu: "Edu", free: "Free" };
  return `ChatGPT ${known[String(plan).toLowerCase()] || plan}`;
}

// ── Saved sign-in ────────────────────────────────────────────

// What is known about the sign-in, without any secret in it.
function status({ home } = {}) {
  const p = paths(home);
  const auth = readJson(p.auth);
  const signedIn = Boolean(auth && auth.refresh_token);
  const account = (auth && auth.account) || {};
  // OpenAI's sign-in does not say which plan it is; Codex's last answer does.
  const limits = readJson(p.limits);
  const plan = account.plan || (limits && limits.status === "ok" && limits.planType) || null;
  return {
    signedIn,
    planUsage: Boolean(signedIn && auth.plan_usage),
    email: account.email || null,
    name: account.name || null,
    plan,
    planLabel: planLabel(plan),
    clientId: (auth && auth.client_id) || null,
    expiresAt: (auth && auth.expires_at) || null,
  };
}

function scopeIncludes(scope, wanted) {
  return String(scope || "")
    .split(/\s+/)
    .includes(wanted);
}

function saveTokens(p, previous, tokens, extra = {}) {
  const now = Date.now();
  const record = {
    ...(previous || {}),
    ...extra,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || (previous && previous.refresh_token),
    id_token: tokens.id_token || (previous && previous.id_token) || null,
    scope: tokens.scope || (previous && previous.scope) || "",
    expires_at: now + (Number(tokens.expires_in) || 3600) * 1000,
    earliest_refresh_at: tokens.earliest_refresh_at ? toMs(tokens.earliest_refresh_at) : null,
    updated_at: now,
  };
  record.plan_usage = scopeIncludes(record.scope, PLAN_SCOPE);
  writePrivate(p.auth, record);
  return record;
}

function toMs(value) {
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Forget the tokens but keep who the account is and which client OpenAI issued,
// so signing in again reuses the registration.
function clearTokens(p) {
  const auth = readJson(p.auth);
  if (!auth) return;
  const { access_token, refresh_token, id_token, expires_at, earliest_refresh_at, ...keep } = auth;
  writePrivate(p.auth, { ...keep, plan_usage: false, signed_out_at: Date.now() });
}

// ── Lock ─────────────────────────────────────────────────────

// Refreshing replaces the refresh token, so two router processes refreshing at
// once would leave one holding a dead token. A directory is the lock: creating
// it is atomic everywhere, and a crashed holder's is cleared after a while.
async function withLock(p, fn) {
  fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(p.lock);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(p.lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmdirSync(p.lock);
          continue;
        }
      } catch {}
      if (Date.now() > deadline) throw new ChatGPTError("locked", "another ccc process has been refreshing the ChatGPT sign-in for too long");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      fs.rmdirSync(p.lock);
    } catch {}
  }
}

// ── Access token ─────────────────────────────────────────────

const TERMINAL_REFRESH_ERRORS = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

// A usable access token, refreshed first when it is close to running out.
// force refreshes regardless, for when OpenAI has just turned the current one
// down. Throws ChatGPTError "signed_out" when there is no usable sign-in.
async function getAccessToken({ home, force = false } = {}) {
  const p = paths(home);
  const first = readJson(p.auth);
  if (!first || !first.refresh_token) throw new ChatGPTError("signed_out", "ChatGPT is not signed in. Run: ccc gpt login");
  if (!first.plan_usage) throw new ChatGPTError("no_plan_usage", "ChatGPT plan usage was not approved for ccc. Run ccc gpt login and allow it.");
  if (!force && first.access_token && first.expires_at - Date.now() > REFRESH_EARLY_MS) return first.access_token;

  return withLock(p, async () => {
    // Another process may have refreshed while this one waited.
    const auth = readJson(p.auth);
    if (!auth || !auth.refresh_token) throw new ChatGPTError("signed_out", "ChatGPT is not signed in. Run: ccc gpt login");
    const refreshedMeanwhile = auth.access_token !== first.access_token;
    if (auth.access_token && auth.expires_at - Date.now() > REFRESH_EARLY_MS && (!force || refreshedMeanwhile)) return auth.access_token;

    const res = await postForm(auth.token_endpoint || `${AUTH_BASE}/api/accounts/oauth/token`, {
      grant_type: "refresh_token",
      client_id: auth.client_id,
      refresh_token: auth.refresh_token,
      resource: RESOURCE,
    });
    if (res.status === 200 && res.json && res.json.access_token) return saveTokens(p, auth, res.json).access_token;

    // OAuth errors come as { error: "invalid_grant" }, API-style ones as
    // { error: { code } }.
    const error = res.json && res.json.error;
    const code = String((error && typeof error === "object" ? error.code : error) || "");
    if (TERMINAL_REFRESH_ERRORS.has(code) || res.status === 401) {
      clearTokens(p);
      throw new ChatGPTError("signed_out", "The ChatGPT sign-in has ended (it was revoked, expired or disconnected). Sign in again with: ccc gpt login");
    }
    throw new ChatGPTError("refresh_failed", `Could not refresh the ChatGPT sign-in (${code || `HTTP ${res.status}`}); will try again on the next request`);
  });
}

// ── Models ───────────────────────────────────────────────────

function normaliseModels(list) {
  return (list || [])
    .filter((m) => m && typeof m === "object" && (m.slug || m.id) && (m.visibility === undefined || m.visibility === "list"))
    .map((m) => ({
      id: String(m.slug || m.id),
      name: String(m.display_name || m.slug || m.id),
      efforts: (m.supported_reasoning_levels || m.supported_reasoning_efforts || m.reasoning_efforts || [])
        .map((e) => (typeof e === "string" ? e : e && (e.effort || e.level)))
        .filter(Boolean),
      defaultEffort: m.default_reasoning_level || m.default_reasoning_effort || null,
      contextWindow: Number(m.context_window || m.max_context_window) || null,
    }));
}

// The models the signed-in account can use, from cache when it is recent.
// Never throws: with no answer and no cache it gives an empty list.
async function listModels({ home, maxAgeMs = MODELS_MAX_AGE_MS, timeoutMs = 8000 } = {}) {
  const p = paths(home);
  const cached = readJson(p.models);
  if (cached && Array.isArray(cached.models) && Date.now() - cached.fetchedAt < maxAgeMs) return cached.models;
  try {
    const token = await getAccessToken({ home });
    const res = await request("GET", `${API_BASE}/models`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, timeoutMs });
    if (res.status === 200) {
      const json = JSON.parse(res.body);
      const models = normaliseModels(json.data || json.models || []);
      if (models.length) {
        writePrivate(p.models, { fetchedAt: Date.now(), models });
        return models;
      }
    }
  } catch {}
  return cached && Array.isArray(cached.models) ? cached.models : [];
}

// ── Plan limits ──────────────────────────────────────────────
//
// OpenAI tells a tool on this route nothing about how much of the plan is
// left. Codex can: its app-server reports the plan's limits for the Codex
// sign-in, and requests made here count against the same allowance. So ccc
// asks a Codex that is already installed — the CLI, the IDE extension or the
// desktop app — and Codex answers with its own login, which ccc never reads.
// CCC_CODEX_BIN names a Codex to use; "none" turns this off.

const LIMITS_FRESH_MS = 2 * 60 * 1000;

function versionOf(dir) {
  const m = /-(\d+(?:\.\d+)*)-/.exec(path.basename(dir));
  return m ? m[1].split(".").map(Number) : [];
}

function newerFirst(a, b) {
  const va = versionOf(a);
  const vb = versionOf(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] || 0) - (va[i] || 0);
    if (d) return d;
  }
  return 0;
}

// The Codex executable to ask, or null.
function findCodex({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  if (env.CCC_CODEX_BIN) return env.CCC_CODEX_BIN === "none" ? null : fs.existsSync(env.CCC_CODEX_BIN) ? env.CCC_CODEX_BIN : null;
  const exe = platform === "win32" ? "codex.exe" : "codex";
  for (const dir of String(env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  // The IDE extension ships its own, one folder per version.
  for (const editor of [".vscode", ".vscode-insiders", ".cursor", ".windsurf"]) {
    const extensions = path.join(home, editor, "extensions");
    let dirs = [];
    try {
      dirs = fs.readdirSync(extensions).filter((d) => d.startsWith("openai.chatgpt-")).map((d) => path.join(extensions, d));
    } catch {
      continue;
    }
    for (const dir of dirs.sort(newerFirst)) {
      let arches = [];
      try {
        arches = fs.readdirSync(path.join(dir, "bin"));
      } catch {}
      for (const arch of arches) {
        const candidate = path.join(dir, "bin", arch, exe);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  const app = "/Applications/Codex.app/Contents/Resources/codex";
  if (platform === "darwin" && fs.existsSync(app)) return app;
  return null;
}

// "in 4h 2m", "in 2d 6h" — as usage.cjs words a Claude limit's reset.
function formatReset(resetsAt, now = Date.now()) {
  return require("./usage.cjs").formatResetIn(resetsAt, now);
}

function windowLabel(minutes) {
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "week";
  if (minutes && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes && minutes % 60 === 0) return `${minutes / 60}h`;
  return minutes ? `${minutes}m` : "limit";
}

// Codex's account/rateLimits/read answer as
//   { status: "ok", planType, windows: [{ label, minutes, used, left, resetsAt }],
//     credits, resetCredits, reached, fetchedAt }
// windows shortest first; resetsAt in epoch ms.
function parsePlanLimits(result, fetchedAt = Date.now()) {
  const limits = result && (result.rateLimits || (result.rateLimitsByLimitId && result.rateLimitsByLimitId.codex));
  if (!limits || typeof limits !== "object") return { status: "unavailable" };
  const windows = [];
  for (const w of [limits.primary, limits.secondary]) {
    if (!w || typeof w.usedPercent !== "number") continue;
    const used = Math.min(100, Math.max(0, w.usedPercent));
    const minutes = Number(w.windowDurationMins) || null;
    windows.push({ label: windowLabel(minutes), minutes, used, left: 100 - used, resetsAt: w.resetsAt ? w.resetsAt * 1000 : null });
  }
  windows.sort((a, b) => (a.minutes || 0) - (b.minutes || 0));
  const reset = result.rateLimitResetCredits;
  return {
    status: "ok",
    planType: limits.planType || null,
    windows,
    credits: limits.credits || null,
    resetCredits: (reset && reset.availableCount) || 0,
    reached: limits.rateLimitReachedType || null,
    fetchedAt,
  };
}

// Ask Codex. Never rejects: a failure is { status: "error", error }.
function askCodex({ command, args = ["app-server"], timeoutMs = 10000, env = process.env } = {}) {
  return new Promise((resolve) => {
    if (!command) {
      resolve({ status: "unavailable", error: "no Codex installed" });
      return;
    }
    let child;
    try {
      child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"], env, windowsHide: true });
    } catch (err) {
      resolve({ status: "error", error: err.message });
      return;
    }
    let settled = false;
    let buffered = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish({ status: "error", error: "Codex did not answer" }), timeoutMs);
    const send = (message) => {
      try {
        child.stdin.write(JSON.stringify(message) + "\n");
      } catch {}
    };
    child.on("error", (err) => finish({ status: "error", error: err.message }));
    child.on("close", () => finish({ status: "error", error: "Codex exited without answering" }));
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          send({ method: "initialized" });
          send({ method: "account/rateLimits/read", id: 2 });
        } else if (message.id === 2) {
          finish(message.result ? parsePlanLimits(message.result) : { status: "error", error: (message.error && message.error.message) || "Codex refused" });
        }
      }
    });
    send({ method: "initialize", id: 1, params: { clientInfo: { name: "ccc", title: "claude-multi-account", version: "0.1.0" } } });
  });
}

// The plan's limits: from cache when it is recent, else asked of Codex now and
// cached. Falls back to the last answer there is, marked by its fetchedAt.
async function planLimits({ home, maxAgeMs = LIMITS_FRESH_MS, env = process.env, timeoutMs } = {}) {
  const p = paths(home);
  const cached = readJson(p.limits);
  if (cached && cached.status === "ok" && Date.now() - cached.fetchedAt < maxAgeMs) return cached;
  const fresh = await askCodex({ command: findCodex({ env, home: home || os.homedir() }), env, timeoutMs });
  if (fresh.status === "ok") {
    try {
      writePrivate(p.limits, fresh);
    } catch {}
    return fresh;
  }
  return cached && cached.status === "ok" ? cached : fresh;
}

// The cached answer alone, for the statusline, which must not wait on Codex.
function cachedPlanLimits({ home } = {}) {
  const cached = readJson(paths(home).limits);
  return cached && cached.status === "ok" ? cached : null;
}

// Whether a model id is one of the GPT models, by the cached list or its name.
function isGptModelId(id, models) {
  const bare = String(id || "").replace(/\[\d+m\]$/i, "");
  if ((models || []).some((m) => m.id === bare)) return true;
  return /^(gpt-|o\d|codex-)/i.test(bare);
}

// ── Signing in ───────────────────────────────────────────────

function openBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server.address().port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

const PAGE = (title, text) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px system-ui;max-width:32em;margin:15vh auto;padding:0 1em">` +
  `<h1 style="font-size:1.4em">${title}</h1><p>${text}</p></body>`;

// Sign in in the browser, and save what comes back.
//
//   opts.fresh    register this machine again rather than reuse the earlier
//                 registration, e.g. to switch ChatGPT accounts
//   opts.browser  open the browser (default); false only prints the link
//   opts.say      where progress lines go
//   opts.input    a stream to read a pasted redirect URL from, for a machine
//                 whose browser cannot reach this one (over SSH, say)
async function login({ home, fresh = false, browser = true, say = () => {}, input = null, timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
  const p = paths(home);
  const host = hostState(p);
  if (fresh && host.client_id) {
    host.client_id = null;
    writePrivate(p.host, host);
  }
  const doc = await discovery();
  const previous = readJson(p.auth);
  const reusing = Boolean(host.client_id);

  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken(48);

  let finish;
  let fail;
  const done = new Promise((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
      return;
    }
    const outcome = handleCallback(url.searchParams);
    res.writeHead(outcome.ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
    res.end(outcome.ok ? PAGE("Signed in", "You can close this tab and go back to the terminal.") : PAGE("Sign-in did not finish", outcome.message));
    if (outcome.ok) finish(outcome);
    else fail(new ChatGPTError(outcome.code, outcome.message));
  });

  function handleCallback(params) {
    if (params.get("state") !== state) return { ok: false, code: "state", message: "This sign-in link is out of date. Start again from the terminal." };
    const error = params.get("error");
    if (error === "access_denied") return { ok: false, code: "declined", message: "You declined in the browser, so nothing was saved." };
    if (error) return { ok: false, code: error, message: `OpenAI answered: ${params.get("error_description") || error}` };
    const code = params.get("code");
    if (!code) return { ok: false, code: "no_code", message: "OpenAI sent no authorization code." };
    const issued = params.get("client_id");
    if (reusing && issued && issued !== host.client_id) return { ok: false, code: "client_mismatch", message: "OpenAI answered for a different registration. Start again with: ccc gpt login --new" };
    const clientId = reusing ? host.client_id : issued;
    if (!clientId) return { ok: false, code: "no_client", message: "OpenAI did not say which client it registered." };
    return { ok: true, code, clientId };
  }

  let port;
  try {
    port = await listen(server, PREFERRED_PORT);
  } catch {
    port = await listen(server, 0);
  }
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;

  const params = new URLSearchParams({
    client_id: reusing ? host.client_id : "dynamic_agent_client",
    ext_agent_host_id: host.ext_agent_host_id,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPE,
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: challengeFor(verifier),
  });
  if (!reusing) params.set("agent_name_hint", AGENT_NAME);
  if (reusing && previous && previous.account && previous.account.email) params.set("login_hint", previous.account.email);
  const authorizeUrl = `${doc.authorization_endpoint}?${params}`;

  say("Continue with ChatGPT in your browser.");
  say("If it does not open, visit this link:");
  say("");
  say(`  ${authorizeUrl}`);
  say("");
  say("If your browser cannot reach this machine, paste the address it ends up on here.");
  if (browser) openBrowser(authorizeUrl);

  let rl = null;
  if (input) {
    rl = readline.createInterface({ input });
    rl.on("line", (line) => {
      const text = line.trim();
      if (!text) return;
      let url;
      try {
        url = new URL(text);
      } catch {
        return;
      }
      const outcome = handleCallback(url.searchParams);
      if (outcome.ok) finish(outcome);
      else fail(new ChatGPTError(outcome.code, outcome.message));
    });
  }

  const timer = setTimeout(() => fail(new ChatGPTError("timeout", "The sign-in timed out. Run ccc gpt login to try again.")), timeoutMs);
  let outcome;
  try {
    outcome = await done;
  } finally {
    clearTimeout(timer);
    server.close();
    // The browser may hold its connection open, which would keep this process
    // alive after the sign-in is done.
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    if (rl) rl.close();
  }

  const res = await postForm(doc.token_endpoint, {
    grant_type: "authorization_code",
    client_id: outcome.clientId,
    code: outcome.code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    resource: RESOURCE,
  });
  if (res.status !== 200 || !res.json || !res.json.access_token || !res.json.refresh_token) {
    const why = (res.json && (res.json.error_description || res.json.error)) || `HTTP ${res.status}`;
    throw new ChatGPTError("exchange", `OpenAI did not complete the sign-in: ${why}`);
  }

  const claims = await verifyIdToken(res.json.id_token, { doc, clientId: outcome.clientId, nonce });
  host.client_id = outcome.clientId;
  writePrivate(p.host, host);

  const account = {
    sub: claims.sub,
    email: claims.email || null,
    name: claims.name || null,
    plan: planFrom(claims),
  };
  const saved = saveTokens(p, null, res.json, {
    client_id: outcome.clientId,
    account,
    token_endpoint: doc.token_endpoint,
    revocation_endpoint: doc.revocation_endpoint || null,
  });
  // Whatever models the last account had may not be this one's.
  try {
    fs.unlinkSync(p.models);
  } catch {}
  return { ...status({ home }), planUsage: saved.plan_usage, firstTime: !reusing };
}

// Revoke the sign-in at OpenAI and forget the tokens. Keeps the registration,
// as OpenAI asks, so a later sign-in reuses it.
async function logout({ home } = {}) {
  const p = paths(home);
  const auth = readJson(p.auth);
  if (!auth || !auth.refresh_token) return { wasSignedIn: false, revoked: false };
  let revoked = false;
  try {
    const endpoint = auth.revocation_endpoint || (await discovery()).revocation_endpoint;
    if (endpoint) {
      const res = await postForm(endpoint, { token: auth.refresh_token, token_type_hint: "refresh_token", client_id: auth.client_id });
      revoked = res.status === 200;
    }
  } catch {}
  clearTokens(p);
  try {
    fs.unlinkSync(p.models);
  } catch {}
  return { wasSignedIn: true, revoked };
}

// ── CLI ──────────────────────────────────────────────────────

const HELP = `usage: ccc gpt <command>

  login [--new]      sign in with ChatGPT (--new registers this machine afresh,
                     e.g. to switch ChatGPT accounts)
  logout             sign ChatGPT out and revoke ccc's access
  status             show the sign-in and the GPT models it gives
  models             list the GPT models, refreshed from OpenAI
  on <n> | off <n>   always (or no longer) offer the GPT models in account n

Requests to GPT models count against your ChatGPT plan.
Manage how much ccc may use at ${USAGE_URL}`;

async function main(argv, { out = (l) => process.stdout.write(l + "\n"), err = (l) => process.stderr.write(l + "\n") } = {}) {
  const [command, ...rest] = argv;
  const say = (line) => out(line ? `  ${line}` : "");

  switch (command) {
    case "login": {
      let result;
      try {
        result = await login({ fresh: rest.includes("--new"), browser: !rest.includes("--no-browser"), say, input: process.stdin.isTTY ? process.stdin : null });
      } catch (e) {
        err(`  ${e.message}`);
        return 1;
      }
      // The terminal may still be reading the paste line.
      if (process.stdin.isTTY) process.stdin.pause();
      say("");
      say(`Signed in as ${result.email || "your ChatGPT account"} · ${result.planLabel}`);
      if (!result.planUsage) {
        say("");
        say("Plan usage was not allowed, so ccc cannot use GPT models with this sign-in.");
        say("Run ccc gpt login again and allow ccc to use your ChatGPT plan.");
        return 1;
      }
      const slot = ensureSlot(result);
      say("");
      say("You're using your ChatGPT plan");
      say("GPT requests from Claude Code now count against your ChatGPT plan.");
      say(`Manage usage: ${USAGE_URL}`);
      if (slot) {
        say("");
        say(slot.created ? `Added account ${slot.key}, "${slot.name}": start it with  ccc ${slot.key}` : `Account ${slot.key} runs Claude Code on GPT models: ccc ${slot.key}`);
        say("To add the GPT models to any other account's /model:  ccc <n> --gpt");
      }
      say("");
      return 0;
    }

    case "logout": {
      const result = await logout();
      if (!result.wasSignedIn) say("ChatGPT was not signed in.");
      else if (result.revoked) say("Signed ChatGPT out and revoked ccc's access.");
      else {
        say("Signed ChatGPT out here, but OpenAI did not confirm the access was revoked.");
        say("To make sure, disconnect claude-multi-account in ChatGPT's settings.");
      }
      return 0;
    }

    case "status": {
      const s = status();
      if (rest.includes("--json")) {
        out(JSON.stringify(s));
        return 0;
      }
      if (!s.signedIn) {
        say("ChatGPT: not signed in. Run: ccc gpt login");
        return 1;
      }
      const limits = await planLimits({ maxAgeMs: 0 });
      const now = Date.now();
      say(`ChatGPT: signed in as ${s.email || "(unknown)"} · ${planLabel(s.plan || (limits.status === "ok" && limits.planType))}`);
      say(s.planUsage ? `Plan usage: on — GPT requests count against your plan. Manage usage: ${USAGE_URL}` : "Plan usage: not allowed — run ccc gpt login and allow it");
      if (limits.status === "ok" && limits.windows.length) {
        const parts = limits.windows.map((w) => `${w.label} ${Math.round(w.left)}% left${w.resetsAt ? ` (resets ${formatReset(w.resetsAt, now)})` : ""}`);
        const age = now - limits.fetchedAt > LIMITS_FRESH_MS ? `, as of ${Math.round((now - limits.fetchedAt) / 60000)} min ago` : "";
        say(`Usage left: ${parts.join(" · ")}${age} — the whole plan, as Codex reports it`);
      } else {
        say(`Usage left: ${limits.status === "unavailable" ? "needs Codex installed and signed in to report it" : `Codex could not report it (${limits.error})`}; see ${USAGE_URL}`);
      }
      const models = await listModels();
      if (models.length) say(`Models: ${models.map((m) => `${m.name} (${m.id})`).join(", ")}`);
      return 0;
    }

    case "models": {
      const models = await listModels({ maxAgeMs: rest.includes("--cached") ? Infinity : 0 });
      if (rest.includes("--json")) {
        out(JSON.stringify(models));
        return 0;
      }
      if (!models.length) {
        say(status().signedIn ? "OpenAI listed no models for this sign-in." : "ChatGPT: not signed in. Run: ccc gpt login");
        return 1;
      }
      for (const m of models) say(`${m.id.padEnd(22)} ${m.name}${m.efforts.length ? `   effort: ${m.efforts.join(", ")}` : ""}`);
      return 0;
    }

    case "help":
    case "-h":
    case "--help":
    case undefined:
      out(HELP);
      return command === undefined ? 1 : 0;

    default:
      err(`  Unknown command: ccc gpt ${command}`);
      err(HELP);
      return 1;
  }
}

// After a sign-in, make sure the picker has an entry that runs on GPT models.
function ensureSlot(result) {
  try {
    const profiles = require("./profiles.cjs");
    return profiles.ensureGptAccount({ name: result.planLabel });
  } catch {
    return null;
  }
}

module.exports = {
  AUTH_BASE,
  API_BASE,
  RESOURCE,
  SCOPE,
  PLAN_SCOPE,
  USAGE_URL,
  ChatGPTError,
  paths,
  readJson,
  writePrivate,
  hostState,
  request,
  discovery,
  challengeFor,
  decodeJwt,
  verifyIdToken,
  planFrom,
  planLabel,
  status,
  getAccessToken,
  normaliseModels,
  listModels,
  findCodex,
  windowLabel,
  parsePlanLimits,
  askCodex,
  planLimits,
  cachedPlanLimits,
  isGptModelId,
  login,
  logout,
  HELP,
  main,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
