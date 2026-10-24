// Tests for live usage: how the answer Claude Code gives is read, and how it is
// asked for.
//
// The claude on PATH is the sandbox stub, which answers a get_usage request with
// whatever the test set through setUsage() and logs how it was run. Nothing here
// starts the real Claude Code or reaches the network.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";
import { makeSandbox, usageAnswer, REPO_ROOT } from "./helpers.test.mjs";

const require = createRequire(import.meta.url);
const usage = require(join(REPO_ROOT, "src", "usage.cjs"));

const HOUR = 3600000;

describe("parseUsage", () => {
  test("turns percent used into percent left, with the reset time", () => {
    const reset = Date.UTC(2026, 9, 24, 15, 0, 0);
    const r = usage.parseUsage(usageAnswer({ fiveHour: 42, weekly: 12, fiveHourReset: reset }));
    assert.equal(r.status, "ok");
    assert.equal(r.subscriptionType, "pro");
    assert.deepEqual(r.fiveHour, { used: 42, left: 58, resetsAt: reset });
    assert.deepEqual(r.weekly, { used: 12, left: 88, resetsAt: null });
  });

  // A 5-hour window that has not started has no reset time yet.
  test("a window with no reset time is still a window", () => {
    const r = usage.parseUsage(usageAnswer({ fiveHour: 0 }));
    assert.deepEqual(r.fiveHour, { used: 0, left: 100, resetsAt: null });
  });

  test("percentages outside 0-100 are clamped", () => {
    const r = usage.parseUsage(usageAnswer({ fiveHour: 104, weekly: -3 }));
    assert.equal(r.fiveHour.left, 0);
    assert.equal(r.weekly.left, 100);
  });

  test("a window the server did not report is null, not zero", () => {
    const answer = usageAnswer();
    answer.rate_limits.seven_day = null;
    assert.equal(usage.parseUsage(answer).weekly, null);
  });

  // An API key, Bedrock or Vertex: plan limits do not apply at all.
  test("no plan limits is its own answer, not an error", () => {
    const r = usage.parseUsage({ subscription_type: null, rate_limits_available: false, rate_limits: null });
    assert.equal(r.status, "unavailable");
  });

  test("nothing usable is an error", () => {
    assert.equal(usage.parseUsage(null).status, "error");
    assert.equal(usage.parseUsage("nonsense").status, "error");
  });
});

describe("formatResetIn", () => {
  const now = Date.UTC(2026, 9, 24, 12, 0, 0);

  test("minutes, hours and minutes, days and hours", () => {
    assert.equal(usage.formatResetIn(now + 42 * 60000, now), "in 42m");
    assert.equal(usage.formatResetIn(now + 4 * HOUR + 2 * 60000, now), "in 4h 2m");
    assert.equal(usage.formatResetIn(now + 2 * 24 * HOUR + 6 * HOUR, now), "in 2d 6h");
  });

  test("a part-minute rounds up, so it never says in 0m", () => {
    assert.equal(usage.formatResetIn(now + 1000, now), "in 1m");
  });

  test("a reset that has passed is now, and no reset time is nothing", () => {
    assert.equal(usage.formatResetIn(now - 1000, now), "now");
    assert.equal(usage.formatResetIn(null, now), "");
  });
});

describe("quoteWindowsArg", () => {
  test("a plain argument is left alone", () => {
    assert.equal(usage.quoteWindowsArg("--verbose"), "--verbose");
  });

  test("the JSON settings argument survives the C runtime's rules", () => {
    assert.equal(usage.quoteWindowsArg('{"disableAllHooks":true}'), '"{\\"disableAllHooks\\":true}"');
  });

  test("spaces are quoted, and backslashes before a quote are doubled", () => {
    assert.equal(usage.quoteWindowsArg("C:\\Program Files\\x"), '"C:\\Program Files\\x"');
    assert.equal(usage.quoteWindowsArg("a b\\"), '"a b\\\\"');
    assert.equal(usage.quoteWindowsArg('a\\"b'), '"a\\\\\\"b"');
    assert.equal(usage.quoteWindowsArg(""), '""');
  });
});

describe("fetchUsage", () => {
  const fetchFor = (sb, configDir, opts = {}) =>
    usage.fetchUsage(configDir ? join(sb.profilesDir, configDir) : null, { env: sb.env, cwd: sb.home, ...opts });

  test("asks Claude Code and returns what it answered", async () => {
    const sb = makeSandbox();
    try {
      sb.setUsage({ account2: usageAnswer({ fiveHour: 30, weekly: 75, subscription: "max" }) });
      const r = await fetchFor(sb, "account2");
      assert.equal(r.status, "ok", r.error);
      assert.equal(r.fiveHour.left, 70);
      assert.equal(r.weekly.left, 25);
      assert.equal(r.subscriptionType, "max");
    } finally {
      sb.cleanup();
    }
  });

  // No prompt, so no model call; hooks off, no MCP servers, nothing saved.
  test("runs a session that can do nothing but answer", async () => {
    const sb = makeSandbox();
    try {
      sb.setUsage({ account2: usageAnswer() });
      await fetchFor(sb, "account2");
      const call = sb.calls().find((l) => l.startsWith("claude-usage "));
      assert.ok(call, "claude was never asked");
      assert.match(call, /cfg=\[.*account2\]/);
      assert.match(
        call,
        /args=\[-p --input-format stream-json --output-format stream-json --verbose --no-session-persistence --strict-mcp-config --settings \{"disableAllHooks":true\}\]/
      );
    } finally {
      sb.cleanup();
    }
  });

  // A developer running the suite inside Claude Code has CLAUDE_CONFIG_DIR set;
  // the default profile must be asked with it unset.
  test("the default profile is asked with CLAUDE_CONFIG_DIR unset", async () => {
    const sb = makeSandbox();
    try {
      sb.setUsage({ default: usageAnswer({ weekly: 10 }) });
      const r = await usage.fetchUsage(null, {
        env: { ...sb.env, CLAUDE_CONFIG_DIR: join(sb.profilesDir, "account9") },
        cwd: sb.home,
      });
      assert.equal(r.status, "ok", r.error);
      assert.equal(r.weekly.left, 90);
      assert.match(sb.calls().find((l) => l.startsWith("claude-usage ")), /cfg=\[(<unset>)?\]/);
    } finally {
      sb.cleanup();
    }
  });

  test("a failed request says why", async () => {
    const sb = makeSandbox();
    try {
      sb.setUsage({ account2: { __error: "Unknown request subtype" } });
      const r = await fetchFor(sb, "account2");
      assert.equal(r.status, "error");
      assert.match(r.error, /Unknown request subtype/);
    } finally {
      sb.cleanup();
    }
  });

  test("no answer at all is an error, not a hang", async () => {
    const sb = makeSandbox();
    try {
      sb.setUsage({ account2: { __silent: true } });
      const r = await fetchFor(sb, "account2");
      assert.equal(r.status, "error");
      assert.match(r.error, /no answer/);
    } finally {
      sb.cleanup();
    }
  });

  test("a slow answer is given up on", async () => {
    const sb = makeSandbox();
    try {
      sb.setUsage({ account2: { ...usageAnswer(), __sleepMs: 5000 } });
      const r = await fetchFor(sb, "account2", { timeoutMs: 300 });
      assert.deepEqual(r, { status: "error", error: "timed out" });
    } finally {
      sb.cleanup();
    }
  });

  test("a login with no plan limits comes back as unavailable", async () => {
    const sb = makeSandbox();
    try {
      sb.setUsage({ account2: { subscription_type: null, rate_limits_available: false, rate_limits: null } });
      assert.equal((await fetchFor(sb, "account2")).status, "unavailable");
    } finally {
      sb.cleanup();
    }
  });

  test("no claude on PATH is an error, not a crash", async () => {
    const sb = makeSandbox();
    try {
      // Node's own directory goes too: with nvm, a real claude sits right
      // beside node, and this test must never reach a real account.
      const PATH = sb
        .envWithoutNode()
        .PATH.split(delimiter)
        .filter((p) => p !== sb.stubs)
        .join(delimiter);
      const r = await usage.fetchUsage(null, { env: { ...sb.env, PATH }, cwd: sb.home });
      assert.equal(r.status, "error");
    } finally {
      sb.cleanup();
    }
  });
});
