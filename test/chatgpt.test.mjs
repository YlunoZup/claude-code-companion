// Tests for chatgpt.cjs: signing in with ChatGPT, keeping the sign-in fresh,
// and listing the GPT models.
//
// OpenAI is a stand-in on 127.0.0.1 that plays the documented flow — discovery,
// a dynamically registered client, PKCE, an RS256-signed ID token, rotating
// refresh tokens, revocation — and records what it was sent. Nothing here
// reaches OpenAI, and nothing touches the real ~/.claude-profiles.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { IS_WINDOWS, REPO_ROOT, makeSandbox } from "./helpers.test.mjs";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const stranger = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };

function signJwt(payload, key = privateKey) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const data = `${enc({ alg: "RS256", typ: "JWT", kid: "test-key" })}.${enc(payload)}`;
  return `${data}.${crypto.sign("RSA-SHA256", Buffer.from(data), key).toString("base64url")}`;
}

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ── The stand-in ─────────────────────────────────────────────

const openai = {
  base: null,
  log: [],
  pending: new Map(),
  issued: 0,
  // Per-test behaviour.
  reset() {
    this.log.length = 0;
    this.issued = 0;
    this.authorizeError = null;
    this.idToken = null; // (claims) => token, to tamper with
    this.scope = "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke";
    this.refresh = null; // { status, json } to answer refreshes with
    this.refreshDelayMs = 0;
    this.modelsStatus = 200;
  },
  count(kind) {
    return this.log.filter((e) => e.kind === kind).length;
  },
};

function readForm(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(raw))));
  });
}

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, openai.base);
  const base = openai.base;
  if (url.pathname === "/.well-known/openid-configuration") {
    return json(res, 200, {
      issuer: base,
      authorization_endpoint: `${base}/api/accounts/authorize`,
      token_endpoint: `${base}/api/accounts/oauth/token`,
      revocation_endpoint: `${base}/api/accounts/oauth/revoke`,
      jwks_uri: `${base}/.well-known/jwks.json`,
    });
  }
  if (url.pathname === "/.well-known/jwks.json") return json(res, 200, { keys: [JWK] });

  if (url.pathname === "/api/accounts/authorize") {
    const q = Object.fromEntries(url.searchParams);
    openai.log.push({ kind: "authorize", query: q });
    const back = new URL(q.redirect_uri);
    back.searchParams.set("state", q.state);
    if (openai.authorizeError) back.searchParams.set("error", openai.authorizeError);
    else {
      const code = `code-${crypto.randomBytes(6).toString("hex")}`;
      const clientId = q.client_id === "dynamic_agent_client" ? "oaiapp_test" : q.client_id;
      openai.pending.set(code, { ...q, clientId });
      back.searchParams.set("code", code);
      if (q.client_id === "dynamic_agent_client") back.searchParams.set("client_id", clientId);
    }
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }

  if (url.pathname === "/api/accounts/oauth/token" && req.method === "POST") {
    const form = await readForm(req);
    openai.log.push({ kind: form.grant_type, form });
    if (form.grant_type === "authorization_code") {
      const p = openai.pending.get(form.code);
      if (!p) return json(res, 400, { error: "invalid_grant" });
      const challenge = b64url(crypto.createHash("sha256").update(form.code_verifier).digest());
      if (challenge !== p.code_challenge || form.redirect_uri !== p.redirect_uri || form.client_id !== p.clientId || form.resource !== "https://api.openai.com/v1") {
        return json(res, 400, { error: "invalid_request" });
      }
      openai.pending.delete(form.code);
      const claims = { iss: base, aud: [p.clientId], sub: "user-1", email: "me@example.com", name: "Me", nonce: p.nonce, exp: Math.floor(Date.now() / 1000) + 3600 };
      const n = ++openai.issued;
      return json(res, 200, {
        access_token: `access-${n}`,
        refresh_token: `refresh-${n}`,
        id_token: openai.idToken ? openai.idToken(claims) : signJwt(claims),
        token_type: "bearer",
        expires_in: 3600,
        scope: openai.scope,
      });
    }
    if (form.grant_type === "refresh_token") {
      if (openai.refreshDelayMs) await new Promise((r) => setTimeout(r, openai.refreshDelayMs));
      if (openai.refresh) return json(res, openai.refresh.status, openai.refresh.json);
      const n = ++openai.issued;
      return json(res, 200, { access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 3600, scope: openai.scope });
    }
    return json(res, 400, { error: "unsupported_grant_type" });
  }

  if (url.pathname === "/api/accounts/oauth/revoke" && req.method === "POST") {
    openai.log.push({ kind: "revoke", form: await readForm(req) });
    res.writeHead(200);
    return res.end();
  }

  if (url.pathname === "/v1/models") {
    openai.log.push({ kind: "models", auth: req.headers.authorization });
    if (openai.modelsStatus !== 200) return json(res, openai.modelsStatus, { error: { message: "down" } });
    return json(res, 200, {
      models: [
        { slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], default_reasoning_level: "low", context_window: 500000 },
        { slug: "gpt-reserve", display_name: "GPT-Reserve", visibility: "hide" },
        { slug: "gpt-6-luna", display_name: "GPT-6-Luna", visibility: "list", supported_reasoning_levels: [{ effort: "low" }] },
      ],
    });
  }
  res.writeHead(404);
  res.end();
});

let chatgpt;
before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  openai.base = `http://127.0.0.1:${server.address().port}`;
  // chatgpt.cjs reads where OpenAI is when it loads.
  process.env.CCC_CHATGPT_AUTH_URL = openai.base;
  process.env.CCC_OPENAI_API_URL = `${openai.base}/v1`;
  chatgpt = (await import("../src/chatgpt.cjs")).default;
});
after(() => new Promise((r) => server.close(r)));

// ── Driving a sign-in ────────────────────────────────────────

// Run login() and play the browser: open the link it prints, follow the
// redirect back to its loopback server.
async function signIn(home, opts = {}) {
  const lines = [];
  // Caught at once: a refused sign-in rejects while the browser part is still
  // being played.
  const pending = chatgpt.login({ home, browser: false, say: (l) => lines.push(l), ...opts }).catch((e) => e);
  let link;
  for (let i = 0; i < 200 && !link; i++) {
    link = lines.map((l) => l.trim()).find((l) => l.includes("/api/accounts/authorize?"));
    if (!link) await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(link, "login never printed the sign-in link");
  const redirect = await new Promise((resolve, reject) => {
    http.get(link, (res) => {
      res.resume();
      resolve(res.headers.location);
    }).on("error", reject);
  });
  const page = await new Promise((resolve, reject) => {
    http.get(redirect, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
  return { result: await pending, page, link, lines };
}

const fresh = () => {
  openai.reset();
  return makeSandbox();
};

describe("signing in", () => {
  test("registers this machine, checks the ID token and saves the sign-in for the user alone", async () => {
    const sb = fresh();
    try {
      const { result, page, link } = await signIn(sb.home);
      assert.equal(result instanceof Error, false, String(result && result.message));
      assert.equal(page.status, 200);
      assert.match(page.body, /You can close this tab/);
      assert.equal(result.email, "me@example.com");
      assert.equal(result.planUsage, true);
      assert.equal(result.firstTime, true);

      const q = openai.log.find((e) => e.kind === "authorize").query;
      assert.equal(q.client_id, "dynamic_agent_client");
      assert.equal(q.agent_name_hint, "claude-multi-account");
      assert.match(q.ext_agent_host_id, /^urn:uuid:[0-9a-f-]{36}$/);
      assert.equal(q.response_type, "code");
      assert.equal(q.scope, "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct");
      assert.equal(q.resource, "https://api.openai.com/v1");
      assert.equal(q.code_challenge_method, "S256");
      assert.match(q.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
      assert.ok(link.startsWith(`${openai.base}/api/accounts/authorize?`));

      const p = chatgpt.paths(sb.home);
      const auth = JSON.parse(readFileSync(p.auth, "utf8"));
      assert.equal(auth.client_id, "oaiapp_test");
      assert.equal(auth.refresh_token, "refresh-1");
      assert.equal(auth.plan_usage, true);
      assert.equal(JSON.parse(readFileSync(p.host, "utf8")).client_id, "oaiapp_test");
      if (!IS_WINDOWS) {
        assert.equal(statSync(p.auth).mode & 0o777, 0o600, "auth.json must be readable by the user alone");
        assert.equal(statSync(p.dir).mode & 0o777, 0o700);
      }
    } finally {
      sb.cleanup();
    }
  });

  test("signing in again reuses the registration", async () => {
    const sb = fresh();
    try {
      await signIn(sb.home);
      openai.log.length = 0;
      const { result } = await signIn(sb.home);
      assert.equal(result.firstTime, false);
      const q = openai.log.find((e) => e.kind === "authorize").query;
      assert.equal(q.client_id, "oaiapp_test");
      assert.equal(q.agent_name_hint, undefined);
      assert.equal(q.login_hint, "me@example.com");
    } finally {
      sb.cleanup();
    }
  });

  test("--new registers afresh", async () => {
    const sb = fresh();
    try {
      await signIn(sb.home);
      openai.log.length = 0;
      await signIn(sb.home, { fresh: true });
      assert.equal(openai.log.find((e) => e.kind === "authorize").query.client_id, "dynamic_agent_client");
    } finally {
      sb.cleanup();
    }
  });

  test("declining in the browser saves nothing", async () => {
    const sb = fresh();
    try {
      openai.authorizeError = "access_denied";
      const { result, page } = await signIn(sb.home);
      assert.ok(result instanceof Error);
      assert.equal(result.code, "declined");
      assert.equal(page.status, 400);
      assert.equal(existsSync(chatgpt.paths(sb.home).auth), false);
    } finally {
      sb.cleanup();
    }
  });

  test("an ID token not signed by OpenAI's published key is refused", async () => {
    const sb = fresh();
    try {
      openai.idToken = (claims) => signJwt(claims, stranger.privateKey);
      const { result } = await signIn(sb.home);
      assert.ok(result instanceof Error);
      assert.match(result.message, /signature/);
      assert.equal(existsSync(chatgpt.paths(sb.home).auth), false);
    } finally {
      sb.cleanup();
    }
  });

  test("an ID token that does not answer this sign-in's nonce is refused", async () => {
    const sb = fresh();
    try {
      openai.idToken = (claims) => signJwt({ ...claims, nonce: "someone else's" });
      const { result } = await signIn(sb.home);
      assert.ok(result instanceof Error);
      assert.match(result.message, /does not answer this sign-in/);
    } finally {
      sb.cleanup();
    }
  });

  test("an ID token for another client, from another issuer, or expired is refused", async () => {
    const doc = { issuer: openai.base, jwks_uri: `${openai.base}/.well-known/jwks.json` };
    const good = { iss: openai.base, aud: "oaiapp_test", sub: "u", nonce: "n", exp: Math.floor(Date.now() / 1000) + 600 };
    const check = (claims) => chatgpt.verifyIdToken(signJwt(claims), { doc, clientId: "oaiapp_test", nonce: "n" });
    await check(good);
    await assert.rejects(check({ ...good, aud: "oaiapp_other" }), /different client/);
    await assert.rejects(check({ ...good, iss: "https://evil.example" }), /unexpected issuer/);
    await assert.rejects(check({ ...good, exp: Math.floor(Date.now() / 1000) - 3600 }), /expired/);
  });

  test("a sign-in without plan usage is kept, but cannot run GPT models", async () => {
    const sb = fresh();
    try {
      openai.scope = "email offline_access openid profile";
      const { result } = await signIn(sb.home);
      assert.equal(result.planUsage, false);
      await assert.rejects(chatgpt.getAccessToken({ home: sb.home }), (e) => e.code === "no_plan_usage");
    } finally {
      sb.cleanup();
    }
  });

  test("the browser can be on another machine: pasting the address it lands on works", async () => {
    const sb = fresh();
    try {
      const { PassThrough } = await import("node:stream");
      const input = new PassThrough();
      const lines = [];
      const pending = chatgpt.login({ home: sb.home, browser: false, say: (l) => lines.push(l), input });
      let link;
      for (let i = 0; i < 200 && !link; i++) {
        link = lines.map((l) => l.trim()).find((l) => l.includes("/api/accounts/authorize?"));
        if (!link) await new Promise((r) => setTimeout(r, 10));
      }
      const landed = await new Promise((resolve) => http.get(link, (res) => (res.resume(), resolve(res.headers.location))));
      input.write(`${landed}\n`);
      const result = await pending;
      assert.equal(result.email, "me@example.com");
    } finally {
      sb.cleanup();
    }
  });
});

describe("staying signed in", () => {
  async function signedIn() {
    const sb = fresh();
    await signIn(sb.home);
    openai.log.length = 0;
    return sb;
  }
  const authOf = (sb) => JSON.parse(readFileSync(chatgpt.paths(sb.home).auth, "utf8"));
  const expire = (sb) => {
    const p = chatgpt.paths(sb.home);
    chatgpt.writePrivate(p.auth, { ...authOf(sb), expires_at: Date.now() - 1000 });
  };

  test("a fresh token is used as it is, without asking OpenAI", async () => {
    const sb = await signedIn();
    try {
      assert.equal(await chatgpt.getAccessToken({ home: sb.home }), "access-1");
      assert.equal(openai.count("refresh_token"), 0);
    } finally {
      sb.cleanup();
    }
  });

  test("a token about to expire is refreshed, and the replacement refresh token kept", async () => {
    const sb = await signedIn();
    try {
      expire(sb);
      assert.equal(await chatgpt.getAccessToken({ home: sb.home }), "access-2");
      const form = openai.log.find((e) => e.kind === "refresh_token").form;
      assert.deepEqual(form, { grant_type: "refresh_token", client_id: "oaiapp_test", refresh_token: "refresh-1", resource: "https://api.openai.com/v1" });
      assert.equal(authOf(sb).refresh_token, "refresh-2");
    } finally {
      sb.cleanup();
    }
  });

  test("callers refreshing at once share one refresh, as a second would use a spent token", async () => {
    const sb = await signedIn();
    try {
      expire(sb);
      openai.refreshDelayMs = 150;
      const tokens = await Promise.all(Array.from({ length: 5 }, () => chatgpt.getAccessToken({ home: sb.home })));
      assert.deepEqual(new Set(tokens), new Set(["access-2"]));
      assert.equal(openai.count("refresh_token"), 1);
    } finally {
      sb.cleanup();
    }
  });

  test("force refreshes even a fresh token, once OpenAI has turned it down", async () => {
    const sb = await signedIn();
    try {
      assert.equal(await chatgpt.getAccessToken({ home: sb.home, force: true }), "access-2");
    } finally {
      sb.cleanup();
    }
  });

  test("a refresh token OpenAI no longer accepts ends the sign-in, keeping the registration", async () => {
    const sb = await signedIn();
    try {
      expire(sb);
      openai.refresh = { status: 400, json: { error: "refresh_token_reused" } };
      await assert.rejects(chatgpt.getAccessToken({ home: sb.home }), (e) => e.code === "signed_out" && /ccc gpt login/.test(e.message));
      const auth = authOf(sb);
      assert.equal(auth.refresh_token, undefined);
      assert.equal(auth.access_token, undefined);
      assert.equal(auth.client_id, "oaiapp_test");
      assert.equal(chatgpt.status({ home: sb.home }).signedIn, false);
    } finally {
      sb.cleanup();
    }
  });

  test("a passing failure keeps the sign-in for the next try", async () => {
    const sb = await signedIn();
    try {
      expire(sb);
      openai.refresh = { status: 503, json: { error: { code: "unavailable" } } };
      await assert.rejects(chatgpt.getAccessToken({ home: sb.home }), (e) => e.code === "refresh_failed");
      assert.equal(authOf(sb).refresh_token, "refresh-1");
    } finally {
      sb.cleanup();
    }
  });

  test("signing out revokes at OpenAI and forgets the tokens, but not the registration", async () => {
    const sb = await signedIn();
    try {
      const result = await chatgpt.logout({ home: sb.home });
      assert.deepEqual(result, { wasSignedIn: true, revoked: true });
      assert.deepEqual(openai.log.find((e) => e.kind === "revoke").form, { token: "refresh-1", token_type_hint: "refresh_token", client_id: "oaiapp_test" });
      assert.equal(chatgpt.status({ home: sb.home }).signedIn, false);
      assert.equal(JSON.parse(readFileSync(chatgpt.paths(sb.home).host, "utf8")).client_id, "oaiapp_test");
      assert.deepEqual(await chatgpt.logout({ home: sb.home }), { wasSignedIn: false, revoked: false });
    } finally {
      sb.cleanup();
    }
  });

  test("status says who is signed in and never carries a token", async () => {
    const sb = await signedIn();
    try {
      const status = chatgpt.status({ home: sb.home });
      assert.equal(status.signedIn, true);
      assert.equal(status.email, "me@example.com");
      assert.equal(status.planLabel, "ChatGPT", "the plan is not in OpenAI's claims, so none is claimed");
      assert.doesNotMatch(JSON.stringify(status), /access-1|refresh-1|eyJ/);
    } finally {
      sb.cleanup();
    }
  });
});

describe("models", () => {
  test("lists the visible models with their efforts, and caches them", async () => {
    const sb = fresh();
    try {
      await signIn(sb.home);
      openai.log.length = 0;
      const models = await chatgpt.listModels({ home: sb.home });
      assert.deepEqual(
        models.map((m) => [m.id, m.name, m.efforts]),
        [
          ["gpt-6.1-sol", "GPT-6.1-Sol", ["low", "high"]],
          ["gpt-6-luna", "GPT-6-Luna", ["low"]],
        ]
      );
      assert.equal(models[0].contextWindow, 500000);
      assert.equal(openai.log.find((e) => e.kind === "models").auth, "Bearer access-1");

      await chatgpt.listModels({ home: sb.home });
      assert.equal(openai.count("models"), 1, "a recent list is not fetched again");

      openai.modelsStatus = 500;
      const fallback = await chatgpt.listModels({ home: sb.home, maxAgeMs: 0 });
      assert.equal(fallback.length, 2, "with OpenAI down, the cached list stands");
    } finally {
      sb.cleanup();
    }
  });

  test("signed out, there are no models to list", async () => {
    const sb = fresh();
    try {
      assert.deepEqual(await chatgpt.listModels({ home: sb.home }), []);
    } finally {
      sb.cleanup();
    }
  });

  test("a GPT model is known by the list, or by an OpenAI-only name", () => {
    const models = [{ id: "sol-x" }];
    assert.equal(chatgpt.isGptModelId("sol-x", models), true);
    assert.equal(chatgpt.isGptModelId("gpt-6.1-sol[1m]", []), true);
    assert.equal(chatgpt.isGptModelId("claude-opus-5-5", models), false);
    assert.equal(chatgpt.isGptModelId("opus", models), false);
  });
});

describe("ccc gpt", () => {
  test("status signed out says how to sign in", () => {
    const sb = fresh();
    try {
      const r = sb.node("src/chatgpt.cjs", ["status"]);
      assert.equal(r.status, 1);
      assert.match(r.stdout, /not signed in\. Run: ccc gpt login/);
    } finally {
      sb.cleanup();
    }
  });

  // Run the CLI without blocking this process, which is also the stand-in
  // OpenAI the CLI talks to: spawnSync would leave nobody to answer it.
  function cli(sb, args) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [join(REPO_ROOT, "src", "chatgpt.cjs"), ...args], { env: sb.env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  }

  test("status and models signed in", async () => {
    const sb = fresh();
    try {
      await signIn(sb.home);
      const status = await cli(sb, ["status"]);
      assert.equal(status.status, 0, status.stderr);
      assert.match(status.stdout, /signed in as me@example\.com/);
      assert.match(status.stdout, /GPT-6\.1-Sol \(gpt-6\.1-sol\)/);
      const models = await cli(sb, ["models", "--json"]);
      assert.deepEqual(JSON.parse(models.stdout).map((m) => m.id), ["gpt-6.1-sol", "gpt-6-luna"]);
    } finally {
      sb.cleanup();
    }
  });

  test("logout signed out is harmless", () => {
    const sb = fresh();
    try {
      const r = sb.node("src/chatgpt.cjs", ["logout"]);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /was not signed in/);
    } finally {
      sb.cleanup();
    }
  });

  test("an unknown command prints the help", () => {
    const sb = fresh();
    try {
      const r = sb.node("src/chatgpt.cjs", ["frobnicate"]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /usage: ccc gpt/);
    } finally {
      sb.cleanup();
    }
  });
});
