// Integration tests that run the real install.sh against a throwaway HOME.
//
// On Windows these run under Git Bash, which is the only way to reach
// install.sh's MSYS branch at all.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, IS_WINDOWS } from "./helpers.test.mjs";

const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

describe("install.sh", () => {
  test("a fresh install lays down every file the launchers need", () => {
    const sb = makeSandbox();
    try {
      const r = sb.install();
      assert.equal(r.status, 0, r.stderr);

      for (const f of [
        "profiles.cjs",
        "picker.mjs",
        "statusline.js",
        "config.json",
        "claude-powerline.json",
        "package.json",
      ]) {
        assert.ok(existsSync(join(sb.profilesDir, f)), `missing ${f}`);
      }
      assert.ok(existsSync(join(sb.home, ".local", "bin", "ccc")), "launcher not installed");
    } finally {
      sb.cleanup();
    }
  });

  // statusline.js is CommonJS with a .js extension. Without this marker, an
  // unrelated ~/package.json declaring {"type":"module"} makes Node parse it as
  // ESM and the statusline dies on every refresh.
  test("drops a commonjs marker beside the CommonJS statusline", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      assert.equal(sb.readJson(join(sb.profilesDir, "package.json")).type, "commonjs");
    } finally {
      sb.cleanup();
    }
  });

  test("statusline.js still loads when ~/package.json declares ESM", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      sb.writeJson(join(sb.home, "package.json"), { type: "module" });

      const r = sb.node(join(sb.profilesDir, "statusline.js"), [], { CLAUDE_CONFIG_DIR: "" });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Account/);
    } finally {
      sb.cleanup();
    }
  });

  test("seeds config.json from the template but never overwrites an existing one", () => {
    const sb = makeSandbox();
    try {
      sb.install();
      assert.ok(sb.readJson(sb.configPath).accounts["2"]);

      sb.writeJson(sb.configPath, { accounts: { 7: { name: "Mine", configDir: "account7" } } });
      sb.install();

      const after = sb.readJson(sb.configPath);
      assert.equal(after.accounts["7"].name, "Mine");
      assert.equal(after.accounts["2"], undefined, "template must not be re-applied");
    } finally {
      sb.cleanup();
    }
  });

  test("configures the statusline for the default profile and account2", () => {
    const sb = makeSandbox();
    try {
      sb.install();

      for (const f of [
        join(sb.claudeDir, "settings.json"),
        join(sb.profilesDir, "account2", "settings.json"),
      ]) {
        assert.ok(existsSync(f), `missing ${f}`);
        assert.match(sb.readJson(f).statusLine.command, /statusline\.js/);
      }
    } finally {
      sb.cleanup();
    }
  });

  test("merges into settings.json instead of replacing it", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(join(sb.claudeDir, "settings.json"), {
        theme: "dark",
        permissions: { allow: ["Bash"] },
      });
      sb.install();

      const after = sb.readJson(join(sb.claudeDir, "settings.json"));
      assert.equal(after.theme, "dark");
      assert.deepEqual(after.permissions, { allow: ["Bash"] });
      assert.match(after.statusLine.command, /statusline\.js/);
    } finally {
      sb.cleanup();
    }
  });

  test("leaves an unparsable settings.json alone and says so", () => {
    const sb = makeSandbox();
    try {
      const file = join(sb.claudeDir, "settings.json");
      mkdirSync(sb.claudeDir, { recursive: true });
      const original = '{ "theme": "dark", // hand-edited\n "model": "opus" }';
      writeFileSync(file, original);

      const r = sb.install();
      assert.equal(r.status, 0, "a bad settings.json must not abort the install");
      assert.equal(readFileSync(file, "utf8"), original, "must be byte-identical");
      assert.match(r.stdout, /could not be parsed as JSON/);
    } finally {
      sb.cleanup();
    }
  });

  // The regression this whole suite exists for: re-running the installer used to
  // rm -rf a real account2/projects directory and replace it with a link,
  // destroying that account's session transcripts.
  test("never replaces an existing real projects directory", () => {
    const sb = makeSandbox();
    try {
      const projects = join(sb.profilesDir, "account2", "projects");
      mkdirSync(projects, { recursive: true });
      mkdirSync(join(sb.claudeDir, "projects"), { recursive: true });
      writeFileSync(join(projects, "session-history.txt"), "irreplaceable");

      const r = sb.install();

      assert.equal(r.status, 0, r.stderr);
      assert.equal(
        readFileSync(join(projects, "session-history.txt"), "utf8"),
        "irreplaceable",
        "the installer destroyed real session history"
      );
      assert.match(r.stdout, /already exists in account2/);
    } finally {
      sb.cleanup();
    }
  });

  test("shares the directories that exist and skips the ones that do not", () => {
    const sb = makeSandbox();
    try {
      mkdirSync(join(sb.claudeDir, "projects"), { recursive: true });
      mkdirSync(join(sb.claudeDir, "todos"), { recursive: true });
      writeFileSync(join(sb.claudeDir, "projects", "p.txt"), "shared");

      sb.install();

      assert.ok(
        existsSync(join(sb.profilesDir, "account2", "projects", "p.txt")),
        "projects should resolve through the link"
      );
      assert.ok(existsSync(join(sb.profilesDir, "account2", "todos")));
      assert.equal(
        existsSync(join(sb.profilesDir, "account2", "statsig")),
        false,
        "statsig does not exist, so nothing should have been created for it"
      );
    } finally {
      sb.cleanup();
    }
  });

  test("running it twice changes nothing and still succeeds", () => {
    const sb = makeSandbox();
    try {
      assert.equal(sb.install().status, 0);
      const first = sb.readJson(join(sb.profilesDir, "account2", "settings.json"));

      const second = sb.install();
      assert.equal(second.status, 0, second.stderr);
      assert.deepEqual(sb.readJson(join(sb.profilesDir, "account2", "settings.json")), first);
    } finally {
      sb.cleanup();
    }
  });

  describe("install destination", () => {
    test("honours a custom directory", () => {
      const sb = makeSandbox();
      try {
        const dest = join(sb.root, "custom-bin");
        const r = sb.install(dest);
        assert.equal(r.status, 0, r.stderr);
        assert.ok(existsSync(join(dest, "ccc")));
      } finally {
        sb.cleanup();
      }
    });

    test("honours a directory whose name contains a space", () => {
      const sb = makeSandbox();
      try {
        const dest = join(sb.root, "my tools");
        const r = sb.install(dest);
        assert.equal(r.status, 0, r.stderr);
        assert.ok(existsSync(join(dest, "ccc")));
      } finally {
        sb.cleanup();
      }
    });

    test("a relative directory resolves against the working directory", () => {
      const sb = makeSandbox();
      try {
        const r = sb.install("./relative-bin");
        assert.equal(r.status, 0, r.stderr);
        assert.ok(existsSync(join(sb.root, "relative-bin", "ccc")), "should install there");
        assert.doesNotMatch(r.stdout, /\.\/relative-bin/, "should report the resolved path");
      } finally {
        sb.cleanup();
      }
    });

    // Bailing out here matters: the destination is resolved before settings.json
    // is rewritten or any link is made, so a bad argument costs nothing.
    test(
      "refuses an unwritable destination before touching anything",
      { skip: IS_WINDOWS || IS_ROOT },
      () => {
        const sb = makeSandbox();
        try {
          const locked = join(sb.root, "locked");
          mkdirSync(locked, { recursive: true });
          chmodSync(locked, 0o555);

          const r = sb.install(join(locked, "bin"));

          assert.notEqual(r.status, 0, "should have failed");
          assert.match(r.stdout + r.stderr, /install directory/i);
          assert.equal(
            existsSync(sb.profilesDir),
            false,
            "nothing should have been created before the check"
          );
        } finally {
          chmodSync(join(sb.root, "locked"), 0o755);
          sb.cleanup();
        }
      }
    );
  });

  describe("missing dependencies", () => {
    test("stops with a readable message when node is not on PATH", () => {
      const sb = makeSandbox({ node: false });
      try {
        const r = sb.install();
        assert.notEqual(r.status, 0);
        assert.match(r.stdout + r.stderr, /Node\.js is required/);
      } finally {
        sb.cleanup();
      }
    });

    test("only warns when claude-powerline is absent", () => {
      const sb = makeSandbox({ powerline: false });
      try {
        const r = sb.install();
        assert.equal(r.status, 0, "an optional dependency must not fail the install");
        assert.match(r.stdout, /claude-powerline not found/);
      } finally {
        sb.cleanup();
      }
    });
  });

  describe("paths that need quoting", () => {
    for (const homeName of ["home with spaces", "it's home", "home with spaces and 'quotes'"]) {
      test(`installs into a home named ${JSON.stringify(homeName)}`, () => {
        const sb = makeSandbox({ homeName });
        try {
          const r = sb.install();
          assert.equal(r.status, 0, r.stderr);

          // The statusLine command is handed to a shell by Claude Code, so the
          // path inside it has to survive one.
          const command = sb.readJson(join(sb.profilesDir, "account2", "settings.json")).statusLine
            .command;
          assert.match(command, /^node "/, "the path must be quoted");
          assert.ok(command.includes(homeName), "the path must still point at this home");
        } finally {
          sb.cleanup();
        }
      });
    }
  });
});
