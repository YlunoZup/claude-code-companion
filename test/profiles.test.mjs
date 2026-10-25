// Unit tests for src/profiles.cjs — the module every launcher and installer
// routes its config.json and settings.json work through.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, IS_WINDOWS, REPO_ROOT } from "./helpers.test.mjs";

const require = createRequire(import.meta.url);
const profiles = require(join(REPO_ROOT, "src", "profiles.cjs"));

// The functions below run in this process, not in a sandbox child, so keep them
// away from the real Keychain the same way the sandbox does: the default
// profile's service name does not depend on HOME.
process.env.CCC_NO_KEYCHAIN = "1";

describe("readConfig", () => {
  test("a missing file is the ordinary first-run state, not an error", () => {
    const sb = makeSandbox();
    try {
      const r = profiles.readConfig(join(sb.home, "nope.json"));
      assert.equal(r.status, "missing");
      assert.deepEqual(r.config, { accounts: {} });
    } finally {
      sb.cleanup();
    }
  });

  test("valid config is returned as-is", () => {
    const sb = makeSandbox();
    try {
      const file = join(sb.home, "config.json");
      sb.writeJson(file, { accounts: { 1: { name: "One", configDir: null } } });
      const r = profiles.readConfig(file);
      assert.equal(r.status, "ok");
      assert.equal(r.config.accounts["1"].name, "One");
    } finally {
      sb.cleanup();
    }
  });

  // Every "config.json silently reset itself" report starts here: the old code
  // could not tell a parse failure from an empty file, so it rewrote both.
  test("malformed JSON is reported as invalid, never as empty", () => {
    const sb = makeSandbox();
    try {
      const file = join(sb.home, "config.json");
      for (const bad of ['{"accounts":{"1":{}},}', "{ not json", '{"accounts":', "null", "[]"]) {
        writeFileSync(file, bad);
        const r = profiles.readConfig(file);
        assert.equal(r.status, "invalid", `should reject: ${bad}`);
        assert.ok(r.error instanceof Error);
      }
    } finally {
      sb.cleanup();
    }
  });

  test("a UTF-8 BOM does not make valid config look corrupt", () => {
    const sb = makeSandbox();
    try {
      const file = join(sb.home, "config.json");
      writeFileSync(file, "\uFEFF" + JSON.stringify({ accounts: { 2: { name: "Two" } } }));
      const r = profiles.readConfig(file);
      assert.equal(r.status, "ok");
      assert.equal(r.config.accounts["2"].name, "Two");
    } finally {
      sb.cleanup();
    }
  });

  test("a config with no accounts key gets an empty one", () => {
    const sb = makeSandbox();
    try {
      const file = join(sb.home, "config.json");
      sb.writeJson(file, { somethingElse: true });
      const r = profiles.readConfig(file);
      assert.equal(r.status, "ok");
      assert.deepEqual(r.config.accounts, {});
    } finally {
      sb.cleanup();
    }
  });

  test("accounts of the wrong type is invalid, not silently coerced", () => {
    const sb = makeSandbox();
    try {
      const file = join(sb.home, "config.json");
      sb.writeJson(file, { accounts: ["one", "two"] });
      assert.equal(profiles.readConfig(file).status, "invalid");
    } finally {
      sb.cleanup();
    }
  });
});

describe("nextAccountNumber", () => {
  test("starts at 1 with no accounts", () => {
    assert.equal(profiles.nextAccountNumber({ accounts: {} }), 1);
    assert.equal(profiles.nextAccountNumber({}), 1);
  });

  test("takes the highest slot plus one, gaps included", () => {
    assert.equal(profiles.nextAccountNumber({ accounts: { 1: {}, 2: {}, 3: {} } }), 4);
    assert.equal(profiles.nextAccountNumber({ accounts: { 1: {}, 7: {} } }), 8);
  });

  test("ignores non-numeric keys rather than throwing", () => {
    assert.equal(profiles.nextAccountNumber({ accounts: { 1: {}, work: {}, 2: {} } }), 3);
  });

  test("keeps counting past 9 — string keys must not sort lexically", () => {
    const accounts = {};
    for (let i = 1; i <= 10; i++) accounts[i] = { name: `A${i}` };
    assert.equal(profiles.nextAccountNumber({ accounts }), 11);
  });
});

describe("resolveAccount", () => {
  const PROFILES = IS_WINDOWS ? "C:\\p" : "/p";

  test("an entry with a configDir resolves to that directory", () => {
    const config = { accounts: { 2: { name: "Two", configDir: "account2" } } };
    const r = profiles.resolveAccount(config, "2", PROFILES);
    assert.equal(r.kind, "profile");
    assert.equal(r.dir, join(PROFILES, "account2"));
  });

  test("an entry with configDir null is the default ~/.claude profile", () => {
    const config = { accounts: { 1: { name: "One", configDir: null } } };
    assert.equal(profiles.resolveAccount(config, "1", PROFILES).kind, "default");
  });

  // The launchers used to hardcode this on Windows and read config.json on
  // macOS, so the same config.json launched different accounts per platform.
  test("config.json wins over the slot-1-is-default convention", () => {
    const config = { accounts: { 1: { name: "One", configDir: "work" } } };
    const r = profiles.resolveAccount(config, "1", PROFILES);
    assert.equal(r.kind, "profile");
    assert.equal(r.dir, join(PROFILES, "work"));
  });

  test("an unconfigured slot 1 is the default profile", () => {
    assert.equal(profiles.resolveAccount({ accounts: {} }, "1", PROFILES).kind, "default");
  });

  test("any other unconfigured slot follows the accountN convention", () => {
    const r = profiles.resolveAccount({ accounts: {} }, "9", PROFILES);
    assert.equal(r.dir, join(PROFILES, "account9"));
    assert.equal(r.configured, false);
  });
});

describe("statusLineCommand", () => {
  test("the path is quoted, so a home directory with a space survives", () => {
    const cmd = profiles.statusLineCommand("/Users/John Smith/.claude-profiles", "darwin");
    assert.equal(cmd, 'node "/Users/John Smith/.claude-profiles/statusline.js"');
  });

  test("shell metacharacters in the path are escaped on POSIX", () => {
    const cmd = profiles.quoteForShell("/home/a$b`c\"d", "linux");
    assert.equal(cmd, '"/home/a\\$b\\`c\\"d"');
  });

  test("Windows paths are quoted but not backslash-escaped", () => {
    const cmd = profiles.statusLineCommand("C:\\Users\\John Smith\\.claude-profiles", "win32");
    assert.equal(cmd, 'node "C:/Users/John Smith/.claude-profiles/statusline.js"');
  });

  // The point of the quoting is that a shell can run the result. Prove it does,
  // rather than asserting on the string alone.
  test("the generated command actually runs through a shell", { skip: IS_WINDOWS }, () => {
    const sb = makeSandbox({ homeName: "it's a home" });
    try {
      const dir = join(sb.home, ".claude-profiles");
      mkdirSync(dir, { recursive: true });
      // Stand in for the real statusline so we can see it was reached.
      writeFileSync(join(dir, "statusline.js"), 'process.stdout.write("REACHED");\n');

      const cmd = profiles.statusLineCommand(dir, "darwin");
      const r = spawnSync("sh", ["-c", cmd], { env: sb.env, encoding: "utf8" });

      assert.equal(r.status, 0, `command failed: ${cmd}\n${r.stderr}`);
      assert.equal(r.stdout, "REACHED");
    } finally {
      sb.cleanup();
    }
  });
});

describe("applyStatusLine", () => {
  test("creates settings.json when there is none", () => {
    const sb = makeSandbox();
    try {
      const file = join(sb.home, "settings.json");
      const r = profiles.applyStatusLine(file, sb.profilesDir);
      assert.equal(r.status, "created");
      assert.equal(sb.readJson(file).statusLine.type, "command");
    } finally {
      sb.cleanup();
    }
  });

  // The installer is documented as re-runnable. It must not cost the user their
  // theme, permissions and hooks to run it twice.
  test("merges into an existing file and preserves every other key", () => {
    const sb = makeSandbox();
    try {
      const file = join(sb.home, "settings.json");
      sb.writeJson(file, {
        theme: "dark",
        model: "opus",
        permissions: { allow: ["Bash"] },
        hooks: { PreToolUse: [] },
        statusLine: { type: "command", command: "something-else" },
      });

      assert.equal(profiles.applyStatusLine(file, sb.profilesDir).status, "updated");

      const after = sb.readJson(file);
      assert.equal(after.theme, "dark");
      assert.equal(after.model, "opus");
      assert.deepEqual(after.permissions, { allow: ["Bash"] });
      assert.deepEqual(after.hooks, { PreToolUse: [] });
      assert.match(after.statusLine.command, /statusline\.js/);
    } finally {
      sb.cleanup();
    }
  });

  test("refuses to write over a settings.json it could not parse", () => {
    const sb = makeSandbox();
    try {
      const file = join(sb.home, "settings.json");
      const original = '{ "theme": "dark", // a comment\n  "model": "opus" }';
      writeFileSync(file, original);

      const r = profiles.applyStatusLine(file, sb.profilesDir);
      assert.equal(r.status, "invalid");
      assert.equal(readFileSync(file, "utf8"), original, "the file must be left byte-identical");
    } finally {
      sb.cleanup();
    }
  });

  test("a settings.json holding literal null is refused, not crashed on", () => {
    const sb = makeSandbox();
    try {
      const file = join(sb.home, "settings.json");
      writeFileSync(file, "null");
      assert.equal(profiles.applyStatusLine(file, sb.profilesDir).status, "invalid");
      assert.equal(readFileSync(file, "utf8"), "null");
    } finally {
      sb.cleanup();
    }
  });
});

describe("statusLineScript", () => {
  test("finds the script in the quoted form statusLineCommand writes", () => {
    const cmd = profiles.statusLineCommand("/Users/John Smith/.claude-profiles", "darwin");
    assert.equal(
      profiles.statusLineScript(cmd, "darwin"),
      "/Users/John Smith/.claude-profiles/statusline.js"
    );
  });

  test("finds it in the bare form earlier versions wrote", () => {
    assert.equal(
      profiles.statusLineScript("node /Users/me/.claude-profiles/statusline.js", "darwin"),
      "/Users/me/.claude-profiles/statusline.js"
    );
  });

  test("undoes the escaping quoteForShell applies on POSIX", () => {
    const dir = '/home/a$b`c"d/.claude-profiles';
    const cmd = profiles.statusLineCommand(dir, "linux");
    assert.equal(profiles.statusLineScript(cmd, "linux"), `${dir}/statusline.js`);

    // An escaped backslash, which the shell reads as a single one.
    assert.equal(
      profiles.statusLineScript('node "/home/x\\\\y/.claude-profiles/statusline.js"', "linux"),
      "/home/x\\y/.claude-profiles/statusline.js"
    );
  });

  test("single quotes group on POSIX", () => {
    assert.equal(
      profiles.statusLineScript("node '/Users/it is me/.claude-profiles/old.mjs' --flag", "darwin"),
      "/Users/it is me/.claude-profiles/old.mjs"
    );
  });

  test("Windows: the forward-slash form statusLineCommand writes", () => {
    const cmd = profiles.statusLineCommand("C:\\Users\\John Smith\\.claude-profiles", "win32");
    assert.equal(
      profiles.statusLineScript(cmd, "win32"),
      "C:/Users/John Smith/.claude-profiles/statusline.js"
    );
  });

  // To cmd.exe a backslash is a path separator, not an escape character.
  test("Windows: backslashes survive as path separators", () => {
    assert.equal(
      profiles.statusLineScript('node "C:\\Users\\me\\.claude-profiles\\statusline.js"', "win32"),
      "C:\\Users\\me\\.claude-profiles\\statusline.js"
    );
  });

  test("a command that runs something else is not ours", () => {
    assert.equal(profiles.statusLineScript("npx -y ccstatusline@latest", "darwin"), null);
    assert.equal(profiles.statusLineScript("node /Users/me/.claude/statusline.js", "darwin"), null);
  });

  // If we cannot tell whether the script exists, we must never decide it is
  // gone and overwrite the user's choice.
  test("a path only the shell could finish is not ours to judge", () => {
    for (const cmd of [
      "node ~/.claude-profiles/statusline.js",
      "node $HOME/.claude-profiles/statusline.js",
      'node "${HOME}/.claude-profiles/statusline.js"',
      "node relative/.claude-profiles/statusline.js",
    ]) {
      assert.equal(profiles.statusLineScript(cmd, "darwin"), null, cmd);
    }
    assert.equal(
      profiles.statusLineScript('node "%USERPROFILE%\\.claude-profiles\\statusline.js"', "win32"),
      null
    );
  });
});

describe("ensureStatusLine", () => {
  // The file plus a statusline.js for "ours" to point at.
  function setup(sb, settings) {
    mkdirSync(sb.profilesDir, { recursive: true });
    writeFileSync(join(sb.profilesDir, "statusline.js"), "");
    const file = join(sb.profilesDir, "account2", "settings.json");
    if (settings !== undefined) sb.writeJson(file, settings);
    return file;
  }

  test("creates settings.json when there is none", () => {
    const sb = makeSandbox();
    try {
      const file = setup(sb);
      assert.equal(profiles.ensureStatusLine(file, sb.profilesDir).status, "created");
      assert.match(sb.readJson(file).statusLine.command, /statusline\.js/);
    } finally {
      sb.cleanup();
    }
  });

  // A profile created by logging in for the first time has a settings.json
  // that Claude Code wrote, with no statusLine key in it.
  test("adds the key to a settings.json that has none, keeping every other key", () => {
    const sb = makeSandbox();
    try {
      const file = setup(sb, { theme: "dark", permissions: { allow: ["Read"] } });
      assert.equal(profiles.ensureStatusLine(file, sb.profilesDir).status, "added");

      const after = sb.readJson(file);
      assert.equal(after.theme, "dark");
      assert.deepEqual(after.permissions, { allow: ["Read"] });
      assert.equal(after.statusLine.command, profiles.statusLineCommand(sb.profilesDir));
    } finally {
      sb.cleanup();
    }
  });

  test("leaves a statusLine that already runs ours untouched", () => {
    const sb = makeSandbox();
    try {
      // The unquoted form an earlier version wrote still counts.
      const command = `node ${join(sb.profilesDir, "statusline.js")}`;
      const file = setup(sb, { statusLine: { type: "command", command } });
      const before = readFileSync(file, "utf8");

      assert.equal(profiles.ensureStatusLine(file, sb.profilesDir).status, "current");
      assert.equal(readFileSync(file, "utf8"), before, "must not be rewritten");
    } finally {
      sb.cleanup();
    }
  });

  test("leaves somebody else's statusline alone", () => {
    const sb = makeSandbox();
    try {
      for (const statusLine of [
        { type: "command", command: "npx -y ccstatusline@latest" },
        { type: "static", text: "hello" },
      ]) {
        const file = setup(sb, { statusLine });
        const before = readFileSync(file, "utf8");
        assert.equal(profiles.ensureStatusLine(file, sb.profilesDir).status, "custom");
        assert.equal(readFileSync(file, "utf8"), before);
      }
    } finally {
      sb.cleanup();
    }
  });

  // Writing the same path back would change nothing; the installer is what
  // brings a missing statusline.js back.
  test("a statusLine running statusline.js stays put even while that file is missing", () => {
    const sb = makeSandbox();
    try {
      const file = setup(sb, { statusLine: { type: "command", command: profiles.statusLineCommand(sb.profilesDir) } });
      rmSync(join(sb.profilesDir, "statusline.js"));
      const before = readFileSync(file, "utf8");

      assert.equal(profiles.ensureStatusLine(file, sb.profilesDir).status, "current");
      assert.equal(readFileSync(file, "utf8"), before);
    } finally {
      sb.cleanup();
    }
  });

  // What renaming or consolidating the statusline scripts leaves behind.
  test("repoints a statusLine whose .claude-profiles script is gone", () => {
    const sb = makeSandbox();
    try {
      const stale = profiles.statusLineCommand(sb.profilesDir).replace("statusline.js", "old.js");
      const file = setup(sb, { theme: "dark", statusLine: { type: "command", command: stale } });

      assert.equal(profiles.ensureStatusLine(file, sb.profilesDir).status, "repointed");
      const after = sb.readJson(file);
      assert.equal(after.statusLine.command, profiles.statusLineCommand(sb.profilesDir));
      assert.equal(after.theme, "dark");
    } finally {
      sb.cleanup();
    }
  });

  test("never writes over a settings.json it could not parse", () => {
    const sb = makeSandbox();
    try {
      const file = setup(sb);
      mkdirSync(join(sb.profilesDir, "account2"), { recursive: true });
      const original = '{ "theme": "dark", // a comment\n }';
      writeFileSync(file, original);

      assert.equal(profiles.ensureStatusLine(file, sb.profilesDir).status, "invalid");
      assert.equal(readFileSync(file, "utf8"), original);
    } finally {
      sb.cleanup();
    }
  });
});

describe("writeJsonAtomic", () => {
  test("leaves no temp file behind", () => {
    const sb = makeSandbox();
    try {
      const file = join(sb.home, "out.json");
      profiles.writeJsonAtomic(file, { a: 1 });
      assert.deepEqual(sb.readJson(file), { a: 1 });
      const strays = readdirSync(sb.home).filter((f) => f.includes(".tmp"));
      assert.deepEqual(strays, []);
    } finally {
      sb.cleanup();
    }
  });
});

describe("ensureLink", () => {
  test("links a directory that is not there yet", () => {
    const sb = makeSandbox();
    try {
      const target = join(sb.home, "target");
      const link = join(sb.home, "link");
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "marker.txt"), "hello");

      assert.equal(profiles.ensureLink(link, target).status, "linked");
      assert.equal(readFileSync(join(link, "marker.txt"), "utf8"), "hello");
    } finally {
      sb.cleanup();
    }
  });

  // This is the data-loss guard. A real projects directory holds that account's
  // session transcripts; replacing it with a link destroys them.
  test("never replaces a real directory that is already there", () => {
    const sb = makeSandbox();
    try {
      const target = join(sb.home, "target");
      const link = join(sb.home, "link");
      mkdirSync(target, { recursive: true });
      mkdirSync(link, { recursive: true });
      writeFileSync(join(link, "precious.txt"), "session history");

      assert.equal(
        profiles.ensureLink(link, target).status,
        "exists",
        "a real directory must be reported as blocking, not as an existing link"
      );
      assert.equal(readFileSync(join(link, "precious.txt"), "utf8"), "session history");
    } finally {
      sb.cleanup();
    }
  });

  test("never replaces a dangling symlink either", { skip: IS_WINDOWS }, () => {
    const sb = makeSandbox();
    try {
      const target = join(sb.home, "target");
      const link = join(sb.home, "link");
      mkdirSync(target, { recursive: true });
      symlinkSync(join(sb.home, "gone"), link);

      assert.equal(profiles.ensureLink(link, target).status, "already-linked");
    } finally {
      sb.cleanup();
    }
  });

  test("reports no-target when there is nothing to link to", () => {
    const sb = makeSandbox();
    try {
      const r = profiles.ensureLink(join(sb.home, "link"), join(sb.home, "missing"));
      assert.equal(r.status, "no-target");
      assert.equal(existsSync(join(sb.home, "link")), false);
    } finally {
      sb.cleanup();
    }
  });
});

describe("ensureSharedProjects", () => {
  test("creates the profile, the shared target and the link", () => {
    const sb = makeSandbox();
    try {
      const profileDir = join(sb.profilesDir, "account3");
      const r = profiles.ensureSharedProjects(profileDir, sb.claudeDir);

      assert.equal(r.status, "linked");
      assert.ok(existsSync(join(sb.claudeDir, "projects")));
      writeFileSync(join(sb.claudeDir, "projects", "shared.txt"), "x");
      assert.ok(existsSync(join(profileDir, "projects", "shared.txt")), "the link must resolve");
    } finally {
      sb.cleanup();
    }
  });

  test("is idempotent", () => {
    const sb = makeSandbox();
    try {
      const profileDir = join(sb.profilesDir, "account3");
      assert.equal(profiles.ensureSharedProjects(profileDir, sb.claudeDir).status, "linked");
      assert.equal(profiles.ensureSharedProjects(profileDir, sb.claudeDir).status, "already-linked");
    } finally {
      sb.cleanup();
    }
  });
});

describe("keychainService", () => {
  test("the default profile uses the bare service name", () => {
    assert.equal(profiles.keychainService("/anything", true), "Claude Code-credentials");
  });

  // Pinned because README and picker.mjs document this example, and because the
  // value in those comments was wrong before this suite existed.
  test("other profiles append sha256(dir)[0:8]", () => {
    assert.equal(
      profiles.keychainService("/Users/you/.claude-profiles/account2", false),
      "Claude Code-credentials-04f595a6"
    );
  });

  test("the hash is taken over the exact path string it is given", () => {
    const a = profiles.keychainService("/p/account2", false);
    const b = profiles.keychainService("/p/./account2", false);
    assert.notEqual(a, b, "an uncanonical path is a different Keychain entry");
  });
});

describe("addAccount", () => {
  test("adds a slot, creates the directory and configures the statusline", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, {
        accounts: { 1: { name: "One", configDir: null }, 2: { name: "Two", configDir: "account2" } },
      });

      const r = profiles.addAccount({ home: sb.home, key: 3, name: "Client Work" });
      assert.equal(r.status, "ok");

      const config = sb.readJson(sb.configPath);
      assert.equal(config.accounts["3"].name, "Client Work");
      assert.equal(config.accounts["3"].configDir, "account3");
      assert.equal(config.accounts["1"].configDir, null, "existing slots must survive");
      assert.equal(config.accounts["2"].name, "Two");

      const settings = sb.readJson(join(sb.profilesDir, "account3", "settings.json"));
      assert.match(settings.statusLine.command, /statusline\.js/);
    } finally {
      sb.cleanup();
    }
  });

  // Landing on a directory that already exists must not cost the user the
  // settings they put there.
  test("merges into a settings.json that is already in the profile directory", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: {} });
      sb.writeJson(join(sb.profilesDir, "account1", "settings.json"), {
        theme: "light",
        permissions: { allow: ["Read"] },
      });

      profiles.addAccount({ home: sb.home, key: 1, name: "Reused" });

      const settings = sb.readJson(join(sb.profilesDir, "account1", "settings.json"));
      assert.equal(settings.theme, "light");
      assert.deepEqual(settings.permissions, { allow: ["Read"] });
      assert.match(settings.statusLine.command, /statusline\.js/);
    } finally {
      sb.cleanup();
    }
  });

  test("refuses to rewrite a config.json it could not parse", () => {
    const sb = makeSandbox();
    try {
      mkdirSync(sb.profilesDir, { recursive: true });
      const original = '{"accounts":{"1":{"name":"One"},}}';
      writeFileSync(sb.configPath, original);

      const r = profiles.addAccount({ home: sb.home, key: 2, name: "Two" });
      assert.equal(r.status, "invalid");
      assert.equal(readFileSync(sb.configPath, "utf8"), original, "config must be untouched");
    } finally {
      sb.cleanup();
    }
  });

  test("a name containing quotes and backslashes is stored verbatim", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: {} });
      const nasty = `He said "hi" \\ 'bye' $HOME \`tick\``;
      profiles.addAccount({ home: sb.home, key: 1, name: nasty });
      assert.equal(sb.readJson(sb.configPath).accounts["1"].name, nasty);
    } finally {
      sb.cleanup();
    }
  });
});

describe("accountNameFor", () => {
  const config = {
    accounts: {
      1: { name: "Personal", configDir: null },
      2: { name: "Work", configDir: "account2" },
    },
  };

  test("finds the default profile by its null configDir", () => {
    assert.equal(profiles.accountNameFor(config, null), "Personal");
  });

  test("finds a named profile by directory name", () => {
    assert.equal(profiles.accountNameFor(config, "account2"), "Work");
  });

  test("returns null when nothing matches", () => {
    assert.equal(profiles.accountNameFor(config, "account9"), null);
  });
});

describe("accountState", () => {
  test("a profile with .credentials.json is signed in, as whoever .claude.json says", () => {
    const sb = makeSandbox();
    try {
      sb.signIn("account2", { email: "work@example.com", accountUuid: "u-2", tier: "default_claude_max_20x" });
      const state = profiles.accountState("account2", { home: sb.home });
      assert.equal(state.signedIn, true);
      assert.equal(state.email, "work@example.com");
      assert.equal(state.accountUuid, "u-2");
      assert.equal(state.tier, "default_claude_max_20x");
      assert.equal(state.dir, join(sb.profilesDir, "account2"));
    } finally {
      sb.cleanup();
    }
  });

  // Claude Code keeps the default profile's .claude.json in the home directory,
  // not inside ~/.claude.
  test("the default profile's identity comes from ~/.claude.json", () => {
    const sb = makeSandbox();
    try {
      sb.signIn(null, { email: "me@example.com" });
      const state = profiles.accountState(null, { home: sb.home });
      assert.equal(state.isDefault, true);
      assert.equal(state.email, "me@example.com");
      assert.equal(state.dir, join(sb.home, ".claude"));
    } finally {
      sb.cleanup();
    }
  });

  test("no credentials anywhere is signed out, even with an identity left over", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(join(sb.profilesDir, "account2", ".claude.json"), { oauthAccount: { emailAddress: "old@example.com" } });
      assert.equal(profiles.accountState("account2", { home: sb.home }).signedIn, false);
    } finally {
      sb.cleanup();
    }
  });
});

describe("renameAccount", () => {
  test("changes only the name", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: { 2: { name: "Old", configDir: "account2" } } });
      const r = profiles.renameAccount({ home: sb.home, key: 2, name: `Client "A" & B` });
      assert.equal(r.status, "ok");
      assert.deepEqual(sb.readJson(sb.configPath).accounts["2"], { name: `Client "A" & B`, configDir: "account2" });
    } finally {
      sb.cleanup();
    }
  });

  test("an account that is not there is reported, and nothing is written", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: { 2: { name: "Two", configDir: "account2" } } });
      const before = readFileSync(sb.configPath, "utf8");
      assert.equal(profiles.renameAccount({ home: sb.home, key: 9, name: "X" }).status, "no-account");
      assert.equal(readFileSync(sb.configPath, "utf8"), before);
    } finally {
      sb.cleanup();
    }
  });

  test("refuses to rewrite a config.json it could not parse", () => {
    const sb = makeSandbox();
    try {
      mkdirSync(sb.profilesDir, { recursive: true });
      writeFileSync(sb.configPath, '{"accounts":{"2":{}},}');
      assert.equal(profiles.renameAccount({ home: sb.home, key: 2, name: "X" }).status, "invalid");
      assert.equal(readFileSync(sb.configPath, "utf8"), '{"accounts":{"2":{}},}');
    } finally {
      sb.cleanup();
    }
  });
});

describe("removeAccount", () => {
  test("takes the slot off the list and leaves its folder alone", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, {
        accounts: { 1: { name: "One", configDir: null }, 2: { name: "Two", configDir: "account2" } },
      });
      sb.writeJson(join(sb.profilesDir, "account2", "settings.json"), { theme: "dark" });

      const r = profiles.removeAccount({ home: sb.home, key: 2 });

      assert.equal(r.status, "ok");
      assert.equal(r.dir, join(sb.profilesDir, "account2"));
      assert.deepEqual(Object.keys(sb.readJson(sb.configPath).accounts), ["1"]);
      assert.ok(existsSync(join(sb.profilesDir, "account2", "settings.json")), "its files must be kept");
    } finally {
      sb.cleanup();
    }
  });

  test("an account that is not there is reported", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: {} });
      assert.equal(profiles.removeAccount({ home: sb.home, key: 4 }).status, "no-account");
    } finally {
      sb.cleanup();
    }
  });
});

describe("repairAccount", () => {
  const levels = (findings) => findings.map((f) => f.level);

  test("creates the folder, links the history and adds the statusline", () => {
    const sb = makeSandbox();
    try {
      mkdirSync(sb.claudeDir, { recursive: true });
      const { findings } = profiles.repairAccount("4", { name: "Four", configDir: "account4" }, { home: sb.home });

      const dir = join(sb.profilesDir, "account4");
      assert.ok(existsSync(join(dir, "projects")), "projects should be linked");
      assert.match(sb.readJson(join(dir, "settings.json")).statusLine.command, /statusline\.js/);
      assert.deepEqual(levels(findings), ["fixed", "fixed", "fixed", "todo"]);
      assert.match(findings[3].text, /not signed in — run: ccc login 4/);
    } finally {
      sb.cleanup();
    }
  });

  test("a signed-in account that is already set up is all ok, and nothing changes", () => {
    const sb = makeSandbox();
    try {
      const entry = { name: "Two", configDir: "account2" };
      profiles.repairAccount("2", entry, { home: sb.home });
      sb.signIn("account2", { email: "two@example.com" });
      const settings = readFileSync(join(sb.profilesDir, "account2", "settings.json"), "utf8");

      const { findings } = profiles.repairAccount("2", entry, { home: sb.home });

      assert.deepEqual(levels(findings), ["ok", "ok", "ok"]);
      assert.match(findings[2].text, /signed in as two@example\.com/);
      assert.equal(readFileSync(join(sb.profilesDir, "account2", "settings.json"), "utf8"), settings);
    } finally {
      sb.cleanup();
    }
  });

  test("a slot signed into the same Claude account as an earlier one is pointed out", () => {
    const sb = makeSandbox();
    try {
      sb.signIn("account2", { email: "me@example.com", accountUuid: "same" });
      sb.signIn("account3", { email: "me@example.com", accountUuid: "same" });
      const earlier = [{ ...profiles.accountState("account2", { home: sb.home }), key: "2" }];

      const { findings } = profiles.repairAccount("3", { configDir: "account3" }, { home: sb.home, earlier });

      const twin = findings.find((f) => /same Claude account/.test(f.text));
      assert.ok(twin, "expected the duplicate to be reported");
      assert.equal(twin.level, "todo");
      assert.match(twin.text, /\[2\].*ccc login 3/);
    } finally {
      sb.cleanup();
    }
  });

  test("never rewrites a settings.json it cannot parse, or a real projects folder", () => {
    const sb = makeSandbox();
    try {
      const dir = join(sb.profilesDir, "account2");
      mkdirSync(join(dir, "projects"), { recursive: true });
      writeFileSync(join(dir, "projects", "keep.txt"), "history");
      writeFileSync(join(dir, "settings.json"), '{ "theme": "dark", }');

      const { findings } = profiles.repairAccount("2", { configDir: "account2" }, { home: sb.home });

      assert.equal(readFileSync(join(dir, "settings.json"), "utf8"), '{ "theme": "dark", }');
      assert.equal(readFileSync(join(dir, "projects", "keep.txt"), "utf8"), "history");
      assert.ok(findings.some((f) => f.level === "todo" && /does not parse/.test(f.text)));
      assert.ok(findings.some((f) => f.level === "todo" && /projects folder of its own/.test(f.text)));
    } finally {
      sb.cleanup();
    }
  });
});

describe("the CLI's user-facing commands", () => {
  test("help lists every command", () => {
    const sb = makeSandbox();
    try {
      const r = sb.node("src/profiles.cjs", ["help"]);
      assert.equal(r.status, 0);
      for (const cmd of ["ccc list", "ccc add", "ccc login <n>", "ccc logout <n>", "ccc rename", "ccc remove", "ccc repair", "ccc help"]) {
        assert.ok(r.stdout.includes(cmd), `help should mention ${cmd}`);
      }
    } finally {
      sb.cleanup();
    }
  });

  test("repair exits 0 when nothing needs the user, 1 when something does", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      sb.writeJson(sb.configPath, { accounts: { 2: { name: "Two", configDir: "account2" } } });

      const first = sb.node("src/profiles.cjs", ["repair"]);
      assert.equal(first.status, 1, first.stdout);
      assert.match(first.stdout, /\[2\] Two/);
      assert.match(first.stdout, /! not signed in — run: ccc login 2/);

      sb.signIn("account2", { email: "two@example.com" });
      const second = sb.node("src/profiles.cjs", ["repair"]);
      assert.equal(second.status, 0, second.stdout);
      assert.match(second.stdout, /Everything is in order/);
    } finally {
      sb.cleanup();
    }
  });

  test("repair of one slot checks only that slot", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      const r = sb.node("src/profiles.cjs", ["repair", "2"]);
      assert.match(r.stdout, /\[2\]/);
      assert.doesNotMatch(r.stdout, /\[1\]|\[3\]/);
    } finally {
      sb.cleanup();
    }
  });

  test("repair stops at a config.json it cannot read", () => {
    const sb = makeSandbox();
    try {
      mkdirSync(sb.profilesDir, { recursive: true });
      writeFileSync(sb.configPath, "{ nope");
      const r = sb.node("src/profiles.cjs", ["repair"]);
      assert.equal(r.status, 2);
      assert.equal(readFileSync(sb.configPath, "utf8"), "{ nope");
    } finally {
      sb.cleanup();
    }
  });
});

// ── The ChatGPT account ──────────────────────────────────────

// A ChatGPT sign-in as chatgpt.cjs saves it, without any network.
function chatgptSignIn(sb, { planUsage = true } = {}) {
  sb.writeJson(join(sb.profilesDir, "chatgpt", "auth.json"), {
    client_id: "oaiapp_test",
    account: { email: "me@example.com" },
    access_token: "a",
    refresh_token: "r",
    scope: "openid",
    plan_usage: planUsage,
    expires_at: Date.now() + 3600000,
  });
}

describe("ensureGptAccount", () => {
  test("adds the ChatGPT account in the next free slot, set up like any other", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: { 1: { name: "One", configDir: null }, 2: { name: "Two", configDir: "account2" } } });
      const r = profiles.ensureGptAccount({ home: sb.home, name: "ChatGPT" });
      assert.deepEqual([r.status, r.key, r.created], ["ok", "3", true]);
      assert.deepEqual(sb.readJson(sb.configPath).accounts["3"], { name: "ChatGPT", configDir: "account3", provider: "chatgpt" });
      assert.ok(sb.readJson(join(sb.profilesDir, "account3", "settings.json")).statusLine, "it gets the statusline");
      assert.ok(existsSync(join(sb.profilesDir, "account3", "projects")), "and the shared history");
    } finally {
      sb.cleanup();
    }
  });

  test("is found again rather than added twice", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: { 1: { name: "One", configDir: null }, 4: { name: "Mine", configDir: "account4", provider: "chatgpt" } } });
      const r = profiles.ensureGptAccount({ home: sb.home, name: "ChatGPT" });
      assert.deepEqual([r.key, r.name, r.created], ["4", "Mine", false]);
      assert.equal(Object.keys(sb.readJson(sb.configPath).accounts).length, 2);
    } finally {
      sb.cleanup();
    }
  });

  test("refuses to rewrite a config.json it could not parse", () => {
    const sb = makeSandbox();
    try {
      mkdirSync(sb.profilesDir, { recursive: true });
      writeFileSync(sb.configPath, "{ broken");
      assert.equal(profiles.ensureGptAccount({ home: sb.home }).status, "invalid");
      assert.equal(readFileSync(sb.configPath, "utf8"), "{ broken");
    } finally {
      sb.cleanup();
    }
  });
});

describe("syncGptWorkflow", () => {
  function setup(sb) {
    const targetDir = join(sb.profilesDir, "account6");
    const pluginDir = join(sb.claudeDir, "plugins", "cache", "formatter");
    mkdirSync(pluginDir, { recursive: true });
    sb.writeJson(sb.configPath, { accounts: { 1: { name: "Claude", configDir: null }, 6: { name: "ChatGPT", configDir: "account6", provider: "chatgpt" } } });
    sb.writeJson(join(sb.claudeDir, "settings.json"), {
      enabledPlugins: { "formatter@official": true },
      pluginConfigs: { "formatter@official": { options: { style: "compact" }, mcpServers: { private: { apiKey: "SOURCE-SECRET" } } } },
      permissions: { defaultMode: "bypassPermissions" },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "do-not-copy" }] }] },
      env: { PRIVATE_TOKEN: "SOURCE-SECRET" }, model: "opus", statusLine: { command: "source-line" },
    });
    sb.writeJson(join(sb.claudeDir, "plugins", "installed_plugins.json"), { version: 2, plugins: { "formatter@official": [{ scope: "user", installPath: pluginDir, version: "1.0" }] } });
    sb.writeJson(join(sb.claudeDir, "plugins", "known_marketplaces.json"), { official: { source: { source: "github", repo: "example/plugins" }, installLocation: join(sb.claudeDir, "plugins", "marketplaces", "official") } });
    sb.writeJson(join(sb.home, ".claude.json"), {
      oauthAccount: { emailAddress: "SOURCE-IDENTITY" },
      mcpServers: { public: { type: "http", url: "https://mcp.example.com/rpc", oauth: { clientId: "public-client", callbackPort: 1456 } } },
    });
    sb.writeJson(join(sb.claudeDir, ".credentials.json"), { token: "SOURCE-SECRET" });
    sb.writeJson(join(targetDir, "settings.json"), { theme: "light", permissions: { deny: ["Bash(rm *)"] }, statusLine: { command: "target-line" } });
    sb.writeJson(join(targetDir, ".claude.json"), { oauthAccount: { emailAddress: "TARGET-IDENTITY" }, hasCompletedOnboarding: true });
    return { targetDir, pluginDir, sync: () => profiles.syncGptWorkflow({ home: sb.home, sourceKey: "1" }) };
  }

  test("copies local plugins and public MCP configuration, not logins or permissions", () => {
    const sb = makeSandbox();
    try {
      const { targetDir, pluginDir, sync } = setup(sb);
      const r = sync();
      assert.equal(r.status, "ok");
      assert.deepEqual(r.plugins, ["formatter@official"]);
      assert.deepEqual(r.servers, ["public"]);
      const s = sb.readJson(join(targetDir, "settings.json"));
      assert.deepEqual(s.enabledPlugins, { "formatter@official": true });
      assert.deepEqual(s.pluginConfigs, { "formatter@official": { options: { style: "compact" } } });
      assert.deepEqual(s.permissions, { deny: ["Bash(rm *)"] });
      assert.deepEqual(s.statusLine, { command: "target-line" });
      assert.equal(s.hooks, undefined);
      assert.equal(s.env, undefined);
      assert.equal(s.model, undefined);
      assert.equal(existsSync(join(targetDir, ".credentials.json")), false);
      const state = sb.readJson(join(targetDir, ".claude.json"));
      assert.equal(state.oauthAccount.emailAddress, "TARGET-IDENTITY");
      assert.equal(state.hasCompletedOnboarding, true);
      assert.deepEqual(state.mcpServers.public.oauth, { clientId: "public-client", callbackPort: 1456 });
      const registry = sb.readJson(join(targetDir, "plugins", "installed_plugins.json"));
      assert.equal(registry.plugins["formatter@official"][0].installPath, pluginDir);
      assert.equal(JSON.stringify([s, state, registry]).includes("SOURCE-SECRET"), false);
      assert.equal(sync().plugins.length, 0);
    } finally { sb.cleanup(); }
  });

  test("existing plugin disables, server choices, and registry entries win", () => {
    const sb = makeSandbox();
    try {
      const { targetDir, sync } = setup(sb);
      const file = join(targetDir, "settings.json");
      sb.writeJson(file, { ...sb.readJson(file), enabledPlugins: { "formatter@official": false } });
      const stateFile = join(targetDir, ".claude.json");
      const server = { type: "http", url: "https://own.example.com/rpc" };
      sb.writeJson(stateFile, { ...sb.readJson(stateFile), mcpServers: { public: server } });
      assert.deepEqual(sync().plugins, []);
      assert.equal(sb.readJson(file).enabledPlugins["formatter@official"], false);
      assert.deepEqual(sb.readJson(stateFile).mcpServers.public, server);
      assert.equal(existsSync(join(targetDir, "plugins", "installed_plugins.json")), false);
    } finally { sb.cleanup(); }
  });

  test("servers with inline credentials or executable arguments require manual setup", () => {
    const sb = makeSandbox();
    try {
      const { targetDir, sync } = setup(sb);
      const file = join(sb.home, ".claude.json");
      sb.writeJson(file, { ...sb.readJson(file), mcpServers: {
        privateHeader: { type: "http", url: "https://mcp.example.com/rpc", headers: { Authorization: "SECRET" } },
        privateQuery: { type: "sse", url: "https://mcp.example.com/sse?key=SECRET" },
        privateUrl: { type: "http", url: "https://user:SECRET@mcp.example.com/rpc" },
        privateOauth: { type: "http", url: "https://mcp.example.com/rpc", oauth: { clientSecret: "SECRET" } },
        executable: { type: "stdio", command: "node", args: ["secret-script"] },
      } });
      const r = sync();
      assert.equal(r.status, "ok");
      assert.equal(r.servers.length, 0);
      assert.equal(r.skipped.length, 5);
      assert.equal(sb.readJson(join(targetDir, ".claude.json")).mcpServers, undefined);
    } finally { sb.cleanup(); }
  });

  test("links local skills and instructions without replacing target customizations or sharing cloud-synced skills", () => {
    const sb = makeSandbox();
    try {
      const { targetDir, sync } = setup(sb);
      sb.writeJson(join(sb.claudeDir, "skills", "local", "fixture.json"), { local: true });
      sb.writeJson(join(sb.claudeDir, "skills", "synced", "cloud.json"), { cloud: true });
      sb.writeJson(join(sb.claudeDir, "commands", "existing.json"), { source: true });
      sb.writeJson(join(targetDir, "commands", "existing.json"), { target: true });
      writeFileSync(join(sb.claudeDir, "CLAUDE.md"), "shared instructions");
      const r = sync();
      assert.deepEqual(r.linked.sort(), ["CLAUDE.md", "skills/local"]);
      assert.equal(readFileSync(join(targetDir, "CLAUDE.md"), "utf8"), "shared instructions");
      assert.equal(existsSync(join(targetDir, "skills", "synced")), false);
      assert.deepEqual(sb.readJson(join(targetDir, "commands", "existing.json")), { target: true });
    } finally { sb.cleanup(); }
  });

  test("invalid destination JSON refuses the entire sync before anything is written", () => {
    const sb = makeSandbox();
    try {
      const { targetDir, sync } = setup(sb);
      const settings = readFileSync(join(targetDir, "settings.json"), "utf8");
      const file = join(targetDir, "plugins", "known_marketplaces.json");
      mkdirSync(join(targetDir, "plugins"), { recursive: true });
      writeFileSync(file, "broken json");
      assert.equal(sync().status, "invalid");
      assert.equal(readFileSync(file, "utf8"), "broken json");
      assert.equal(readFileSync(join(targetDir, "settings.json"), "utf8"), settings);
      assert.equal(existsSync(join(targetDir, "plugins", "installed_plugins.json")), false);
    } finally { sb.cleanup(); }
  });

  test("detects a target changed by another session before writing the merge", () => {
    const sb = makeSandbox();
    const fs = require("node:fs");
    const read = fs.readFileSync;
    try {
      const { targetDir, sync } = setup(sb);
      const file = join(targetDir, "settings.json");
      const updated = { ...sb.readJson(file), theme: "dark", newChoice: true };
      let count = 0;
      fs.readFileSync = (name, ...args) => {
        if (name === file && ++count === 2) writeFileSync(file, JSON.stringify(updated));
        return read(name, ...args);
      };
      assert.equal(sync().status, "changed");
      fs.readFileSync = read;
      assert.deepEqual(sb.readJson(file), updated);
      assert.equal(existsSync(join(targetDir, "plugins", "installed_plugins.json")), false);
    } finally {
      fs.readFileSync = read;
      sb.cleanup();
    }
  });

  test("does not take over a marketplace with the same name and a different source", () => {
    const sb = makeSandbox();
    try {
      const { targetDir, sync } = setup(sb);
      const known = { official: { source: { source: "github", repo: "another/plugins" } } };
      sb.writeJson(join(targetDir, "plugins", "known_marketplaces.json"), known);
      const r = sync();
      assert.equal(r.plugins.length, 0);
      assert.match(r.skipped[0], /different marketplace/);
      assert.deepEqual(sb.readJson(join(targetDir, "plugins", "known_marketplaces.json")), known);
    } finally { sb.cleanup(); }
  });

  test("requires a Claude source and an existing ChatGPT profile", () => {
    const sb = makeSandbox();
    try {
      setup(sb);
      assert.equal(profiles.syncGptWorkflow({ home: sb.home, sourceKey: "99" }).status, "bad-source");
      assert.equal(profiles.syncGptWorkflow({ home: sb.home, sourceKey: "6" }).status, "bad-source");
      sb.writeJson(sb.configPath, { accounts: { 1: { name: "Claude", configDir: null } } });
      assert.equal(profiles.syncGptWorkflow({ home: sb.home, sourceKey: "1" }).status, "no-gpt");
    } finally { sb.cleanup(); }
  });
});

describe("launchMode", () => {
  const config = {
    accounts: {
      1: { name: "One", configDir: null },
      2: { name: "Two", configDir: "account2" },
      3: { name: "Always", configDir: "account3", gpt: true },
      6: { name: "ChatGPT", configDir: "account6", provider: "chatgpt" },
    },
  };

  test("the ChatGPT account runs on GPT; the others as they are unless asked", () => {
    const sb = makeSandbox();
    try {
      const mode = (key, wantGpt) => profiles.launchMode(config, key, { home: sb.home, wantGpt }).mode;
      assert.equal(mode("6"), "gpt");
      assert.equal(mode("6", true), "gpt");
      assert.equal(mode("2"), "claude");
      assert.equal(mode("2", true), "mixed");
      assert.equal(mode("3"), "mixed", "gpt: true asks on every launch");
      assert.equal(mode("9"), "claude", "an unconfigured slot is a Claude account");
    } finally {
      sb.cleanup();
    }
  });

  test("an account whose saved default is a GPT model gets the GPT models, since plain Claude Code cannot run it", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(join(sb.profilesDir, "account2", "settings.json"), { model: "gpt-6.1-sol" });
      sb.writeJson(join(sb.claudeDir, "settings.json"), { model: "opus" });
      const two = profiles.launchMode(config, "2", { home: sb.home });
      assert.deepEqual(two, { mode: "mixed", reason: "saved-model", model: "gpt-6.1-sol" });
      assert.equal(profiles.launchMode(config, "1", { home: sb.home }).mode, "claude");

      // A model only the cached list knows is recognised too.
      sb.writeJson(join(sb.profilesDir, "chatgpt", "models.json"), { fetchedAt: Date.now(), models: [{ id: "sol-next" }] });
      sb.writeJson(join(sb.claudeDir, "settings.json"), { model: "sol-next" });
      assert.equal(profiles.launchMode(config, "1", { home: sb.home }).mode, "mixed");
    } finally {
      sb.cleanup();
    }
  });
});

describe("setGpt", () => {
  test("turns the GPT models on and off for a Claude account", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: { 2: { name: "Two", configDir: "account2" } } });
      assert.equal(profiles.setGpt({ home: sb.home, key: "2", on: true }).status, "ok");
      assert.equal(sb.readJson(sb.configPath).accounts["2"].gpt, true);
      profiles.setGpt({ home: sb.home, key: "2", on: false });
      assert.deepEqual(sb.readJson(sb.configPath).accounts["2"], { name: "Two", configDir: "account2" });
    } finally {
      sb.cleanup();
    }
  });

  test("the ChatGPT account and a missing slot are refused", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: { 6: { name: "ChatGPT", configDir: "account6", provider: "chatgpt" } } });
      assert.equal(profiles.setGpt({ home: sb.home, key: "6", on: true }).status, "is-gpt");
      assert.equal(profiles.setGpt({ home: sb.home, key: "7", on: true }).status, "no-account");
    } finally {
      sb.cleanup();
    }
  });
});

describe("repairAccount for the GPT models", () => {
  test("the ChatGPT account is checked for its ChatGPT sign-in, not a Claude one", () => {
    const sb = makeSandbox();
    try {
      const entry = { name: "ChatGPT", configDir: "account6", provider: "chatgpt" };
      const out = profiles.repairAccount("6", entry, { home: sb.home });
      assert.ok(out.findings.some((f) => f.level === "todo" && /ccc gpt login/.test(f.text)));
      assert.ok(!out.findings.some((f) => /ccc login 6/.test(f.text)), "a Claude sign-in would not help");

      chatgptSignIn(sb);
      const again = profiles.repairAccount("6", entry, { home: sb.home });
      assert.ok(again.findings.some((f) => f.level === "ok" && /signed in with ChatGPT as me@example\.com/.test(f.text)));
      assert.ok(!again.findings.some((f) => f.level === "todo"));

      chatgptSignIn(sb, { planUsage: false });
      assert.ok(profiles.repairAccount("6", entry, { home: sb.home }).findings.some((f) => f.level === "todo" && /allow it/.test(f.text)));
    } finally {
      sb.cleanup();
    }
  });

  test("a GPT model saved as the default profile's model is flagged, as plain `claude` cannot run it", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(join(sb.claudeDir, "settings.json"), { model: "gpt-6.1-sol" });
      const out = profiles.repairAccount("1", { name: "One", configDir: null }, { home: sb.home });
      assert.ok(out.findings.some((f) => f.level === "todo" && /plain `claude` cannot run/.test(f.text)));

      sb.writeJson(join(sb.profilesDir, "account2", "settings.json"), { model: "gpt-6.1-sol" });
      const two = profiles.repairAccount("2", { name: "Two", configDir: "account2" }, { home: sb.home });
      assert.ok(two.findings.some((f) => f.level === "ok" && /ccc adds the GPT models/.test(f.text)), "ccc starts other profiles, so that is fine");
    } finally {
      sb.cleanup();
    }
  });
});

describe("the CLI's GPT commands", () => {
  test("launch-mode prints how to start a slot", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: { 1: { name: "One", configDir: null }, 6: { name: "ChatGPT", configDir: "account6", provider: "chatgpt" } } });
      assert.equal(sb.node("src/profiles.cjs", ["launch-mode", "6"]).stdout, "gpt");
      assert.equal(sb.node("src/profiles.cjs", ["launch-mode", "1"]).stdout, "claude");
      assert.equal(sb.node("src/profiles.cjs", ["launch-mode", "1", "--gpt"]).stdout, "mixed");
    } finally {
      sb.cleanup();
    }
  });

  test("set-gpt says what changed, and refuses the ChatGPT account", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: { 2: { name: "Two", configDir: "account2" }, 6: { name: "ChatGPT", configDir: "account6", provider: "chatgpt" } } });
      const on = sb.node("src/profiles.cjs", ["set-gpt", "2", "on"]);
      assert.equal(on.status, 0);
      assert.match(on.stdout, /Account 2 \(Two\) now starts with the GPT models/);
      const refused = sb.node("src/profiles.cjs", ["set-gpt", "6", "on"]);
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /always runs on the GPT models/);
      assert.equal(sb.node("src/profiles.cjs", ["set-gpt", "2", "maybe"]).status, 1);
    } finally {
      sb.cleanup();
    }
  });

  test("ensure-gpt-account prints the slot", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: { 1: { name: "One", configDir: null } } });
      const r = sb.node("src/profiles.cjs", ["ensure-gpt-account"], { CC_ACCOUNT_NAME: "ChatGPT" });
      assert.equal(r.stdout, "2");
      assert.equal(sb.readJson(sb.configPath).accounts["2"].provider, "chatgpt");
    } finally {
      sb.cleanup();
    }
  });

  test("help covers the GPT commands", () => {
    for (const cmd of ["ccc gpt login", "ccc <n> --gpt", "ccc gpt on <n>", "ccc gpt status", "ccc gpt logout"]) {
      assert.ok(profiles.HELP.includes(cmd), `help is missing ${cmd}`);
    }
  });
});
