// Tests for the account picker.
//
// The picker's contract with the shell launchers is narrow and worth pinning:
// the chosen profile path goes to stdout and nothing else does, the UI goes to
// stderr, and "__DEFAULT__" means the default ~/.claude profile.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, stripAnsi } from "./helpers.test.mjs";

describe("stdout contract", () => {
  test("choosing a profile writes only its path to stdout", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, {
        accounts: { 1: { name: "One", configDir: null }, 2: { name: "Two", configDir: "account2" } },
      });

      const r = sb.node("src/picker.mjs", [], {}, "2\n");
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, join(sb.profilesDir, "account2"));
    } finally {
      sb.cleanup();
    }
  });

  test("choosing the default profile writes the __DEFAULT__ sentinel", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: { 1: { name: "One", configDir: null } } });
      const r = sb.node("src/picker.mjs", [], {}, "1\n");
      assert.equal(r.stdout, "__DEFAULT__");
    } finally {
      sb.cleanup();
    }
  });

  test("the whole interface goes to stderr, never stdout", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: { 1: { name: "One", configDir: null } } });
      const r = sb.node("src/picker.mjs", [], {}, "1\n");

      assert.match(r.stderr, /Account Switcher/);
      assert.doesNotMatch(r.stdout, /Account Switcher/);
      assert.equal(r.stdout.includes("\n"), false, "stdout must be a bare path");
    } finally {
      sb.cleanup();
    }
  });

  test("quitting writes nothing and exits 0", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: { 1: { name: "One", configDir: null } } });
      const r = sb.node("src/picker.mjs", [], {}, "q\n");
      assert.equal(r.status, 0);
      assert.equal(r.stdout, "");
    } finally {
      sb.cleanup();
    }
  });

  test("an invalid choice re-prompts rather than giving up", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: { 1: { name: "One", configDir: null } } });
      const r = sb.node("src/picker.mjs", [], {}, "zzz\n1\n");
      assert.match(r.stderr, /Invalid choice/);
      assert.equal(r.stdout, "__DEFAULT__");
    } finally {
      sb.cleanup();
    }
  });
});

describe("config handling", () => {
  test("no config.json falls back to the built-in accounts", () => {
    const sb = makeSandbox();
    try {
      const r = sb.node("src/picker.mjs", [], {}, "2\n");
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, join(sb.profilesDir, "account2"));
    } finally {
      sb.cleanup();
    }
  });

  // Falling back to the defaults here would show an account list that is not
  // the user's, and picking from it would launch the wrong profile.
  test("a malformed config.json stops with a message instead of guessing", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, {});
      writeFileSync(sb.configPath, '{"accounts":{"1":{}},}');

      const r = sb.node("src/picker.mjs", [], {}, "1\n");
      assert.equal(r.status, 1);
      assert.equal(r.stdout, "", "must not emit a profile path");
      assert.match(r.stderr, /could not be read/);
    } finally {
      sb.cleanup();
    }
  });

  test("an entry with no name renders a placeholder, not 'undefined'", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: { 1: { configDir: null } } });
      const r = sb.node("src/picker.mjs", [], {}, "1\n");
      assert.doesNotMatch(stripAnsi(r.stderr), /undefined/);
      assert.match(stripAnsi(r.stderr), /Account 1/);
    } finally {
      sb.cleanup();
    }
  });

  test("slots past 9 are listed and selectable", () => {
    const sb = makeSandbox();
    try {
      const accounts = {};
      for (let i = 1; i <= 12; i++) {
        accounts[i] = { name: `Account ${i}`, configDir: i === 1 ? null : `account${i}` };
      }
      sb.writeJson(sb.configPath, { accounts });

      const r = sb.node("src/picker.mjs", [], {}, "12\n");
      assert.equal(r.stdout, join(sb.profilesDir, "account12"));
    } finally {
      sb.cleanup();
    }
  });
});

describe("box rendering", () => {
  // Terminal display width of the box-drawing and emoji characters is
  // terminal-dependent, so this pins only the invariant that does not depend on
  // any of that: the frame must stay rectangular for plain ASCII content.
  test("a very long account name does not widen the box", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, {
        accounts: { 1: { name: "N".repeat(200), configDir: null } },
      });

      const r = sb.node("src/picker.mjs", [], {}, "1\n");
      const rows = stripAnsi(r.stderr)
        .split("\n")
        .filter((l) => l.includes("┃"));

      assert.ok(rows.length > 0, "expected some box rows");
      const widths = new Set(rows.map((l) => l.length));
      assert.equal(widths.size, 1, `box rows have inconsistent widths: ${[...widths].join(", ")}`);
    } finally {
      sb.cleanup();
    }
  });
});

describe("credential detection", () => {
  // No real credentials anywhere: an empty sandbox means no Keychain entry and
  // no .credentials.json, so every account must read as not logged in.
  test("a profile with no credentials reads as not logged in", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: { 2: { name: "Two", configDir: "account2" } } });
      const r = sb.node("src/picker.mjs", [], {}, "2\n");
      assert.match(stripAnsi(r.stderr), /not logged in/);
    } finally {
      sb.cleanup();
    }
  });

  test("a legacy .credentials.json file is detected without any Keychain access", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: { 2: { name: "Two", configDir: "account2" } } });
      sb.writeJson(join(sb.profilesDir, "account2", ".credentials.json"), {
        claudeAiOauth: { subscriptionType: "claude_pro" },
      });

      const r = sb.node("src/picker.mjs", [], {}, "2\n");
      const ui = stripAnsi(r.stderr);
      assert.match(ui, /Claude Pro/);
      assert.doesNotMatch(ui, /not logged in/);
    } finally {
      sb.cleanup();
    }
  });

  test("the plan tier is read from .claude.json when present", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: { 2: { name: "Two", configDir: "account2" } } });
      sb.writeJson(join(sb.profilesDir, "account2", ".credentials.json"), { claudeAiOauth: {} });
      sb.writeJson(join(sb.profilesDir, "account2", ".claude.json"), {
        oauthAccount: {
          emailAddress: "someone@example.com",
          organizationRateLimitTier: "default_claude_max_20x",
        },
      });

      const r = sb.node("src/picker.mjs", [], {}, "2\n");
      const ui = stripAnsi(r.stderr);
      assert.match(ui, /Claude Max 20x/);
      assert.match(ui, /someone@example\.com/);
    } finally {
      sb.cleanup();
    }
  });
});
