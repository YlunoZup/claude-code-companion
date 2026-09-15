// Unit tests for src/profiles.cjs — the module every launcher and installer
// routes its config.json and settings.json work through.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, IS_WINDOWS, REPO_ROOT } from "./helpers.test.mjs";

const require = createRequire(import.meta.url);
const profiles = require(join(REPO_ROOT, "src", "profiles.cjs"));

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
