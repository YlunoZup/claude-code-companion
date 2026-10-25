// Tests for router.cjs: the local server between Claude Code and the model
// providers, and the launcher that starts Claude Code through it.
//
// Both providers are stand-ins on 127.0.0.1 that record what reaches them, so
// these pin what the router promises: a Claude request reaches Anthropic
// exactly as Claude Code sent it, a GPT request reaches OpenAI translated, and
// only the Claude Code session the router was started for can use it.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import router from "../src/router.cjs";
import translate from "../src/translate.cjs";
import { IS_WINDOWS, REPO_ROOT, makeSandbox } from "./helpers.test.mjs";

const KEY = "router-test-key";
const MODELS = [
  { id: "gpt-6.1-sol", name: "GPT-6.1-Sol", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-6-luna", name: "GPT-6-Luna", efforts: ["low", "medium", "high"] },
];

// A server that records each request and answers with handler(req, body, res).
function stub(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, body, res, requests.length);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function sse(res, events, { end = true } = {}) {
  res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "req_stub" });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  if (end) res.end();
}

const TEXT_ANSWER = [
  { type: "response.created", response: { id: "resp_1" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant", content: [] } },
  { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
  { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hi there" },
  { type: "response.content_part.done", output_index: 0, content_index: 0 },
  { type: "response.output_item.done", output_index: 0, item: { type: "message" } },
  { type: "response.completed", response: { output: [], usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 5 } } },
];

// One request to the router.
function call(port, { method = "POST", path = "/v1/messages?beta=true", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: { ...(data ? { "content-type": "application/json", "content-length": data.length } : {}), ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("error", reject);
    req.end(data);
  });
}

const events = (text) =>
  text
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => {
      const event = /^event: (.*)$/m.exec(frame);
      const data = /^data: (.*)$/m.exec(frame);
      return { event: event && event[1], data: data && JSON.parse(data[1]) };
    });

function messages(model, more = {}) {
  return { model, max_tokens: 1000, stream: true, system: "sys", messages: [{ role: "user", content: "hi" }], ...more };
}

async function withRouter(mode, fn, { anthropic, openai, getToken } = {}) {
  const r = router.createRouter({
    mode,
    key: KEY,
    models: MODELS,
    upstream: anthropic ? anthropic.url : "http://127.0.0.1:9",
    openaiBase: openai ? `${openai.url}/v1` : "http://127.0.0.1:9/v1",
    getToken: getToken || (async ({ force }) => (force ? "tok-2" : "tok-1")),
  });
  const port = await r.listen();
  try {
    await fn(port, r);
  } finally {
    r.close();
  }
}

describe("a Claude account with the GPT models (mixed)", () => {
  let anthropic;
  let openai;
  before(async () => {
    anthropic = await stub((req, body, res) => {
      if (req.url.startsWith("/v1/messages")) {
        res.writeHead(200, { "content-type": "text/event-stream", "anthropic-ratelimit-unified-5h-utilization": "0.25", "request-id": "req_claude" });
        res.write("event: message_start\ndata: {}\n\n");
        res.end("event: message_stop\ndata: {}\n\n");
        return;
      }
      res.writeHead(418, { "content-type": "application/json", "x-upstream": "yes" });
      res.end(JSON.stringify({ path: req.url }));
    });
    openai = await stub((req, body, res) => sse(res, TEXT_ANSWER));
  });
  after(async () => {
    await anthropic.close();
    await openai.close();
  });

  test("a Claude request reaches Anthropic byte for byte, with Claude Code's own login", async () => {
    await withRouter(
      "mixed",
      async (port) => {
        const raw = JSON.stringify(messages("claude-opus-5-5")) + "   ";
        const before = anthropic.requests.length;
        const res = await call(port, { body: raw, headers: { authorization: "Bearer claude-oauth-token", "anthropic-beta": "oauth-2025-04-20", "x-ccc-router-key": KEY } });
        assert.equal(res.status, 200);
        assert.equal(res.headers["anthropic-ratelimit-unified-5h-utilization"], "0.25", "the plan-limit headers the statusline reads must come through");
        assert.equal(res.text, "event: message_start\ndata: {}\n\nevent: message_stop\ndata: {}\n\n");
        const got = anthropic.requests[before];
        assert.equal(got.url, "/v1/messages?beta=true");
        assert.equal(got.body.toString(), raw, "the body must not be re-serialised");
        assert.equal(got.headers.authorization, "Bearer claude-oauth-token");
        assert.equal(got.headers["anthropic-beta"], "oauth-2025-04-20");
        assert.equal(got.headers["x-ccc-router-key"], undefined, "the router's key must not leave the machine");
        assert.equal(openai.requests.length, 0);
      },
      { anthropic, openai }
    );
  });

  test("everything else Claude Code asks for passes through too, query and status included", async () => {
    await withRouter(
      "mixed",
      async (port) => {
        const res = await call(port, { method: "GET", path: "/api/oauth/usage?x=1", headers: { authorization: "Bearer t" } });
        assert.equal(res.status, 418);
        assert.equal(res.headers["x-upstream"], "yes");
        assert.deepEqual(JSON.parse(res.text), { path: "/api/oauth/usage?x=1" });
      },
      { anthropic, openai }
    );
  });

  test("a GPT model goes to OpenAI, translated, and comes back as Claude Code's stream", async () => {
    await withRouter(
      "mixed",
      async (port) => {
        const res = await call(port, { body: messages("gpt-6.1-sol", { output_config: { effort: "high" } }), headers: { authorization: "Bearer claude-oauth-token", "x-ccc-router-key": KEY } });
        assert.equal(res.status, 200);
        assert.match(res.headers["content-type"], /text\/event-stream/);
        const ev = events(res.text).filter((e) => e.event !== "ping");
        assert.deepEqual(ev.map((e) => e.event), ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
        assert.equal(ev[2].data.delta.text, "Hi there");
        assert.deepEqual(ev[4].data.usage, { input_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 40, output_tokens: 5 });

        const sent = openai.requests[openai.requests.length - 1];
        assert.equal(sent.url, "/v1/responses");
        assert.equal(sent.headers.authorization, "Bearer tok-1", "OpenAI gets the ChatGPT sign-in, never the Claude login");
        const json = JSON.parse(sent.body);
        assert.equal(json.model, "gpt-6.1-sol");
        assert.equal(json.store, false);
        assert.equal(json.stream, true);
        assert.equal(json.reasoning.effort, "high");
      },
      { anthropic, openai }
    );
  });

  test("a GPT request without the session's key is refused, and nothing reaches OpenAI", async () => {
    await withRouter(
      "mixed",
      async (port) => {
        const before = openai.requests.length;
        const res = await call(port, { body: messages("gpt-6.1-sol"), headers: { authorization: "Bearer someone-else" } });
        assert.equal(res.status, 401);
        assert.equal(JSON.parse(res.text).error.type, "authentication_error");
        assert.equal(openai.requests.length, before);
      },
      { anthropic, openai }
    );
  });

  test("GPT reasoning in the history is taken out before a Claude model sees it", async () => {
    await withRouter(
      "mixed",
      async (port) => {
        const body = messages("claude-sonnet-5-5", {
          messages: [
            { role: "user", content: "q" },
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "gpt", signature: `${translate.REASONING_MARK}rs_1:ENC` },
                { type: "text", text: "answer" },
              ],
            },
            { role: "assistant", content: [{ type: "thinking", thinking: "only", signature: `${translate.REASONING_MARK}rs_2:ENC` }] },
            { role: "assistant", content: [{ type: "thinking", thinking: "claude", signature: "EqQBCkYIBRgCKkB" }, { type: "text", text: "kept" }] },
          ],
        });
        const before = anthropic.requests.length;
        await call(port, { body, headers: { "x-ccc-router-key": KEY } });
        const sent = JSON.parse(anthropic.requests[before].body);
        assert.deepEqual(sent.messages[1].content, [{ type: "text", text: "answer" }]);
        assert.deepEqual(sent.messages[2].content, [{ type: "text", text: "(reasoning by a GPT model)" }], "a turn may not end up empty");
        assert.equal(sent.messages[3].content[0].signature, "EqQBCkYIBRgCKkB", "Claude's own thinking stays");
      },
      { anthropic, openai }
    );
  });

  test("a compressed request body is read for routing and still passed on as sent", async () => {
    await withRouter(
      "mixed",
      async (port) => {
        const gz = zlib.gzipSync(Buffer.from(JSON.stringify(messages("claude-opus-5-5"))));
        const before = anthropic.requests.length;
        await call(port, { body: gz, headers: { "content-encoding": "gzip" } });
        assert.deepEqual(anthropic.requests[before].body, gz);
        assert.equal(anthropic.requests[before].headers["content-encoding"], "gzip");

        const res = await call(port, { body: zlib.gzipSync(Buffer.from(JSON.stringify(messages("gpt-6-luna")))), headers: { "content-encoding": "gzip", "x-ccc-router-key": KEY } });
        assert.equal(res.status, 200);
        assert.equal(JSON.parse(openai.requests[openai.requests.length - 1].body).model, "gpt-6-luna");
      },
      { anthropic, openai }
    );
  });

  test("an upstream with a path keeps it", async () => {
    const r = router.createRouter({ mode: "mixed", key: KEY, models: MODELS, upstream: `${anthropic.url}/gateway/anthropic` });
    const port = await r.listen();
    try {
      const before = anthropic.requests.length;
      await call(port, { method: "GET", path: "/v1/models?limit=5" });
      assert.equal(anthropic.requests[before].url, "/gateway/anthropic/v1/models?limit=5");
    } finally {
      r.close();
    }
  });

  test("count_tokens for a GPT model is answered here, as an estimate", async () => {
    await withRouter(
      "mixed",
      async (port) => {
        const before = openai.requests.length;
        const res = await call(port, { path: "/v1/messages/count_tokens?beta=true", body: messages("gpt-6.1-sol"), headers: { "x-ccc-router-key": KEY } });
        assert.equal(res.status, 200);
        assert.ok(JSON.parse(res.text).input_tokens > 0);
        assert.equal(openai.requests.length, before);
      },
      { anthropic, openai }
    );
  });
});

describe("the ChatGPT account (gpt)", () => {
  let openai;
  before(async () => {
    openai = await stub((req, body, res) => sse(res, TEXT_ANSWER));
  });
  after(() => openai.close());

  test("answers Claude Code's connectivity check and lists the GPT models", async () => {
    await withRouter(
      "gpt",
      async (port) => {
        assert.equal((await call(port, { method: "HEAD", path: "/api/hello" })).status, 200);
        const list = await call(port, { method: "GET", path: "/v1/models" });
        assert.deepEqual(JSON.parse(list.text).data.map((m) => [m.id, m.display_name]), [
          ["gpt-6.1-sol", "GPT-6.1-Sol"],
          ["gpt-6-luna", "GPT-6-Luna"],
        ]);
        assert.equal((await call(port, { method: "GET", path: "/v1/files" })).status, 404);
      },
      { openai }
    );
  });

  test("the key arrives as Claude Code's auth token; anything else is refused", async () => {
    await withRouter(
      "gpt",
      async (port) => {
        assert.equal((await call(port, { body: messages("gpt-6.1-sol"), headers: { authorization: "Bearer wrong" } })).status, 401);
        assert.equal((await call(port, { body: messages("gpt-6.1-sol") })).status, 401);
        assert.equal((await call(port, { body: messages("gpt-6.1-sol"), headers: { authorization: `Bearer ${KEY}` } })).status, 200);
        assert.equal((await call(port, { body: messages("gpt-6.1-sol"), headers: { "x-api-key": KEY } })).status, 200);
      },
      { openai }
    );
  });

  test("Claude model names map onto the GPT models: haiku to the small one, the rest to the main", async () => {
    await withRouter(
      "gpt",
      async (port) => {
        const sentModel = async (model) => {
          await call(port, { body: messages(model), headers: { authorization: `Bearer ${KEY}` } });
          return JSON.parse(openai.requests[openai.requests.length - 1].body).model;
        };
        assert.equal(await sentModel("claude-haiku-5-5"), "gpt-6-luna");
        assert.equal(await sentModel("claude-opus-5-5"), "gpt-6.1-sol");
        assert.equal(await sentModel("claude-sonnet-4-6[1m]"), "gpt-6.1-sol");
        assert.equal(await sentModel("gpt-6-luna[1m]"), "gpt-6-luna", "a [1m] suffix is Claude Code's, not OpenAI's");
      },
      { openai }
    );
  });

  // Claude Code leaves "stream" out of its own small requests, and Anthropic
  // does not stream unless asked.
  test("a request that does not ask for streaming gets JSON, stopped at its stop sequence", async () => {
    const openai = await stub((req, body, res) =>
      sse(res, [
        { type: "response.created", response: {} },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "<block>no</block> because" },
        { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 2 } } },
      ])
    );
    try {
      await withRouter(
        "gpt",
        async (port) => {
          const body = messages("gpt-6.1-sol", { stop_sequences: ["</block>"], thinking: { type: "disabled" } });
          delete body.stream;
          const res = await call(port, { body, headers: { authorization: `Bearer ${KEY}` } });
          assert.equal(res.status, 200);
          assert.match(res.headers["content-type"], /application\/json/);
          const message = JSON.parse(res.text);
          assert.deepEqual(message.content, [{ type: "text", text: "<block>no" }]);
          assert.equal(message.stop_reason, "stop_sequence");
          assert.equal(message.stop_sequence, "</block>");
        },
        { openai }
      );
    } finally {
      await openai.close();
    }
  });

  test("disconnecting during token refresh cannot start a paid model request afterward", async () => {
    let started;
    let release;
    const waiting = new Promise((r) => { started = r; });
    const token = new Promise((r) => { release = r; });
    await withRouter("gpt", async (port) => {
      const before = openai.requests.length;
      const body = JSON.stringify(messages("gpt-6.1-sol"));
      const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/v1/messages", headers: { authorization: `Bearer ${KEY}`, "content-length": Buffer.byteLength(body) } });
      req.on("error", () => {});
      req.end(body);
      await waiting;
      await new Promise((resolve) => { req.once("close", resolve); req.destroy(); });
      await new Promise((r) => setTimeout(r, 20));
      release("refreshed-token");
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(openai.requests.length, before);
    }, { openai, getToken: () => { started(); return token; } });
  });

  test("a request that asks for no streaming gets the whole message as JSON", async () => {
    await withRouter(
      "gpt",
      async (port) => {
        const res = await call(port, { body: messages("gpt-6.1-sol", { stream: false }), headers: { authorization: `Bearer ${KEY}` } });
        assert.equal(res.status, 200);
        const message = JSON.parse(res.text);
        assert.equal(message.type, "message");
        assert.deepEqual(message.content, [{ type: "text", text: "Hi there" }]);
        assert.equal(message.stop_reason, "end_turn");
        assert.equal(JSON.parse(openai.requests[openai.requests.length - 1].body).stream, true, "OpenAI is always asked to stream");
      },
      { openai }
    );
  });
});

describe("when OpenAI says no", () => {
  test("a rejected token is refreshed once, and the request retried with the new one", async () => {
    const openai = await stub((req, body, res, n) => {
      if (n === 1) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "invalid_api_key", message: "expired" } }));
        return;
      }
      sse(res, TEXT_ANSWER);
    });
    try {
      await withRouter(
        "gpt",
        async (port) => {
          const res = await call(port, { body: messages("gpt-6.1-sol"), headers: { authorization: `Bearer ${KEY}` } });
          assert.equal(res.status, 200);
          assert.deepEqual(openai.requests.map((r) => r.headers.authorization), ["Bearer tok-1", "Bearer tok-2"]);
        },
        { openai }
      );
    } finally {
      await openai.close();
    }
  });

  test("the plan's usage limit comes back as a 429 Claude Code will not retry, saying where to manage it", async () => {
    const openai = await stub((req, body, res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } }));
    });
    try {
      await withRouter(
        "gpt",
        async (port) => {
          const res = await call(port, { body: messages("gpt-6.1-sol"), headers: { authorization: `Bearer ${KEY}` } });
          assert.equal(res.status, 429);
          assert.equal(res.headers["x-should-retry"], "false");
          const err = JSON.parse(res.text);
          assert.equal(err.type, "error");
          assert.equal(err.error.type, "rate_limit_error");
          assert.match(err.error.message, /chatgpt\.com\/settings\/usage/);
        },
        { openai }
      );
    } finally {
      await openai.close();
    }
  });

  test("a field the endpoint refuses is left out, then and for the rest of the session", async () => {
    const openai = await stub((req, body, res) => {
      if (JSON.parse(body).prompt_cache_key) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "subscription_sharing_unsupported_capability", message: "no", param: "prompt_cache_key" } }));
        return;
      }
      sse(res, TEXT_ANSWER);
    });
    try {
      await withRouter(
        "gpt",
        async (port) => {
          const body = messages("gpt-6.1-sol", { metadata: { user_id: JSON.stringify({ session_id: "s" }) } });
          assert.equal((await call(port, { body, headers: { authorization: `Bearer ${KEY}` } })).status, 200);
          assert.equal((await call(port, { body, headers: { authorization: `Bearer ${KEY}` } })).status, 200);
          assert.deepEqual(
            openai.requests.map((r) => "prompt_cache_key" in JSON.parse(r.body)),
            [true, false, false],
            "refused once, then never sent again"
          );
        },
        { openai }
      );
    } finally {
      await openai.close();
    }
  });

  test("not being signed in says how to sign in, and nothing reaches OpenAI", async () => {
    const openai = await stub((req, body, res) => sse(res, TEXT_ANSWER));
    try {
      const signedOut = async () => {
        const err = new Error("ChatGPT is not signed in. Run: ccc gpt login");
        err.code = "signed_out";
        throw err;
      };
      await withRouter(
        "gpt",
        async (port) => {
          const res = await call(port, { body: messages("gpt-6.1-sol"), headers: { authorization: `Bearer ${KEY}` } });
          assert.equal(res.status, 403);
          assert.match(JSON.parse(res.text).error.message, /ccc gpt login/);
          assert.equal(openai.requests.length, 0);
        },
        { openai, getToken: signedOut }
      );
    } finally {
      await openai.close();
    }
  });

  test("a stream that stops before it is complete ends with an error event", async () => {
    const openai = await stub((req, body, res) => sse(res, TEXT_ANSWER.slice(0, 4)));
    try {
      await withRouter(
        "gpt",
        async (port) => {
          const res = await call(port, { body: messages("gpt-6.1-sol"), headers: { authorization: `Bearer ${KEY}` } });
          const ev = events(res.text);
          assert.equal(ev[ev.length - 1].event, "error");
          assert.match(ev[ev.length - 1].data.error.message, /stopped before it was complete/);
        },
        { openai }
      );
    } finally {
      await openai.close();
    }
  });

  // OpenAI opens the stream before it checks the input's length; the router
  // holds the reply back until the answer starts, so Claude Code still gets the
  // HTTP 400 that makes it compact the conversation and try again.
  test("a context overflow reported inside the stream comes back as an HTTP 400 'prompt is too long'", async () => {
    const overflow = { type: "invalid_request_error", code: "context_length_exceeded", message: "Your input exceeds the context window of this model.", param: "input" };
    const openai = await stub((req, body, res) =>
      sse(res, [
        { type: "response.created", response: {} },
        { type: "response.in_progress", response: {} },
        { type: "response.metadata", metadata: {} },
        { type: "error", error: overflow },
        { type: "response.failed", response: { error: overflow, usage: null } },
      ])
    );
    try {
      await withRouter(
        "gpt",
        async (port) => {
          const res = await call(port, { body: messages("gpt-6.1-sol"), headers: { authorization: `Bearer ${KEY}` } });
          assert.equal(res.status, 400);
          assert.equal(res.headers["x-should-retry"], "false");
          const err = JSON.parse(res.text);
          assert.equal(err.error.type, "invalid_request_error");
          assert.match(err.error.message, /^prompt is too long: Your input exceeds the context window/);
        },
        { openai }
      );
    } finally {
      await openai.close();
    }
  });

  test("a usage limit reported inside the stream comes back as a 429 that is not retried", async () => {
    const limit = { code: "subscription_sharing_usage_limit_exceeded", message: "limit" };
    const openai = await stub((req, body, res) => sse(res, [{ type: "response.created", response: {} }, { type: "response.failed", response: { error: limit } }]));
    try {
      await withRouter(
        "gpt",
        async (port) => {
          const res = await call(port, { body: messages("gpt-6.1-sol"), headers: { authorization: `Bearer ${KEY}` } });
          assert.equal(res.status, 429);
          assert.equal(res.headers["x-should-retry"], "false");
          assert.match(JSON.parse(res.text).error.message, /chatgpt\.com\/settings\/usage/);
        },
        { openai }
      );
    } finally {
      await openai.close();
    }
  });

  // Auto mode's safety check runs on Anthropic's servers; turned down as an
  // unsupported beta, Claude Code vets each tool call itself instead.
  test("auto mode's server-side check is turned down as an unsupported beta, naming it", async () => {
    const openai = await stub((req, body, res) => sse(res, TEXT_ANSWER));
    try {
      await withRouter(
        "gpt",
        async (port) => {
          const res = await call(port, {
            body: messages("gpt-6.1-sol", { safeguards: [{ type: "dangerous_tool_use" }] }),
            headers: { authorization: `Bearer ${KEY}`, "anthropic-beta": "claude-code-20250219,dangerous-tool-use-2026-09-03" },
          });
          assert.equal(res.status, 400);
          const err = JSON.parse(res.text).error;
          assert.equal(err.type, "invalid_request_error");
          assert.match(err.message, /dangerous-tool-use-2026-09-03/);
          assert.match(err.message, /dangerous_tool_use/);
          assert.match(err.message, /safeguard/);
          assert.equal(openai.requests.length, 0, "nothing reaches OpenAI");
        },
        { openai }
      );
    } finally {
      await openai.close();
    }
  });

  test("OpenAI out of reach is a 502 Claude Code may retry", async () => {
    await withRouter("gpt", async (port) => {
      const res = await call(port, { body: messages("gpt-6.1-sol"), headers: { authorization: `Bearer ${KEY}` } });
      assert.equal(res.status, 502);
      assert.equal(res.headers["x-should-retry"], "true");
    });
  });
});

describe("what Claude Code is started with", () => {
  test("the GPT models become /model rows that behave as a Claude model Claude Code knows", () => {
    const settings = router.pickerSettings(MODELS, { mode: "mixed", planLabel: "ChatGPT" });
    assert.deepEqual(settings.modelPicker.options[0], { model: "gpt-6.1-sol", label: "GPT-6.1-Sol", description: "ChatGPT plan", behavesAs: "claude-sonnet-5" });
    assert.equal("replaceBuiltInOptions" in settings.modelPicker, false, "a Claude account keeps its own models");
    assert.equal(router.pickerSettings(MODELS, { mode: "gpt", planLabel: "ChatGPT" }).modelPicker.replaceBuiltInOptions, true);
  });

  // The rows behave as a 1M model; each GPT model's own window, the one Codex
  // uses, is what Claude Code compacts by.
  test("each GPT model gets its own context window", () => {
    const models = [
      { id: "gpt-6.1-sol", name: "GPT-6.1-Sol", contextWindow: 500000 },
      { id: "gpt-6-luna", name: "GPT-6-Luna", contextWindow: 272000 },
      { id: "gpt-new", name: "New" },
      { id: "gpt-tiny", name: "Tiny", contextWindow: 8000 },
      { id: "gpt-huge", name: "Huge", contextWindow: 2000000 },
    ];
    assert.deepEqual(router.pickerSettings(models, { mode: "gpt", planLabel: "ChatGPT" }).modelSettings, {
      "gpt-6.1-sol": { autoCompactWindow: 500000 },
      "gpt-6-luna": { autoCompactWindow: 272000 },
      "gpt-new": { autoCompactWindow: 272000 },
      "gpt-tiny": { autoCompactWindow: 100000 },
      "gpt-huge": { autoCompactWindow: 1000000 },
    }, "an unstated window gets the usual one; Claude Code takes 100K to 1M");
  });

  test("--settings is added, and the user's own --settings is merged into it", () => {
    const sb = makeSandbox();
    try {
      const ours = router.pickerSettings(MODELS, { mode: "mixed", planLabel: "ChatGPT" });
      const file = join(sb.root, "s.json");
      assert.deepEqual(router.withSettings(["-c", "hello"], ours, file), ["--settings", file, "-c", "hello"]);
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), ours);

      const args = router.withSettings(
        ["--settings", '{"theme":"light","modelPicker":{"options":[{"model":"opus","label":"Mine"}]},"modelSettings":{"opus":{"effortLevel":"low"}}}', "-c"],
        ours,
        file
      );
      assert.deepEqual(args, ["--settings", file, "-c"]);
      const merged = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(merged.theme, "light");
      assert.deepEqual(merged.modelPicker.options.map((o) => o.model), ["opus", "gpt-6.1-sol", "gpt-6-luna"]);
      assert.deepEqual(Object.keys(merged.modelSettings), ["opus", "gpt-6.1-sol", "gpt-6-luna"]);

      const theirs = join(sb.root, "theirs.json");
      writeFileSync(theirs, JSON.stringify({ verbose: true }));
      router.withSettings([`--settings=${theirs}`], ours, file);
      assert.equal(JSON.parse(readFileSync(file, "utf8")).verbose, true);
    } finally {
      sb.cleanup();
    }
  });

  test("keeps GPT effort settings, caps windows, and does not duplicate picker rows", () => {
    const sb = makeSandbox();
    try {
      const ours = router.pickerSettings([{ ...MODELS[0], contextWindow: 500000 }], { mode: "mixed", planLabel: "ChatGPT" });
      const file = join(sb.root, "merged.json");
      const theirs = { modelPicker: { options: [{ model: "gpt-6.1-sol", label: "old" }] }, modelSettings: { "gpt-6.1-sol": { effortLevel: "xhigh", maxEffortLevel: "high", autoCompactWindow: 900000 } } };
      router.withSettings(["--settings", JSON.stringify(theirs)], ours, file);
      let s = JSON.parse(readFileSync(file, "utf8"));
      assert.deepEqual(s.modelSettings["gpt-6.1-sol"], { effortLevel: "xhigh", maxEffortLevel: "high", autoCompactWindow: 500000 });
      assert.equal(s.modelPicker.options.length, 1);
      theirs.modelSettings["gpt-6.1-sol"].autoCompactWindow = 150000;
      router.withSettings(["--settings", JSON.stringify(theirs)], ours, file);
      s = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(s.modelSettings["gpt-6.1-sol"].autoCompactWindow, 150000);
    } finally { sb.cleanup(); }
  });

  test("GPT-only rows still replace Claude rows when user settings supply their own picker", () => {
    const sb = makeSandbox();
    try {
      const ours = router.pickerSettings(MODELS, { mode: "gpt", planLabel: "ChatGPT" });
      const file = join(sb.root, "merged.json");
      router.withSettings(["--settings", '{"modelPicker":{"options":[{"model":"opus"}],"replaceBuiltInOptions":false}}'], ours, file);
      const s = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(s.modelPicker.replaceBuiltInOptions, true);
      assert.deepEqual(s.modelPicker.options.map((r) => r.model), MODELS.map((r) => r.id));
    } finally { sb.cleanup(); }
  });

  test("invalid settings fail closed rather than dropping permission rules", () => {
    const sb = makeSandbox();
    try {
      const ours = router.pickerSettings(MODELS, { mode: "mixed", planLabel: "ChatGPT" });
      const file = join(sb.root, "merged.json");
      for (const value of ['{"permissions":', '[]', join(sb.root, "missing.json")]) assert.throws(() => router.withSettings(["--settings", value], ours, file), /Could not read --settings/);
      assert.throws(() => router.withSettings(["--settings"], ours, file), /needs a JSON object or file/);
      assert.equal(existsSync(file), false);
      assert.throws(() => router.withSettings(["--settings", '{"env":{"TOKEN":"PRIVATE-SETTINGS-VALUE"},broken}'], ours, file), (err) => !err.message.includes("PRIVATE-SETTINGS-VALUE") && /Could not read --settings/.test(err.message));
      assert.deepEqual(router.withSettings(["--", "--settings", "literal prompt"], ours, file).slice(2), ["--", "--settings", "literal prompt"]);
    } finally { sb.cleanup(); }
  });

  test("the ChatGPT account replaces the Claude login with the router's key and points every model at GPT", () => {
    const resolver = router.modelResolver(MODELS, "gpt");
    const env = router.childEnv("gpt", { PATH: "p", ANTHROPIC_API_KEY: "sk-ant", CLAUDE_CODE_OAUTH_TOKEN: "oat", CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" }, { port: 1234, key: KEY, resolver });
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:1234");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, KEY);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "gpt-6.1-sol");
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME, "GPT-6.1-Sol");
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "gpt-6-luna");
    assert.equal(env.CLAUDE_CODE_DISABLE_1M_CONTEXT, undefined, "it would cap every model at 200K");
    assert.equal(env.PATH, "p");
  });

  test("a Claude account keeps its login; the key rides along as one more header", () => {
    const resolver = router.modelResolver(MODELS, "mixed");
    const env = router.childEnv("mixed", { ANTHROPIC_CUSTOM_HEADERS: "X-Mine: 1" }, { port: 1234, key: KEY, resolver });
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:1234");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, `X-Mine: 1\nx-ccc-router-key: ${KEY}`);
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined, "the Claude models stay Claude's");
  });
});

describe("arguments on Windows", () => {
  // cmd.exe reads the line twice for an npm .cmd shim, so every special
  // character is escaped twice, inside C-runtime quoting.
  test("plain words are quoted and their quotes escaped", () => {
    assert.equal(router.cmdEscape("hello"), '^^^"hello^^^"');
  });

  test("characters cmd.exe acts on cannot break out", () => {
    for (const arg of ["a&b", "x|y", "50%", "(a)", "<in>", "a^b", "!x!", 'say "hi"', "tail\\"]) {
      const escaped = router.cmdEscape(arg);
      // Every metacharacter is preceded by a caret.
      assert.doesNotMatch(escaped.replace(/\^./g, ""), /[&|%()<>!"^]/, `${arg} -> ${escaped}`);
    }
  });
});

describe("router.cjs launch", () => {
  let sb;
  before(() => {
    sb = makeSandbox();
    // A claude that records what it was started with, checks the router is
    // up while it runs, and exits with a chosen code.
    const stubScript = join(sb.stubs, "claude-router-stub.mjs");
    writeFileSync(
      stubScript,
      `import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const at = args.indexOf("--settings");
const env = {};
for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_DEFAULT_OPUS_MODEL", "CLAUDE_CODE_DISABLE_1M_CONTEXT", "CCC_ROUTER", "CLAUDE_CONFIG_DIR"]) env[k] = process.env[k];
let hello = null;
try { hello = (await fetch(process.env.ANTHROPIC_BASE_URL + "/api/hello", { method: "HEAD" })).status; } catch (e) { hello = String(e); }
writeFileSync(process.env.CCC_TEST_OUT, JSON.stringify({ args, env, settings: at >= 0 ? JSON.parse(readFileSync(args[at + 1], "utf8")) : null, hello }));
process.exit(Number(process.env.CCC_TEST_EXIT || 0));
`
    );
    writeFileSync(join(sb.stubs, "claude"), `#!/bin/sh\nexec node "${stubScript.replace(/\\/g, "/")}" "$@"\n`);
    chmodSync(join(sb.stubs, "claude"), 0o755);
    if (IS_WINDOWS) writeFileSync(join(sb.stubs, "claude.cmd"), `@echo off\r\nnode "${stubScript}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
  });
  after(() => sb.cleanup());

  const chatgptDir = () => join(sb.home, ".claude-profiles", "chatgpt");
  function signIn() {
    sb.writeJson(join(chatgptDir(), "auth.json"), {
      client_id: "oaiapp_test",
      account: { email: "me@example.com" },
      access_token: "access",
      refresh_token: "refresh",
      scope: "openid chatgpt.tokens.use.direct",
      plan_usage: true,
      expires_at: Date.now() + 3600000,
    });
    sb.writeJson(join(chatgptDir(), "models.json"), { fetchedAt: Date.now(), models: MODELS });
  }
  function launch(mode, args, extraEnv = {}) {
    const out = join(sb.root, `launch-${mode}.json`);
    const r = sb.node("src/router.cjs", ["launch", "--mode", mode, "--", ...args], { CCC_TEST_OUT: out, ...extraEnv });
    return { r, out: existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null, file: out };
  }

  test("the ChatGPT account will not start signed out", () => {
    const { r, out } = launch("gpt", ["hello"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ccc gpt login/);
    assert.equal(out, null, "claude must not start");
  });

  test("the ChatGPT account starts Claude Code through a running router, on GPT only", () => {
    signIn();
    const { r, out } = launch("gpt", ["-c", "say hi"], { CCC_TEST_EXIT: "7" });
    assert.equal(r.status, 7, `the exit code must come through: ${r.stderr}`);
    assert.equal(out.hello, 200, "the router must answer while Claude Code runs");
    assert.equal(out.args[0], "--settings");
    assert.deepEqual(out.args.slice(2), ["-c", "say hi"]);
    assert.equal(out.settings.modelPicker.replaceBuiltInOptions, true);
    assert.deepEqual(out.settings.modelPicker.options.map((o) => o.model), ["gpt-6.1-sol", "gpt-6-luna"]);
    assert.match(out.env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(out.env.ANTHROPIC_AUTH_TOKEN && out.env.ANTHROPIC_AUTH_TOKEN.length >= 32);
    assert.equal(out.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "gpt-6.1-sol");
    assert.equal(out.env.CLAUDE_CODE_DISABLE_1M_CONTEXT, undefined);
    assert.deepEqual(out.settings.modelSettings["gpt-6.1-sol"], { autoCompactWindow: 272000 });
    assert.equal(out.env.CCC_ROUTER, "gpt");
    assert.equal(existsSync(out.args[1]), false, "the session's settings file is cleaned up");
  });

  test("a Claude account starts with the GPT rows added and its login untouched", () => {
    signIn();
    const { r, out } = launch("mixed", ["--model", "opus"], { ANTHROPIC_CUSTOM_HEADERS: "" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(out.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.match(out.env.ANTHROPIC_CUSTOM_HEADERS, /^x-ccc-router-key: [0-9a-f]{48}$/);
    assert.equal("replaceBuiltInOptions" in out.settings.modelPicker, false);
    assert.deepEqual(out.args.slice(2), ["--model", "opus"]);
  });

  test("an unknown mode is a usage error", () => {
    const r = sb.node("src/router.cjs", ["launch", "--mode", "nope"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /usage/);
  });
});

test("the router source never writes to the terminal while Claude Code runs", () => {
  // Claude Code owns the terminal. A console.log from the server would land
  // in the middle of its screen.
  const source = readFileSync(join(REPO_ROOT, "src", "router.cjs"), "utf8");
  const server = source.slice(source.indexOf("function createRouter"), source.indexOf("// ── What Claude Code is started with"));
  assert.doesNotMatch(server, /console\.|process\.std(out|err)\.write/);
});
