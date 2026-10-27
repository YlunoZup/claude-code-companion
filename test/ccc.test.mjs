// Integration tests for the bash launcher.
//
// A stub `claude` on PATH records CLAUDE_CONFIG_DIR and its arguments instead of
// launching anything, so these assert the one thing the launcher exists to do:
// hand the right profile directory to the right process.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gitBashCannotUse, makeSandbox, usageAnswer } from "./helpers.test.mjs";

/** Parse the last recorded stub invocation. */
function lastCall(sb) {
  const calls = sb.calls().filter((l) => l.startsWith("claude "));
  assert.ok(calls.length > 0, "claude was never launched");
  const m = /^claude cfg=\[(.*)\] args=\[(.*)\]$/.exec(calls[calls.length - 1]);
  assert.ok(m, `unparsable call line: ${calls[calls.length - 1]}`);
  return { configDir: m[1], args: m[2] };
}

describe("ccc <number>", () => {
  let sb;
  before(() => {
    sb = makeSandbox();
    const r = sb.install();
    assert.equal(r.status, 0, r.stderr);
  });
  after(() => sb.cleanup());

  test("slot 1 launches the default profile with no CLAUDE_CONFIG_DIR", () => {
    const r = sb.ccc(["1"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(lastCall(sb).configDir, "<unset>");
    assert.equal(lastCall(sb).args, "--dangerously-skip-permissions");
  });

  test("slot 2 points at the account2 profile", () => {
    const r = sb.ccc(["2"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(lastCall(sb).configDir, join(sb.profilesDir, "account2"));
  });

  test("a slot configured in config.json but never installed still resolves", () => {
    sb.ccc(["3"]);
    assert.equal(lastCall(sb).configDir, join(sb.profilesDir, "account3"));
  });

  test("an unconfigured slot falls back to the accountN convention", () => {
    sb.ccc(["9"]);
    assert.equal(lastCall(sb).configDir, join(sb.profilesDir, "account9"));
  });

  test("a leading dash is accepted, as it always has been", () => {
    sb.ccc(["-2"]);
    assert.equal(lastCall(sb).configDir, join(sb.profilesDir, "account2"));
  });

  test("everything after the slot reaches claude untouched", () => {
    sb.ccc(["2", "-c", "--dangerously-skip-permissions"]);
    assert.equal(lastCall(sb).args, "-c --dangerously-skip-permissions");
  });

  // The Windows launcher used to forward only %1..%9.
  test("more than nine arguments are all forwarded", () => {
    const args = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"].map((n) => `--a${n}`);
    sb.ccc(["2", ...args]);
    assert.equal(lastCall(sb).args, `--dangerously-skip-permissions ${args.join(" ")}`);
  });

  test("ccc -1 starts the default account with permissions bypassed", () => {
    const r = sb.ccc(["-1"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(lastCall(sb), { configDir: "<unset>", args: "--dangerously-skip-permissions" });
  });

  for (const [name, args, expected] of [
    ["an explicit planning mode", ["--permission-mode", "plan", "-c"], "--permission-mode plan -c"],
    ["an explicit manual mode", ["--permission-mode", "manual"], "--permission-mode manual"],
    ["an equals-style permission mode", ["--permission-mode=plan"], "--permission-mode=plan"],
    ["a permission-looking positional argument", ["--", "--permission-mode"], "--dangerously-skip-permissions -- --permission-mode"],
    ["permission-option text in a prompt", ["--append-system-prompt", "Document --permission-mode without changing modes."], "--dangerously-skip-permissions --append-system-prompt Document --permission-mode without changing modes."],
    ["quoted prompt text", ["--append-system-prompt", 'Keep "quotes", spaces, & separators as text.'], '--dangerously-skip-permissions --append-system-prompt Keep "quotes", spaces, & separators as text.'],
  ]) {
    test(`preserves ${name}`, () => {
      const r = sb.ccc(["2", ...args]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(lastCall(sb).args, expected);
    });
  }

  test("launching a profile wires up the shared session history", () => {
    sb.ccc(["5"]);
    const link = join(sb.profilesDir, "account5", "projects");
    assert.ok(existsSync(link), "projects link should exist");
    writeFileSync(join(sb.claudeDir, "projects", "from-default.txt"), "shared");
    assert.ok(
      existsSync(join(link, "from-default.txt")),
      "the profile should see the default profile's sessions"
    );
  });
});

describe("ccc <number> honours config.json over convention", () => {
  test("slot 1 mapped to a real directory launches that directory", () => {
    const sb = makeSandbox();
    try {
      assert.equal(sb.install().status, 0);
      sb.writeJson(sb.configPath, {
        accounts: { 1: { name: "Work first", configDir: "work" } },
      });

      sb.ccc(["1"]);
      assert.equal(lastCall(sb).configDir, join(sb.profilesDir, "work"));
    } finally {
      sb.cleanup();
    }
  });

  test("an entry with configDir null is the default profile whatever its slot", () => {
    const sb = makeSandbox();
    try {
      assert.equal(sb.install().status, 0);
      sb.writeJson(sb.configPath, { accounts: { 4: { name: "Personal", configDir: null } } });

      sb.ccc(["4"]);
      assert.equal(lastCall(sb).configDir, "<unset>");
    } finally {
      sb.cleanup();
    }
  });
});

describe("ccc add", () => {
  test("allocates the next slot and leaves the existing ones alone", () => {
    const sb = makeSandbox();
    try {
      assert.equal(sb.install().status, 0);

      const r = sb.ccc(["add", "Client", "Project"]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Account 4 added/);

      const config = sb.readJson(sb.configPath);
      assert.equal(config.accounts["4"].name, "Client Project", "the whole name must survive");
      assert.equal(config.accounts["4"].configDir, "account4");
      assert.equal(config.accounts["1"].configDir, null);
      assert.equal(config.accounts["2"].configDir, "account2");
      assert.equal(config.accounts["3"].configDir, "account3");

      assert.match(
        sb.readJson(join(sb.profilesDir, "account4", "settings.json")).statusLine.command,
        /statusline\.js/
      );
    } finally {
      sb.cleanup();
    }
  });

  test("the new slot is immediately launchable", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      sb.ccc(["add", "Fresh"]);
      sb.ccc(["4"]);
      assert.equal(lastCall(sb).configDir, join(sb.profilesDir, "account4"));
    } finally {
      sb.cleanup();
    }
  });

  test("prompts for a name when none is given", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      const r = sb.ccc(["add"], { input: "Typed Name\n" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(sb.readJson(sb.configPath).accounts["4"].name, "Typed Name");
    } finally {
      sb.cleanup();
    }
  });

  test("an empty answer falls back to the default name", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      sb.ccc(["add"], { input: "\n" });
      assert.equal(sb.readJson(sb.configPath).accounts["4"].name, "Account 4");
    } finally {
      sb.cleanup();
    }
  });

  // A single syntax error in config.json used to reset it to one account and
  // re-point slot 1 at a brand-new profile.
  test("refuses to touch a config.json it cannot parse", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      const original = '{"accounts":{"1":{"name":"One","configDir":null},"2":{}},}';
      writeFileSync(sb.configPath, original);

      const r = sb.ccc(["add", "Nope"]);

      assert.notEqual(r.status, 0, "should have refused");
      assert.equal(readFileSync(sb.configPath, "utf8"), original, "config must be byte-identical");
      assert.equal(existsSync(join(sb.profilesDir, "account1")), false);
    } finally {
      sb.cleanup();
    }
  });

  test("merges into a settings.json that is already in the target directory", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      sb.writeJson(join(sb.profilesDir, "account4", "settings.json"), {
        theme: "dark",
        permissions: { allow: ["Read"] },
      });

      sb.ccc(["add", "Reused"]);

      const settings = sb.readJson(join(sb.profilesDir, "account4", "settings.json"));
      assert.equal(settings.theme, "dark", "existing settings must survive");
      assert.deepEqual(settings.permissions, { allow: ["Read"] });
      assert.match(settings.statusLine.command, /statusline\.js/);
    } finally {
      sb.cleanup();
    }
  });

  test("a name containing quotes is stored verbatim", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      sb.ccc(["add", `Bob's "Work" Account`]);
      assert.equal(sb.readJson(sb.configPath).accounts["4"].name, `Bob's "Work" Account`);
    } finally {
      sb.cleanup();
    }
  });
});

describe("home directories that need quoting", () => {
  for (const homeName of ["home with spaces", "o'brien"]) {
    const skip = gitBashCannotUse(homeName);

    test(`ccc add works when HOME is ${JSON.stringify(homeName)}`, { skip }, () => {
      const sb = makeSandbox({ homeName });
      try {
        assert.equal(sb.install().status, 0);

        const r = sb.ccc(["add", "Quoted"]);
        assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
        assert.equal(sb.readJson(sb.configPath).accounts["4"].name, "Quoted");
      } finally {
        sb.cleanup();
      }
    });

    test(`ccc <n> works when HOME is ${JSON.stringify(homeName)}`, { skip }, () => {
      const sb = makeSandbox({ homeName });
      try {
        sb.install();
        sb.ccc(["2"]);
        assert.equal(lastCall(sb).configDir, join(sb.profilesDir, "account2"));
      } finally {
        sb.cleanup();
      }
    });
  }
});

describe("the picker path", () => {
  test("a chosen profile is passed to claude", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      const r = sb.ccc(["--resume"], { input: "2\n" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(lastCall(sb).configDir, join(sb.profilesDir, "account2"));
      assert.equal(lastCall(sb).args, "--dangerously-skip-permissions --resume");
    } finally {
      sb.cleanup();
    }
  });

  test("an explicit permission mode survives the picker", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      const r = sb.ccc(["--permission-mode", "plan"], { input: "2\n" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(lastCall(sb).args, "--permission-mode plan");
    } finally { sb.cleanup(); }
  });

  test("choosing the default profile leaves CLAUDE_CONFIG_DIR unset", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      sb.ccc([], { input: "1\n" });
      assert.equal(lastCall(sb).configDir, "<unset>");
    } finally {
      sb.cleanup();
    }
  });

  test("quitting launches nothing at all", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      const r = sb.ccc([], { input: "q\n" });
      assert.equal(r.status, 0);
      assert.deepEqual(sb.calls(), [], "claude must not have been launched");
    } finally {
      sb.cleanup();
    }
  });
});

describe("missing dependencies", () => {
  // These paths used to leak a raw stack trace and still exit 0, so the caller
  // saw success while claude never ran.
  test("no node on PATH fails loudly instead of silently", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      const r = sb.ccc(["2"], { env: sb.envWithoutNode() });

      assert.notEqual(r.status, 0, "must not report success");
      assert.match(r.stderr, /Node\.js is required/);
      assert.deepEqual(sb.calls(), []);
    } finally {
      sb.cleanup();
    }
  });

  test("a missing profiles.cjs points at the installer", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      rmSync(join(sb.profilesDir, "profiles.cjs"));

      const r = sb.ccc(["2"]);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /Re-run the installer/);
    } finally {
      sb.cleanup();
    }
  });

  test("a missing picker.mjs points at the installer", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      rmSync(join(sb.profilesDir, "picker.mjs"));

      const r = sb.ccc([]);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /Re-run the installer/);
    } finally {
      sb.cleanup();
    }
  });

  test("a missing claude is reported before anything else happens", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      // The shell stub, and on Windows the .cmd one beside it.
      for (const stub of ["claude", "claude.cmd"]) rmSync(join(sb.stubs, stub), { force: true });

      const r = sb.ccc(["2"]);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /claude was not found/);
    } finally {
      sb.cleanup();
    }
  });
});

describe("the statusline is wired on every launch", () => {
  const settingsOf = (sb, dir) => join(dir || sb.claudeDir, "settings.json");

  // A profile created by logging in, rather than by `ccc add`, used to get no
  // statusline at all.
  test("a profile launched for the first time gets one", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      sb.ccc(["7"]);
      const settings = sb.readJson(settingsOf(sb, join(sb.profilesDir, "account7")));
      assert.match(settings.statusLine.command, /statusline\.js/);
    } finally {
      sb.cleanup();
    }
  });

  test("a statusLine that went missing is put back, through the picker too", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      const file = settingsOf(sb, join(sb.profilesDir, "account2"));
      sb.writeJson(file, { theme: "dark" });

      sb.ccc([], { input: "2\n" });

      const settings = sb.readJson(file);
      assert.equal(settings.theme, "dark");
      assert.match(settings.statusLine.command, /statusline\.js/);
    } finally {
      sb.cleanup();
    }
  });

  test("the default profile is covered as well", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      sb.writeJson(settingsOf(sb), { model: "opus" });

      sb.ccc(["1"]);

      assert.match(sb.readJson(settingsOf(sb)).statusLine.command, /statusline\.js/);
    } finally {
      sb.cleanup();
    }
  });

  test("somebody else's statusline is left exactly as it is", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      const file = settingsOf(sb, join(sb.profilesDir, "account2"));
      sb.writeJson(file, { statusLine: { type: "command", command: "npx -y ccstatusline@latest" } });
      const before = readFileSync(file, "utf8");

      sb.ccc(["2"]);

      assert.equal(readFileSync(file, "utf8"), before);
    } finally {
      sb.cleanup();
    }
  });

  test("a settings.json that does not parse is never rewritten", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      const file = settingsOf(sb, join(sb.profilesDir, "account2"));
      const original = '{ "theme": "dark", }';
      writeFileSync(file, original);

      const r = sb.ccc(["2"]);

      assert.equal(r.status, 0, "a bad settings.json must not stop the launch");
      assert.equal(readFileSync(file, "utf8"), original);
      assert.equal(lastCall(sb).configDir, join(sb.profilesDir, "account2"));
    } finally {
      sb.cleanup();
    }
  });
});

describe("shared session history", () => {
  test("an existing real projects directory in a profile is never replaced", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      const projects = join(sb.profilesDir, "account6", "projects");
      mkdirSync(projects, { recursive: true });
      writeFileSync(join(projects, "keep.txt"), "real history");

      sb.ccc(["6"]);

      assert.equal(readFileSync(join(projects, "keep.txt"), "utf8"), "real history");
    } finally {
      sb.cleanup();
    }
  });
});

describe("ccc help", () => {
  for (const flag of ["help", "-h", "--help"]) {
    test(`ccc ${flag} lists every command and launches nothing`, () => {
      const sb = makeSandbox();
      try {
        sb.install();
        const r = sb.ccc([flag]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /^ccc — Claude Code Companion/);
        assert.match(r.stdout, /ccc login <n>/);
        assert.match(r.stdout, /ccc repair \[n\]/);
        assert.deepEqual(sb.calls(), []);
      } finally {
        sb.cleanup();
      }
    });
  }
});

describe("ccc list", () => {
  test("prints every account with its live usage, and launches nothing", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      sb.signIn("account2", { email: "work@example.com" });
      sb.setUsage({ account2: usageAnswer({ fiveHour: 25, weekly: 60 }) });

      const r = sb.ccc(["list"]);

      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /work@example\.com/);
      assert.match(r.stdout, /75% left/);
      assert.match(r.stdout, /40% left/);
      assert.deepEqual(sb.calls().filter((l) => l.startsWith("claude ")), [], "no session may start");
    } finally {
      sb.cleanup();
    }
  });
});

describe("ccc login and logout", () => {
  test("ccc login <n> runs Claude Code's own sign-in in that profile", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      const r = sb.ccc(["login", "2"]);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(lastCall(sb), { configDir: join(sb.profilesDir, "account2"), args: "auth login" });
    } finally {
      sb.cleanup();
    }
  });

  test("slot 1 signs in the default profile, with CLAUDE_CONFIG_DIR unset", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      sb.ccc(["login", "1"]);
      assert.deepEqual(lastCall(sb), { configDir: "<unset>", args: "auth login" });
    } finally {
      sb.cleanup();
    }
  });

  test("relogin is login, and passes what follows to claude auth login", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      sb.ccc(["relogin", "3", "--email", "client@example.com"]);
      assert.deepEqual(lastCall(sb), {
        configDir: join(sb.profilesDir, "account3"),
        args: "auth login --email client@example.com",
      });
    } finally {
      sb.cleanup();
    }
  });

  test("ccc logout <n> signs that profile out", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      sb.ccc(["logout", "2"]);
      assert.deepEqual(lastCall(sb), { configDir: join(sb.profilesDir, "account2"), args: "auth logout" });
    } finally {
      sb.cleanup();
    }
  });

  // A brand-new slot is signed in like any other launch: wired up first.
  test("signing in a new slot sets its profile up first", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      sb.ccc(["login", "6"]);
      const dir = join(sb.profilesDir, "account6");
      assert.ok(existsSync(join(dir, "projects")), "shared history should be linked");
      assert.match(sb.readJson(join(dir, "settings.json")).statusLine.command, /statusline\.js/);
    } finally {
      sb.cleanup();
    }
  });

  for (const command of ["login", "logout"]) {
    test(`ccc ${command} without a number says how to use it and starts nothing`, () => {
      const sb = makeSandbox();
      try {
        sb.install();
        const r = sb.ccc([command, "work"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, new RegExp(`Usage: ccc ${command} <number>`));
        assert.deepEqual(sb.calls(), []);
      } finally {
        sb.cleanup();
      }
    });
  }
});

describe("ccc rename and remove", () => {
  test("rename changes the name and nothing else", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      const r = sb.ccc(["rename", "2", "Client", "Work"]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Account 2 is now "Client Work"/);
      assert.deepEqual(sb.readJson(sb.configPath).accounts["2"], { name: "Client Work", configDir: "account2" });
    } finally {
      sb.cleanup();
    }
  });

  test("renaming an account that does not exist fails and writes nothing", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      const before = readFileSync(sb.configPath, "utf8");
      const r = sb.ccc(["rename", "9", "Nope"]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /There is no account 9/);
      assert.equal(readFileSync(sb.configPath, "utf8"), before);
    } finally {
      sb.cleanup();
    }
  });

  test("rename without a new name says how to use it", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      const r = sb.ccc(["rename", "2"]);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /Usage: ccc rename <number> <new name>/);
    } finally {
      sb.cleanup();
    }
  });

  test("remove takes the account off the list and keeps its folder", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      const r = sb.ccc(["remove", "2"]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Removed account 2/);
      assert.equal(sb.readJson(sb.configPath).accounts["2"], undefined);
      assert.ok(existsSync(join(sb.profilesDir, "account2")), "the folder must be kept");
    } finally {
      sb.cleanup();
    }
  });
});

describe("ccc repair", () => {
  test("checks every account and fixes what it can", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      sb.writeJson(join(sb.profilesDir, "account2", "settings.json"), { theme: "dark" });

      const r = sb.ccc(["repair"]);

      assert.match(r.stdout, /\[1\][\s\S]*\[2\][\s\S]*\[3\]/);
      assert.match(r.stdout, /\+ added the statusline/);
      assert.match(sb.readJson(join(sb.profilesDir, "account2", "settings.json")).statusLine.command, /statusline\.js/);
      assert.equal(r.status, 1, "nobody is signed in, so something still needs the user");
      assert.deepEqual(sb.calls(), [], "repair must not start a session");
    } finally {
      sb.cleanup();
    }
  });

  test("ccc repair <n> checks only that account", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      const r = sb.ccc(["repair", "3"]);
      assert.match(r.stdout, /\[3\]/);
      assert.doesNotMatch(r.stdout, /\[1\]|\[2\]/);
    } finally {
      sb.cleanup();
    }
  });

  test("an account number that does not exist is refused", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      const r = sb.ccc(["repair", "8"]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /There is no account 8/);
    } finally {
      sb.cleanup();
    }
  });
});

// ── The GPT models ───────────────────────────────────────────

describe("ccc and the GPT models", () => {
  let sb;
  const chatgptDir = () => join(sb.profilesDir, "chatgpt");
  // cmd.exe hands a .cmd stub its arguments still quoted.
  const plain = (args) => args.replace(/"/g, "");

  before(() => {
    sb = makeSandbox();
    const r = sb.install();
    assert.equal(r.status, 0, r.stderr);
    const config = sb.readJson(sb.configPath);
    config.accounts["6"] = { name: "ChatGPT", configDir: "account6", provider: "chatgpt" };
    sb.writeJson(sb.configPath, config);
  });
  after(() => sb.cleanup());

  function signIn() {
    sb.writeJson(join(chatgptDir(), "auth.json"), {
      client_id: "oaiapp_test",
      account: { email: "me@example.com" },
      access_token: "a",
      refresh_token: "r",
      scope: "openid chatgpt.tokens.use.direct",
      plan_usage: true,
      expires_at: Date.now() + 3600000,
    });
    // A fresh list, so launching needs no network.
    sb.writeJson(join(chatgptDir(), "models.json"), { fetchedAt: Date.now(), models: [{ id: "gpt-6.1-sol", name: "GPT-6.1-Sol", efforts: [] }] });
  }
  function signOut() {
    rmSync(chatgptDir(), { recursive: true, force: true });
  }

  test("ccc gpt status, signed out, says how to sign in", () => {
    signOut();
    const r = sb.ccc(["gpt", "status"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /not signed in\. Run: ccc gpt login/);
  });

  test("ccc gpt with nothing after it prints its help", () => {
    const r = sb.ccc(["gpt"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /usage: ccc gpt <command>/);
  });

  test("ccc gpt on|off <n> sets whether a Claude account always gets the GPT models", () => {
    let r = sb.ccc(["gpt", "on", "2"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(sb.readJson(sb.configPath).accounts["2"].gpt, true);
    r = sb.ccc(["gpt", "off", "2"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(sb.readJson(sb.configPath).accounts["2"].gpt, undefined);
    r = sb.ccc(["gpt", "on"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Usage: ccc gpt on <number>/);
  });

  test("ccc gpt sync copies public MCP setup without changing profile permissions", () => {
    sb.writeJson(join(sb.home, ".claude.json"), { mcpServers: { fixture: { type: "http", url: "https://mcp.example.com/rpc" } } });
    const file = join(sb.profilesDir, "account6", "settings.json");
    sb.writeJson(file, { theme: "dark", permissions: { deny: ["Bash(rm *)"] } });
    const r = sb.ccc(["gpt", "sync", "1"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ChatGPT account 6: added 0 plugins, 1 public MCP/);
    assert.deepEqual(sb.readJson(file).permissions, { deny: ["Bash(rm *)"] });
    assert.equal(sb.readJson(join(sb.profilesDir, "account6", ".claude.json")).mcpServers.fixture.url, "https://mcp.example.com/rpc");
    assert.equal(sb.ccc(["gpt", "sync"]).status, 1);
    assert.equal(sb.ccc(["gpt", "sync", "1", "extra"]).status, 1);
  });

  test("logging the ChatGPT account out goes to ChatGPT, not Claude Code", () => {
    signOut();
    const before = sb.calls().length;
    const r = sb.ccc(["logout", "6"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ChatGPT was not signed in/);
    assert.equal(sb.calls().length, before, "claude auth must not run for it");
  });

  test("the ChatGPT account will not start signed out", () => {
    signOut();
    const before = sb.calls().length;
    const r = sb.ccc(["6"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ccc gpt login/);
    assert.equal(sb.calls().length, before);
  });

  test("the ChatGPT account starts Claude Code through the router, in its own profile", () => {
    signIn();
    const r = sb.ccc(["6", "-c"]);
    assert.equal(r.status, 0, r.stderr);
    const call = lastCall(sb);
    assert.equal(call.configDir, join(sb.profilesDir, "account6"));
    assert.match(plain(call.args), /^--settings \S+\.json --dangerously-skip-permissions -c$/);
  });

  test("--gpt adds the GPT models to a Claude account for one launch, and never reaches claude", () => {
    signIn();
    const r = sb.ccc(["2", "--gpt", "-c"]);
    assert.equal(r.status, 0, r.stderr);
    const call = lastCall(sb);
    assert.equal(call.configDir, join(sb.profilesDir, "account2"));
    assert.match(plain(call.args), /^--settings \S+\.json --dangerously-skip-permissions -c$/);

    sb.ccc(["2", "-c"]);
    assert.equal(lastCall(sb).args, "--dangerously-skip-permissions -c", "without --gpt, the account starts directly with the same permission default");
  });

  for (const [name, args] of [
    ["GPT", ["6", "--permission-mode", "plan", "-c"]],
    ["mixed", ["2", "--gpt", "--permission-mode", "plan", "-c"]],
  ]) {
    test(`an explicit permission mode survives ${name} routing`, () => {
      signIn();
      const r = sb.ccc(args);
      assert.equal(r.status, 0, r.stderr);
      assert.match(plain(lastCall(sb).args), /^--settings \S+\.json --permission-mode plan -c$/);
    });
  }

  test("an account whose saved default model is a GPT model starts through the router by itself", () => {
    signIn();
    const settings = join(sb.profilesDir, "account2", "settings.json");
    const saved = sb.readJson(settings);
    sb.writeJson(settings, { ...saved, model: "gpt-6.1-sol" });
    try {
      sb.ccc(["2"]);
      assert.match(plain(lastCall(sb).args), /^--settings \S+\.json --dangerously-skip-permissions$/);
    } finally {
      sb.writeJson(settings, saved);
    }
  });

  test("picking the ChatGPT account in the picker starts it the same way", () => {
    signIn();
    const r = sb.ccc([], { input: "6\n", env: { ...sb.env, CCC_NO_USAGE: "1" } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(lastCall(sb).configDir, join(sb.profilesDir, "account6"));
    assert.match(plain(lastCall(sb).args), /^--settings \S+\.json --dangerously-skip-permissions$/);
  });

  test("picking a Claude account with --gpt on the command line works too", () => {
    signIn();
    const r = sb.ccc(["--gpt"], { input: "2\n", env: { ...sb.env, CCC_NO_USAGE: "1" } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(lastCall(sb).configDir, join(sb.profilesDir, "account2"));
    assert.match(plain(lastCall(sb).args), /^--settings \S+\.json --dangerously-skip-permissions$/);
  });
});
