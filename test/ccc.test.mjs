// Integration tests for the bash launcher.
//
// A stub `claude` on PATH records CLAUDE_CONFIG_DIR and its arguments instead of
// launching anything, so these assert the one thing the launcher exists to do:
// hand the right profile directory to the right process.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox } from "./helpers.test.mjs";

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
    assert.equal(lastCall(sb).args, args.join(" "));
  });

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
    test(`ccc add works when HOME is ${JSON.stringify(homeName)}`, () => {
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

    test(`ccc <n> works when HOME is ${JSON.stringify(homeName)}`, () => {
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
      assert.equal(lastCall(sb).args, "--resume");
    } finally {
      sb.cleanup();
    }
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
      rmSync(join(sb.stubs, process.platform === "win32" ? "claude.cmd" : "claude"));

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
