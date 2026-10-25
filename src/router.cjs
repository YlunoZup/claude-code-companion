"use strict";

// router.cjs — Claude Code with the GPT models in it.
//
// `ccc <n> --gpt` and the ChatGPT account start Claude Code through this file.
// It opens a small HTTP server on 127.0.0.1, points Claude Code at it with
// ANTHROPIC_BASE_URL, and passes each request on by the model it names:
//
//   a Claude model  -> api.anthropic.com, byte for byte, carrying the account's
//                      own login: Claude Code's header, which is never stored
//   a GPT model     -> OpenAI's Responses API, translated by translate.cjs and
//                      signed with the ChatGPT sign-in from chatgpt.cjs
//
// The GPT models reach the /model picker through a modelPicker setting handed to
// Claude Code with --settings. Each row "behaves as" claude-sonnet-5, a model
// this Claude Code knows, which gives it the effort control and a 1M window;
// a per-model auto-compact window then brings that down to the GPT model's own
// context window, the one Codex uses for it, so Claude Code compacts before
// the model runs out of room.
//
// The server lives exactly as long as the Claude Code it starts. Nothing here
// writes to the terminal while Claude Code is running; problems go to
// ~/.claude-profiles/chatgpt/router.log, which never holds a token or a prompt.

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { spawn } = require("child_process");
const chatgpt = require("./chatgpt.cjs");
const translate = require("./translate.cjs");

const DEFAULT_UPSTREAM = "https://api.anthropic.com";
const BEHAVES_AS = "claude-sonnet-5";

// Claude Code accepts an auto-compact window between these. A model whose window
// OpenAI does not state gets the one most GPT models have.
const MIN_WINDOW = 100000;
const MAX_WINDOW = 1000000;
const FALLBACK_WINDOW = 272000;
const ROUTER_KEY_HEADER = "x-ccc-router-key";

// Claude Code gives up on a stream that sends nothing for a while, and a GPT
// model can reason for minutes before its first word, so the router pings.
const PING_MS = 10000;

// How long a reply is held back waiting for the model to start, so that a
// refusal can still go back as an HTTP error (see streamBack).
const HOLD_MS = 15000;

// The HTTP status of each Anthropic error type.
const STATUS_FOR = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  overloaded_error: 529,
};
const LOG_MAX_BYTES = 1024 * 1024;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

// Fields the router adds to a Responses request that the endpoint may turn
// down; once it has, they are left out for the rest of the session.
const OPTIONAL_FIELDS = ["reasoning.summary", "include", "prompt_cache_key", "parallel_tool_calls", "text"];

// ── Small helpers ────────────────────────────────────────────

function makeLog(file) {
  if (!file) return () => {};
  return (fields) => {
    try {
      try {
        if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, `${file}.old`);
      } catch {}
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...fields }) + "\n");
    } catch {}
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// A request body as text, undoing any compression Claude Code applied.
function decodeBody(buf, encoding) {
  const enc = String(encoding || "").toLowerCase().trim();
  if (!enc || enc === "identity") return buf.toString("utf8");
  if (enc === "gzip" || enc === "x-gzip") return zlib.gunzipSync(buf).toString("utf8");
  if (enc === "deflate") return zlib.inflateSync(buf).toString("utf8");
  if (enc === "br") return zlib.brotliDecompressSync(buf).toString("utf8");
  if (enc === "zstd" && typeof zlib.zstdDecompressSync === "function") return zlib.zstdDecompressSync(buf).toString("utf8");
  throw new Error(`unsupported content-encoding ${enc}`);
}

function sendJson(res, status, value, headers = {}) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers });
  res.end(body);
}

function sendError(res, status, type, message, retry = false) {
  sendJson(res, status, { type: "error", error: { type, message } }, { "x-should-retry": retry ? "true" : "false" });
}

function sameSecret(given, expected) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(String(expected || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Turns a Server-Sent Events byte stream into parsed JSON events.
function sseParser(onEvent) {
  let buffer = "";
  return (chunk) => {
    buffer = (buffer + chunk).replace(/\r\n/g, "\n");
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data || data === "[DONE]") continue;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      onEvent(event);
    }
  };
}

// ── Models ───────────────────────────────────────────────────

// The model a request for GPT should go to. On the ChatGPT account every
// request is GPT's, so the names Claude Code uses for its own background work
// map onto the GPT models: haiku to the small one, anything else to the main.
function modelResolver(models, mode) {
  const byId = new Map(models.map((m) => [m.id, m]));
  const main = models[0] ? models[0].id : null;
  const smallModel = models.find((m) => /luna|mini|nano/i.test(m.id) && m.id.split("-")[1] === (main || "").split("-")[1]) || models.find((m) => /luna|mini|nano/i.test(m.id));
  const small = smallModel ? smallModel.id : main;
  const resolve = (requested) => {
    const bare = String(requested || "").replace(/\[\d+m\]$/i, "");
    if (byId.has(bare)) return bare;
    if (mode === "gpt") {
      if (/haiku/i.test(bare)) return small || bare;
      if (!bare || /^claude-|^(opus|sonnet|fable|best|default)$/i.test(bare)) return main || bare;
    }
    return bare;
  };
  const info = (id) => byId.get(id) || { id, name: id, efforts: [] };
  return { resolve, info, main, small, isGpt: (id) => chatgpt.isGptModelId(id, models) };
}

// ── The server ───────────────────────────────────────────────

//   opts.mode      "gpt": every request is answered by a GPT model
//                  "mixed": GPT models go to OpenAI, the rest to Anthropic
//   opts.key       the secret Claude Code sends, so no other program on this
//                  machine can spend the ChatGPT plan through the router
//   opts.upstream  where Claude requests go, normally api.anthropic.com
//   opts.models    the GPT models, as chatgpt.listModels gives them
//   opts.getToken  async ({force}) => ChatGPT access token
//   opts.onAnswer  called after each GPT answer; launch() uses it to keep the
//                  plan's usage figures fresh
function createRouter(opts) {
  const { mode, key, models = [], log = () => {}, onAnswer = () => {} } = opts;
  const upstream = new URL(opts.upstream || DEFAULT_UPSTREAM);
  const openaiBase = (opts.openaiBase || chatgpt.API_BASE).replace(/\/+$/, "");
  const getToken = opts.getToken || ((o) => chatgpt.getAccessToken({ home: opts.home, ...o }));
  const resolver = modelResolver(models, mode);
  const omit = new Set();
  const agents = { http: new http.Agent({ keepAlive: true }), https: new https.Agent({ keepAlive: true }) };
  const agentFor = (url) => (url.protocol === "http:" ? agents.http : agents.https);
  const modFor = (url) => (url.protocol === "http:" ? http : https);

  function keyMatches(req) {
    if (sameSecret(req.headers[ROUTER_KEY_HEADER], key)) return true;
    if (mode !== "gpt") return false;
    const auth = String(req.headers.authorization || "");
    return sameSecret(auth.replace(/^Bearer\s+/i, ""), key) || sameSecret(req.headers["x-api-key"], key);
  }

  // ── Claude: straight through ──

  function passthrough(req, res, body) {
    const prefix = upstream.pathname.replace(/\/+$/, "");
    const target = new URL(prefix + req.url, upstream.origin);
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(name) && name !== ROUTER_KEY_HEADER) headers[name] = value;
    }
    if (body) headers["content-length"] = String(body.length);

    const started = Date.now();
    const up = modFor(target).request(target, { method: req.method, headers, agent: agentFor(target) }, (upRes) => {
      const out = {};
      for (const [name, value] of Object.entries(upRes.headers)) if (!HOP_BY_HOP.has(name)) out[name] = value;
      res.writeHead(upRes.statusCode, out);
      upRes.pipe(res);
      upRes.on("error", (err) => res.destroy(err));
      upRes.on("end", () => {
        if (upRes.statusCode >= 400) log({ route: "anthropic", path: target.pathname, status: upRes.statusCode, ms: Date.now() - started });
      });
    });
    up.on("error", (err) => {
      log({ route: "anthropic", path: target.pathname, error: err.code || err.message });
      if (!res.headersSent) sendError(res, 502, "api_error", `The ccc router could not reach ${target.host}: ${err.message}`, true);
      else res.destroy(err);
    });
    res.on("close", () => {
      if (!res.writableFinished) up.destroy();
    });
    if (body) up.end(body);
    else req.pipe(up);
  }

  // A conversation that has been on a GPT model carries its reasoning in
  // thinking blocks Anthropic would reject; drop them before a Claude model
  // sees the conversation.
  function withoutGptReasoning(json) {
    let changed = false;
    for (const message of json.messages || []) {
      if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
      const kept = message.content.filter((block) => !translate.isGptReasoning(block));
      if (kept.length !== message.content.length) {
        changed = true;
        message.content = kept.length ? kept : [{ type: "text", text: "(reasoning by a GPT model)" }];
      }
    }
    return changed;
  }

  // ── GPT: translated ──

  function openResponses(request, token, signal) {
    return new Promise((resolve, reject) => {
      const target = new URL(`${openaiBase}/responses`);
      const body = JSON.stringify(request);
      const up = modFor(target).request(
        target,
        {
          method: "POST",
          agent: agentFor(target),
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "text/event-stream",
            "accept-encoding": "identity",
            "content-length": Buffer.byteLength(body),
            "user-agent": "claude-code-companion (ccc router)",
          },
        },
        resolve
      );
      up.on("error", reject);
      signal.onAbort = () => up.destroy();
      up.end(body);
    });
  }

  function readAll(stream) {
    return new Promise((resolve) => {
      const chunks = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      stream.on("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
  }

  // Which optional field an error is about, if it names one.
  function refusedField(mapped, text) {
    const param = String(mapped.param || "");
    for (const field of OPTIONAL_FIELDS) {
      if (param === field || param.startsWith(`${field}.`) || param.startsWith(`${field}[`)) return field;
    }
    for (const field of OPTIONAL_FIELDS) if (field.includes(".") || field.includes("_")) if (text.includes(field)) return field;
    return null;
  }

  async function gptMessages(req, res, body, countOnly) {
    if (countOnly) {
      sendJson(res, 200, { input_tokens: translate.estimateTokens(body) });
      return;
    }
    // Auto mode asks Anthropic's servers to vet the model's tool calls (the
    // safeguards field), which no other model's server can do. Turned down
    // as an unsupported beta, Claude Code drops it for the session and vets
    // each call itself, with requests of its own that come through here.
    if (body.safeguards) {
      const beta = String(req.headers["anthropic-beta"] || "")
        .split(",")
        .map((b) => b.trim())
        .find((b) => b.startsWith("dangerous-tool-use"));
      sendError(res, 400, "invalid_request_error", `safeguards: dangerous_tool_use is not supported on GPT models (anthropic-beta: ${beta || "dangerous-tool-use"})`);
      return;
    }
    const started = Date.now();
    const requested = String(body.model || "");
    const model = resolver.resolve(requested);
    const info = resolver.info(model);
    // Anthropic streams only when asked to; Claude Code leaves the field out
    // for its own small requests, auto mode's safety check among them.
    const wantsStream = body.stream === true;
    const signal = { onAbort: null };
    let aborted = false;
    res.on("close", () => {
      if (!res.writableFinished) {
        aborted = true;
        if (signal.onAbort) signal.onAbort();
      }
    });

    const fail = (status, type, message, retry, extra = {}) => {
      log({ route: "openai", model, status, ms: Date.now() - started, ...extra });
      sendError(res, status, type, message, retry);
    };

    let token;
    try {
      token = await getToken({ force: false });
    } catch (err) {
      return fail(err.code === "refresh_failed" ? 529 : 403, err.code === "refresh_failed" ? "overloaded_error" : "permission_error", `ChatGPT: ${err.message}`, err.code === "refresh_failed", { error: err.code });
    }

    for (let attempt = 0; attempt < 4; attempt++) {
      if (aborted) return;
      const { request, names } = translate.toResponsesRequest(body, { model, displayName: info.name, efforts: info.efforts, omit });
      let upRes;
      try {
        upRes = await openResponses(request, token, signal);
      } catch (err) {
        if (aborted) return;
        return fail(502, "api_error", `ChatGPT: could not reach OpenAI: ${err.message}`, true, { error: err.code || err.message });
      }
      if (aborted) return upRes.destroy();

      if (upRes.statusCode === 401 && attempt === 0) {
        upRes.resume();
        try {
          token = await getToken({ force: true });
        } catch (err) {
          return fail(403, "permission_error", `ChatGPT: ${err.message}`, false, { error: err.code });
        }
        continue;
      }

      if (upRes.statusCode !== 200) {
        const text = await readAll(upRes);
        const mapped = translate.toAnthropicError(upRes.statusCode, text);
        if (upRes.statusCode === 400) {
          const field = refusedField(mapped, text);
          if (field && !omit.has(field)) {
            omit.add(field);
            log({ route: "openai", model, note: `left out ${field}, which the endpoint refused` });
            continue;
          }
        }
        return fail(mapped.status, mapped.error.type, mapped.error.message, mapped.retry, { upstream: upRes.statusCode, code: mapped.code || undefined, request_id: upRes.headers["x-request-id"] });
      }

      return streamBack(upRes, res, {
        cancelled: () => aborted,
        effort: request.reasoning && request.reasoning.effort,
        model: requested || model,
        names,
        wantsStream,
        thinking: translate.wantsThinking(body),
        stops: Array.isArray(body.stop_sequences) ? body.stop_sequences.filter((s) => typeof s === "string" && s) : [],
        started,
        requestId: upRes.headers["x-request-id"],
      });
    }
    return fail(400, "invalid_request_error", "ChatGPT: the request was refused repeatedly", false);
  }

  // The answer, streamed back as it comes — but only once the model starts
  // answering. OpenAI reports a refusal such as a context overflow after its
  // stream has opened; held back until then, it can still reach Claude Code as
  // the HTTP error Anthropic would give, and "prompt is too long" is what makes
  // Claude Code compact the conversation and try again. A model slow to start
  // gets the stream opened anyway after a while, so the pings keep it alive.
  function streamBack(upRes, res, { cancelled = () => false, effort, model, names, wantsStream, thinking, stops, started, requestId }) {
    let lastWrite = Date.now();
    let opened = false;
    const held = [];
    const send = (event, data) => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      lastWrite = Date.now();
    };
    const open = () => {
      if (opened || !wantsStream || res.writableEnded) return;
      opened = true;
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", ...(requestId ? { "request-id": String(requestId) } : {}) });
      for (const [event, data] of held.splice(0)) send(event, data);
    };
    const write = (event, data) => {
      if (!wantsStream) return;
      if (opened) {
        send(event, data);
        return;
      }
      // A failure before the answer starts goes back as an HTTP error instead.
      if (event === "error") return;
      held.push([event, data]);
      if (event !== "message_start") open();
    };
    const translator = new translate.StreamTranslator({ model, names, emit: write, thinking, stops });
    translator.start();
    const openAnyway = setTimeout(open, HOLD_MS);
    const ping = setInterval(() => {
      if (opened && Date.now() - lastWrite >= PING_MS) send("ping", { type: "ping" });
    }, PING_MS / 2);

    // A stop sequence ends the answer here, so stop OpenAI generating the rest.
    const parse = sseParser((event) => {
      translator.handle(event);
      if (translator.done && translator.message.stop_reason === "stop_sequence") upRes.destroy();
    });
    upRes.setEncoding("utf8");
    upRes.on("data", parse);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(ping);
      clearTimeout(openAnyway);
      // Claude Code hung up — Esc, or a quit — so there is nobody to answer.
      if (cancelled()) {
        log({ route: "openai", model, status: "cancelled", ms: Date.now() - started, request_id: requestId });
        return;
      }
      if (!translator.done) translator.fail({ type: "api_error", message: "ChatGPT: the answer stopped before it was complete" });
      log({
        route: "openai",
        model,
        effort,
        status: translator.error ? `${opened ? "stream-error" : "error"} ${translator.error.type}` : 200,
        ms: Date.now() - started,
        request_id: requestId,
        usage: translator.error || translator.message.stop_reason === "stop_sequence" ? undefined : translator.message.usage,
        usage_incomplete: translator.message.stop_reason === "stop_sequence" ? true : undefined,
      });
      if (!translator.error) {
        try {
          onAnswer();
        } catch {}
      }
      if (opened) {
        res.end();
        return;
      }
      if (translator.error) {
        const status = STATUS_FOR[translator.error.type] || 500;
        sendError(res, status, translator.error.type, translator.error.message, status >= 500);
      } else if (wantsStream) {
        open();
        res.end();
      } else {
        sendJson(res, 200, translator.message);
      }
    };
    // close covers a connection lost mid-stream as well as a normal end.
    upRes.on("end", finish);
    upRes.on("error", finish);
    upRes.on("close", finish);
  }

  // ── Dispatch ──

  async function handle(req, res) {
    const url = new URL(req.url, "http://router");
    const route = url.pathname.replace(/\/+$/, "");
    const isMessages = req.method === "POST" && (route === "/v1/messages" || route === "/v1/messages/count_tokens");

    if (mode === "gpt") {
      if (route === "/api/hello") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(req.method === "HEAD" ? undefined : "{}");
        return;
      }
      if (req.method === "GET" && route === "/v1/models") {
        const data = models.map((m) => ({ type: "model", id: m.id, display_name: m.name, created_at: "1970-01-01T00:00:00Z" }));
        sendJson(res, 200, { data, has_more: false, first_id: data.length ? data[0].id : null, last_id: data.length ? data[data.length - 1].id : null });
        return;
      }
      if (!isMessages) {
        sendError(res, 404, "not_found_error", `The ChatGPT account has no ${route} endpoint`);
        return;
      }
      if (!keyMatches(req)) {
        sendError(res, 401, "authentication_error", "This router only answers the Claude Code session ccc started it for");
        return;
      }
      const raw = await readBody(req);
      let json;
      try {
        json = JSON.parse(decodeBody(raw, req.headers["content-encoding"]));
      } catch (err) {
        sendError(res, 400, "invalid_request_error", `Could not read the request: ${err.message}`);
        return;
      }
      await gptMessages(req, res, json, route.endsWith("/count_tokens"));
      return;
    }

    // Mixed: only the model decides.
    if (!isMessages) {
      passthrough(req, res, null);
      return;
    }
    const raw = await readBody(req);
    let json = null;
    try {
      json = JSON.parse(decodeBody(raw, req.headers["content-encoding"]));
    } catch {}
    if (json && resolver.isGpt(json.model)) {
      if (!keyMatches(req)) {
        sendError(res, 401, "authentication_error", "This router only answers the Claude Code session ccc started it for");
        return;
      }
      await gptMessages(req, res, json, route.endsWith("/count_tokens"));
      return;
    }
    if (json && raw.includes(translate.REASONING_MARK) && withoutGptReasoning(json)) {
      delete req.headers["content-encoding"];
      passthrough(req, res, Buffer.from(JSON.stringify(json)));
      return;
    }
    passthrough(req, res, raw);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log({ route: "router", error: err.message });
      if (!res.headersSent) sendError(res, 500, "api_error", `ccc router: ${err.message}`, true);
      else res.end();
    });
  });
  server.keepAliveTimeout = 65000;

  return {
    server,
    resolver,
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve(server.address().port));
      });
    },
    close() {
      server.close();
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      agents.http.destroy();
      agents.https.destroy();
    },
  };
}

// ── What Claude Code is started with ─────────────────────────

// A GPT model's context window, as Claude Code's auto-compact window.
function windowFor(model) {
  const stated = Number(model && model.contextWindow) || FALLBACK_WINDOW;
  return Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, stated));
}

// The /model rows for the GPT models, and each one's context window. On the
// ChatGPT account the rows replace the built-in Claude lineup; on a Claude
// account they are added after it.
function pickerSettings(models, { mode, planLabel }) {
  return {
    modelPicker: {
      options: models.map((m) => ({ model: m.id, label: m.name, description: `${planLabel} plan`, behavesAs: BEHAVES_AS })),
      ...(mode === "gpt" ? { replaceBuiltInOptions: true } : {}),
    },
    modelSettings: Object.fromEntries(models.map((m) => [m.id, { autoCompactWindow: windowFor(m) }])),
  };
}

// Claude Code takes one --settings. When the user passed their own, theirs is
// kept and the GPT rows are added to it, in one file.
function withSettings(args, ours, file) {
  let theirs = null;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      rest.push(...args.slice(i));
      break;
    }
    if (arg === "--settings") {
      if (i + 1 === args.length) throw new Error("--settings needs a JSON object or file");
      theirs = args[++i];
      continue;
    }
    if (arg.startsWith("--settings=")) {
      theirs = arg.slice("--settings=".length);
      continue;
    }
    rest.push(arg);
  }
  let parsed = {};
  if (theirs !== null) {
    try {
      const literal = theirs.trim();
      const text = literal.startsWith("{") || literal.startsWith("[") ? literal : fs.readFileSync(theirs, "utf8");
      parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object");
    } catch {
      throw new Error("Could not read --settings: expected an inline JSON object or a readable JSON object file");
    }
  }
  const picker = parsed.modelPicker || {};
  const ids = new Set(ours.modelPicker.options.map((row) => row.model));
  const options = ours.modelPicker.replaceBuiltInOptions ? [] : (picker.options || []).filter((row) => !ids.has(row.model));
  const modelSettings = { ...parsed.modelSettings };
  for (const [id, defaults] of Object.entries(ours.modelSettings)) {
    const existing = modelSettings[id] || {};
    const window = existing.autoCompactWindow;
    modelSettings[id] = {
      ...existing,
      ...defaults,
      autoCompactWindow: typeof window === "number" && window >= MIN_WINDOW ? Math.min(window, defaults.autoCompactWindow) : defaults.autoCompactWindow,
    };
  }
  const settings = {
    ...parsed,
    modelPicker: { ...picker, ...ours.modelPicker, options: [...options, ...ours.modelPicker.options] },
    modelSettings,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  return ["--settings", file, ...rest];
}

// The environment Claude Code runs in.
function childEnv(mode, env, { port, key, resolver }) {
  const out = { ...env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, CCC_ROUTER: mode };
  if (mode === "gpt") {
    // No Claude login on this account: the router's own key stands in, and
    // every model name Claude Code reaches for is a GPT model.
    delete out.ANTHROPIC_API_KEY;
    delete out.CLAUDE_CODE_OAUTH_TOKEN;
    out.ANTHROPIC_AUTH_TOKEN = key;
    const main = resolver.info(resolver.main);
    const small = resolver.info(resolver.small);
    for (const family of ["OPUS", "SONNET", "FABLE"]) {
      out[`ANTHROPIC_DEFAULT_${family}_MODEL`] = main.id;
      out[`ANTHROPIC_DEFAULT_${family}_MODEL_NAME`] = main.name;
    }
    out.ANTHROPIC_DEFAULT_HAIKU_MODEL = small.id;
    out.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME = small.name;
    // Not CLAUDE_CODE_DISABLE_1M_CONTEXT: it would cap every model at 200K,
    // below the windows the rows' auto-compact settings give.
    delete out.CLAUDE_CODE_DISABLE_1M_CONTEXT;
  } else {
    // The account's own Claude login stays in charge; the key rides along as
    // one more header, which the router takes off again before Anthropic.
    const extra = `${ROUTER_KEY_HEADER}: ${key}`;
    out.ANTHROPIC_CUSTOM_HEADERS = env.ANTHROPIC_CUSTOM_HEADERS ? `${env.ANTHROPIC_CUSTOM_HEADERS}\n${extra}` : extra;
  }
  return out;
}

// Settings files left by a launch that did not get to clean up after itself.
function cleanStaleSessions(dir) {
  try {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (Date.now() - fs.statSync(file).mtimeMs > 24 * 3600 * 1000) fs.unlinkSync(file);
    }
  } catch {}
}

// ── Starting claude on Windows ───────────────────────────────
//
// npm installs claude as a .cmd shim, which only cmd.exe can run, while the
// native installer gives a plain .exe. The user's own arguments can hold any
// character, so a shim gets each one quoted for the C runtime and then every
// character cmd.exe treats specially escaped with ^ — twice, as the shim passes
// %* through cmd once more. That is cross-spawn's method, after
// https://qntm.org/cmd. An .exe needs none of it; Node quotes for it.

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function cmdEscape(arg) {
  const quoted = `"${String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  return quoted.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

// The file PATH and PATHEXT make of a bare command name, or null.
function whichOnWindows(command, env) {
  if (/[\\/]/.test(command)) return fs.existsSync(command) ? command : null;
  const exts = String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  for (const dir of String(env.PATH || env.Path || "").split(";").filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext.toLowerCase());
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function spawnClaude(command, args, options, platform = process.platform) {
  if (platform !== "win32") return spawn(command, args, options);
  const found = whichOnWindows(command, options.env || process.env);
  if (found && !/\.(cmd|bat)$/i.test(found)) return spawn(found, args, options);
  const line = [found ? `"${found}"` : command, ...args.map(cmdEscape)].join(" ");
  return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
    ...options,
    windowsVerbatimArguments: true,
  });
}

function runChild(command, args, env, cleanup) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnClaude(command, args, { stdio: "inherit", env });
    } catch (err) {
      cleanup();
      process.stderr.write(`  Could not start claude: ${err.message}\n`);
      resolve(1);
      return;
    }
    // Ctrl+C belongs to Claude Code, which shares this terminal.
    const ignore = () => {};
    process.on("SIGINT", ignore);
    const forwarded = ["SIGTERM", "SIGHUP"].map((signal) => {
      const handler = () => {
        try {
          child.kill(signal);
        } catch {}
      };
      process.on(signal, handler);
      return [signal, handler];
    });
    const done = (code) => {
      process.removeListener("SIGINT", ignore);
      for (const [signal, handler] of forwarded) process.removeListener(signal, handler);
      cleanup();
      resolve(code);
    };
    child.on("error", (err) => {
      process.stderr.write(`  ${err.code === "ENOENT" ? "claude was not found in PATH" : `Could not start claude: ${err.message}`}\n`);
      done(1);
    });
    child.on("exit", (code, signal) => done(code !== null ? code : 128 + ((signal && os.constants.signals[signal]) || 1)));
  });
}

// Start the router, then Claude Code through it, and wait for Claude Code.
async function launch({ mode, args = [], env = process.env, home, claude = "claude", warn = (l) => process.stderr.write(`  ${l}\n`) } = {}) {
  const p = chatgpt.paths(home);
  const signedIn = chatgpt.status({ home });

  if (mode === "gpt" && !signedIn.signedIn) {
    warn("ChatGPT is not signed in. Sign in with:  ccc gpt login");
    return 1;
  }
  if (mode === "gpt" && !signedIn.planUsage) {
    warn("ccc is not allowed to use your ChatGPT plan. Sign in again and allow it:  ccc gpt login");
    return 1;
  }
  if (mode === "mixed" && !signedIn.signedIn) {
    warn("ChatGPT is not signed in, so the GPT models will ask you to sign in first:  ccc gpt login");
  }

  const models = signedIn.signedIn ? await chatgpt.listModels({ home, timeoutMs: 6000 }) : [];
  if (mode === "gpt" && models.length === 0) {
    warn("OpenAI did not list any GPT models for this sign-in. Check your connection, or run:  ccc gpt models");
    return 1;
  }

  // The plan's usage figures, which the picker and statusline show, come from
  // Codex. Ask once now and again after answers, at most every couple of
  // minutes, without ever holding a request up.
  let asking = null;
  const refreshLimits = () => {
    if (asking || env.CCC_NO_USAGE) return;
    asking = chatgpt
      .planLimits({ home, env })
      .catch(() => {})
      .finally(() => (asking = null));
  };
  const key = crypto.randomBytes(24).toString("hex");
  cleanStaleSessions(p.sessions);
  const settingsFile = path.join(p.sessions, `${process.pid}-${key.slice(0, 8)}.json`);
  let finalArgs;
  try {
    finalArgs = withSettings(args, pickerSettings(models, { mode, planLabel: signedIn.planLabel }), settingsFile);
  } catch (err) {
    warn(err.message);
    return 1;
  }
  if (signedIn.signedIn) refreshLimits();
  const router = createRouter({
    mode,
    key,
    models,
    home,
    upstream: mode === "mixed" && env.ANTHROPIC_BASE_URL ? env.ANTHROPIC_BASE_URL : DEFAULT_UPSTREAM,
    log: makeLog(p.log),
    onAnswer: refreshLimits,
  });
  const port = await router.listen();
  const cleanup = () => {
    router.close();
    try {
      fs.unlinkSync(settingsFile);
    } catch {}
  };
  return runChild(claude, finalArgs, childEnv(mode, env, { port, key, resolver: router.resolver }), cleanup);
}

// ── CLI ──────────────────────────────────────────────────────
//
//   router.cjs launch --mode gpt|mixed [-- claude args...]

async function main(argv) {
  const [command, ...rest] = argv;
  if (command !== "launch") {
    process.stderr.write("usage: router.cjs launch --mode gpt|mixed [-- claude args...]\n");
    return 1;
  }
  const split = rest.indexOf("--");
  const own = split >= 0 ? rest.slice(0, split) : rest;
  const args = split >= 0 ? rest.slice(split + 1) : [];
  const modeAt = own.indexOf("--mode");
  const mode = modeAt >= 0 ? own[modeAt + 1] : null;
  if (mode !== "gpt" && mode !== "mixed") {
    process.stderr.write("usage: router.cjs launch --mode gpt|mixed [-- claude args...]\n");
    return 1;
  }
  return launch({ mode, args });
}

module.exports = {
  DEFAULT_UPSTREAM,
  BEHAVES_AS,
  ROUTER_KEY_HEADER,
  windowFor,
  PING_MS,
  decodeBody,
  sseParser,
  modelResolver,
  createRouter,
  pickerSettings,
  withSettings,
  childEnv,
  cmdEscape,
  whichOnWindows,
  spawnClaude,
  launch,
  main,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
