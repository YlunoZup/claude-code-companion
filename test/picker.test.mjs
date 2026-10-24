// Tests for the account picker.
//
// The picker's contract with the shell launchers is narrow and worth pinning:
// the chosen account's number goes to stdout and nothing else does, and the UI
// goes to stderr. The launchers resolve the number to a profile themselves, so
// the ChatGPT account and a Claude account start the same way.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, stripAnsi, usageAnswer } from "./helpers.test.mjs";

describe("stdout contract", () => {
  test("choosing an account writes only its number to stdout", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, {
        accounts: { 1: { name: "One", configDir: null }, 2: { name: "Two", configDir: "account2" } },
      });

      const r = sb.node("src/picker.mjs", [], {}, "2\n");
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "2");
    } finally {
      sb.cleanup();
    }
  });

  test("choosing the default profile writes its number too", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: { 1: { name: "One", configDir: null } } });
      const r = sb.node("src/picker.mjs", [], {}, "1\n");
      assert.equal(r.stdout, "1");
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
      assert.equal(r.stdout.includes("\n"), false, "stdout must be a bare number");
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
      assert.equal(r.stdout, "1");
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
      assert.equal(r.stdout, "2");
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
      assert.equal(r.stdout, "", "must not emit an account");
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
      assert.equal(r.stdout, "12");
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

describe("live usage", () => {
  const MINUTE = 60000;
  const usageCalls = (sb) => sb.calls().filter((l) => l.startsWith("claude-usage "));

  function workAccount(sb, answer) {
    sb.writeJson(sb.configPath, { accounts: { 2: { name: "Work", configDir: "account2" } } });
    sb.signIn("account2", { email: "work@example.com", accountUuid: "uuid-work" });
    sb.setUsage({ account2: answer });
  }

  test("shows how much of each limit is left, and when it resets", () => {
    const sb = makeSandbox();
    try {
      const now = Date.now();
      workAccount(
        sb,
        usageAnswer({
          fiveHour: 25,
          weekly: 60,
          fiveHourReset: now + 130 * MINUTE,
          weeklyReset: now + (77 * 60 + 30) * MINUTE,
        })
      );

      const r = sb.node("src/picker.mjs", [], {}, "q\n");
      const ui = stripAnsi(r.stderr);

      assert.equal(r.status, 0, r.stderr);
      assert.match(ui, /work@example\.com/);
      assert.match(ui, /5h\s+████████░░\s+75% left · resets in 2h \d+m/);
      assert.match(ui, /week\s+████░░░░░░\s+40% left · resets in 3d 5h/);
    } finally {
      sb.cleanup();
    }
  });

  // A 5-hour window that has not started reports no reset time.
  test("a window that has not started shows as full, with no reset time", () => {
    const sb = makeSandbox();
    try {
      workAccount(sb, usageAnswer({ fiveHour: 0, weekly: 100, weeklyReset: Date.now() + 26 * 60 * MINUTE }));
      const ui = stripAnsi(sb.node("src/picker.mjs", [], {}, "q\n").stderr);
      assert.match(ui, /5h\s+██████████ 100% left\s/);
      assert.match(ui, /week\s+░░░░░░░░░░\s+0% left · resets in 1d \dh/);
    } finally {
      sb.cleanup();
    }
  });

  test("an account that is not signed in is not asked, and says how to sign in", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: { 2: { name: "Two", configDir: "account2" } } });
      const ui = stripAnsi(sb.node("src/picker.mjs", [], {}, "q\n").stderr);
      assert.match(ui, /not logged in\s+·\s+ccc login 2/);
      assert.deepEqual(usageCalls(sb), []);
    } finally {
      sb.cleanup();
    }
  });

  // Two slots on one Claude account share its limits — worth saying, since
  // their names suggest otherwise — and need asking about only once.
  test("a slot signed into the same account as an earlier one says so", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, {
        accounts: { 2: { name: "Work", configDir: "account2" }, 3: { name: "Client", configDir: "account3" } },
      });
      sb.signIn("account2", { email: "me@example.com", accountUuid: "uuid-same" });
      sb.signIn("account3", { email: "me@example.com", accountUuid: "uuid-same" });
      sb.setUsage({ account2: usageAnswer({ weekly: 10 }), account3: usageAnswer({ weekly: 99 }) });

      const ui = stripAnsi(sb.node("src/picker.mjs", [], {}, "q\n").stderr);

      assert.match(ui, /\[3\]\s+●\s+Client\s+same login as \[2\]/);
      assert.doesNotMatch(ui, /\[2\][^\n]*same login/);
      assert.equal((ui.match(/90% left/g) || []).length, 2, "both slots show the one answer");
      assert.equal(usageCalls(sb).length, 1, "the shared account is asked once");
    } finally {
      sb.cleanup();
    }
  });

  test("usage that could not be fetched says why", () => {
    const sb = makeSandbox();
    try {
      workAccount(sb, { __error: "Unknown request subtype" });
      const ui = stripAnsi(sb.node("src/picker.mjs", [], {}, "q\n").stderr);
      assert.match(ui, /usage unavailable: Unknown request subtype/);
    } finally {
      sb.cleanup();
    }
  });

  test("CCC_NO_USAGE leaves usage out entirely", () => {
    const sb = makeSandbox();
    try {
      workAccount(sb, usageAnswer({ weekly: 60 }));
      const ui = stripAnsi(sb.node("src/picker.mjs", [], { CCC_NO_USAGE: "1" }, "q\n").stderr);
      assert.doesNotMatch(ui, /% left/);
      assert.deepEqual(usageCalls(sb), []);
    } finally {
      sb.cleanup();
    }
  });

  test("r asks for the usage again", () => {
    const sb = makeSandbox();
    try {
      workAccount(sb, usageAnswer({ weekly: 60 }));
      const r = sb.node("src/picker.mjs", [], {}, "r\nq\n");
      assert.equal(r.status, 0, r.stderr);
      assert.equal(usageCalls(sb).length, 2);
      assert.equal((stripAnsi(r.stderr).match(/Account Switcher/g) || []).length, 2, "drawn again");
    } finally {
      sb.cleanup();
    }
  });

  test("the box stays rectangular with usage rows in it", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, {
        accounts: {
          2: { name: "W".repeat(80), configDir: "account2" },
          3: { name: "C".repeat(80), configDir: "account3" },
        },
      });
      sb.signIn("account2", { email: `${"e".repeat(70)}@example.com`, accountUuid: "u", tier: "default_claude_max_20x" });
      sb.signIn("account3", { email: "x@example.com", accountUuid: "u" });
      sb.setUsage({ account2: usageAnswer({ fiveHour: 3, weekly: 100, weeklyReset: Date.now() + 1e9 }) });

      const rows = stripAnsi(sb.node("src/picker.mjs", [], {}, "q\n").stderr)
        .split("\n")
        .filter((l) => l.includes("┃"));
      const widths = new Set(rows.map((l) => l.length));
      assert.equal(widths.size, 1, `box rows have inconsistent widths: ${[...widths].join(", ")}`);
    } finally {
      sb.cleanup();
    }
  });
});

describe("--list", () => {
  test("prints the overview to stdout and exits without a prompt", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: { 2: { name: "Work", configDir: "account2" } } });
      sb.signIn("account2", { email: "work@example.com" });
      sb.setUsage({ account2: usageAnswer({ weekly: 60 }) });

      const r = sb.node("src/picker.mjs", ["--list"], {}, "");

      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Account Switcher/);
      assert.match(r.stdout, /40% left/);
      assert.doesNotMatch(r.stderr, /Select account/);
    } finally {
      sb.cleanup();
    }
  });

  // Piped or redirected, colour codes would only get in the way.
  test("has no colour codes when stdout is not a terminal", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: { 1: { name: "One", configDir: null } } });
      const r = sb.node("src/picker.mjs", ["--list"], {}, "");
      assert.equal(r.stdout.includes("\x1b["), false);
    } finally {
      sb.cleanup();
    }
  });
});

describe("the ChatGPT account", () => {
  const usageCalls = (sb) => sb.calls().filter((l) => l.startsWith("claude-usage "));

  function setUp(sb, { signedIn = true } = {}) {
    sb.writeJson(sb.configPath, {
      accounts: {
        2: { name: "Work", configDir: "account2", gpt: true },
        6: { name: "ChatGPT", configDir: "account6", provider: "chatgpt" },
      },
    });
    sb.signIn("account2", { email: "work@example.com", accountUuid: "uuid-work" });
    sb.setUsage({ account2: usageAnswer({ fiveHour: 10, weekly: 20 }) });
    if (signedIn) {
      sb.writeJson(join(sb.profilesDir, "chatgpt", "auth.json"), {
        client_id: "oaiapp_test",
        account: { email: "me@example.com" },
        access_token: "a",
        refresh_token: "r",
        plan_usage: true,
        expires_at: Date.now() + 3600000,
      });
    }
  }

  test("shows who it is signed in as, and that it runs on the ChatGPT plan", () => {
    const sb = makeSandbox();
    try {
      setUp(sb);
      const ui = stripAnsi(sb.node("src/picker.mjs", ["--list"]).stdout);
      assert.match(ui, /\[6\]\s+●\s+ChatGPT/);
      assert.match(ui, /me@example\.com\s+·\s+ChatGPT/);
      assert.match(ui, /GPT models in Claude Code, on your ChatGPT plan/);
      assert.match(ui, /usage: chatgpt\.com\/settings\/usage/);
    } finally {
      sb.cleanup();
    }
  });

  test("its usage is not asked of Claude Code, whose limits are not ChatGPT's", () => {
    const sb = makeSandbox();
    try {
      setUp(sb);
      sb.node("src/picker.mjs", ["--list"]);
      const asked = usageCalls(sb);
      assert.equal(asked.length, 1, asked.join("\n"));
      assert.match(asked[0], /account2/);
    } finally {
      sb.cleanup();
    }
  });

  test("a Claude account that always gets the GPT models says so", () => {
    const sb = makeSandbox();
    try {
      setUp(sb);
      assert.match(stripAnsi(sb.node("src/picker.mjs", ["--list"]).stdout), /\[2\]\s+●\s+Work\s+\+ GPT models/);
    } finally {
      sb.cleanup();
    }
  });

  test("signed out, it says how to sign in, and picking it starts nothing", () => {
    const sb = makeSandbox();
    try {
      setUp(sb, { signedIn: false });
      const list = stripAnsi(sb.node("src/picker.mjs", ["--list"]).stdout);
      assert.match(list, /not logged in\s+·\s+ccc gpt login/);
      const r = sb.node("src/picker.mjs", [], { CCC_NO_USAGE: "1" }, "6\n");
      assert.equal(r.status, 0);
      assert.equal(r.stdout, "");
      assert.match(stripAnsi(r.stderr), /not signed in to ChatGPT yet\. Run: ccc gpt login/);
    } finally {
      sb.cleanup();
    }
  });

  test("picking it signed in hands its number to the launcher", () => {
    const sb = makeSandbox();
    try {
      setUp(sb);
      assert.equal(sb.node("src/picker.mjs", [], { CCC_NO_USAGE: "1" }, "6\n").stdout, "6");
    } finally {
      sb.cleanup();
    }
  });
});
