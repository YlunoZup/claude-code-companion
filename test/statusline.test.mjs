// Tests for the statusline script.
//
// claude-powerline is stubbed throughout — these cover the account resolution,
// the badge, and the argument handoff, not claude-powerline's own rendering.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { makeSandbox, REPO_ROOT, IS_WINDOWS } from "./helpers.test.mjs";

const require = createRequire(import.meta.url);
const statusline = require(join(REPO_ROOT, "src", "statusline.js"));

/** Run the statusline as Claude Code does: JSON on stdin. */
function runStatusline(sb, configDir) {
  return sb.node("src/statusline.js", [], configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}, "{}\n");
}

/** The claude-powerline invocation the stub recorded. */
function powerlineCall(sb) {
  const line = sb.calls().find((l) => l.startsWith("claude-powerline "));
  assert.ok(line, "claude-powerline was never invoked");
  return /args=\[(.*)\]$/.exec(line)[1];
}

describe("accountIdFor", () => {
  test("no CLAUDE_CONFIG_DIR is the default profile", () => {
    assert.equal(statusline.accountIdFor(undefined), "__default__");
    assert.equal(statusline.accountIdFor(""), "__default__");
  });

  test("a profile directory reduces to its basename", () => {
    assert.equal(statusline.accountIdFor(join("/a", "b", "account3")), "account3");
  });

  test("a trailing separator does not change the answer", () => {
    assert.equal(statusline.accountIdFor(join("/a", "b", "account3") + "/"), "account3");
  });
});

describe("buildBadge", () => {
  test("the default profile and a named profile get different colours", () => {
    const def = statusline.buildBadge("One", undefined);
    const other = statusline.buildBadge("Two", "/p/account2");
    assert.match(def, /99;66;245/);
    assert.match(other, /230;126;34/);
  });

  test("the account name appears in the badge", () => {
    assert.match(statusline.buildBadge("Client Work", "/p/account4"), /Client Work/);
  });
});

describe("resolveAccountName", () => {
  test("reads the name from config.json for the default profile", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, {
        accounts: { 1: { name: "Personal", configDir: null }, 2: { name: "Work", configDir: "account2" } },
      });
      assert.equal(
        statusline.resolveAccountName(undefined, { home: sb.home, configPath: sb.configPath }),
        "Personal"
      );
    } finally {
      sb.cleanup();
    }
  });

  test("reads the name from config.json for a named profile", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, {
        accounts: { 1: { name: "Personal", configDir: null }, 2: { name: "Work", configDir: "account2" } },
      });
      assert.equal(
        statusline.resolveAccountName(join(sb.profilesDir, "account2"), {
          home: sb.home,
          configPath: sb.configPath,
        }),
        "Work"
      );
    } finally {
      sb.cleanup();
    }
  });

  test("falls back to the identity Claude Code recorded", () => {
    const sb = makeSandbox();
    try {
      const dir = join(sb.profilesDir, "account7");
      sb.writeJson(sb.configPath, { accounts: {} });
      sb.writeJson(join(dir, ".claude.json"), {
        oauthAccount: { displayName: "Ada Lovelace", emailAddress: "ada@example.com" },
      });

      assert.equal(
        statusline.resolveAccountName(dir, { home: sb.home, configPath: sb.configPath }),
        "Ada Lovelace"
      );
    } finally {
      sb.cleanup();
    }
  });

  test("falls back to the directory name when nothing else is known", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: {} });
      assert.equal(
        statusline.resolveAccountName(join(sb.profilesDir, "account9"), {
          home: sb.home,
          configPath: sb.configPath,
        }),
        "account9"
      );
    } finally {
      sb.cleanup();
    }
  });

  test("an unreadable config.json does not take the statusline down", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, {});
      const { writeFileSync } = require("node:fs");
      writeFileSync(sb.configPath, "{ broken");

      const name = statusline.resolveAccountName(undefined, {
        home: sb.home,
        configPath: sb.configPath,
      });
      assert.equal(typeof name, "string");
      assert.ok(name.length > 0);
    } finally {
      sb.cleanup();
    }
  });
});

describe("end to end", () => {
  test("renders the badge for the default profile", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: { 1: { name: "Personal", configDir: null } } });
      const r = runStatusline(sb);

      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Personal/);
      assert.match(r.stdout, /99;66;245/);
      assert.match(r.stdout, /POWERLINE-OK/);
    } finally {
      sb.cleanup();
    }
  });

  test("renders the badge for a named profile", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, {
        accounts: { 1: { name: "Personal", configDir: null }, 2: { name: "Work", configDir: "account2" } },
      });
      const r = runStatusline(sb, join(sb.profilesDir, "account2"));

      assert.match(r.stdout, /Work/);
      assert.match(r.stdout, /230;126;34/);
    } finally {
      sb.cleanup();
    }
  });

  test("degrades to the badge alone when claude-powerline is not installed", () => {
    const sb = makeSandbox({ powerline: false });
    try {
      sb.writeJson(sb.configPath, { accounts: { 1: { name: "Personal", configDir: null } } });
      const r = runStatusline(sb);

      assert.equal(r.status, 0, "a missing optional dependency must not break the statusline");
      assert.match(r.stdout, /Personal/);
    } finally {
      sb.cleanup();
    }
  });

  test("says why it produced nothing when asked to", () => {
    const sb = makeSandbox({ powerline: false });
    try {
      sb.writeJson(sb.configPath, { accounts: { 1: { name: "Personal", configDir: null } } });
      const r = sb.node("src/statusline.js", [], { CCC_STATUSLINE_DEBUG: "1" }, "{}\n");
      assert.match(r.stderr, /claude-powerline failed/);
    } finally {
      sb.cleanup();
    }
  });

  test("switching accounts clears the shared today cache", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, {
        accounts: { 1: { name: "One", configDir: null }, 2: { name: "Two", configDir: "account2" } },
      });
      const cache = join(sb.claudeDir, "powerline", "usage", "today.json");

      runStatusline(sb);
      sb.writeJson(cache, { total: 42 });

      runStatusline(sb, join(sb.profilesDir, "account2"));

      const { existsSync } = require("node:fs");
      assert.equal(existsSync(cache), false, "the previous account's cached cost must be dropped");
    } finally {
      sb.cleanup();
    }
  });
});

describe("the config path reaches claude-powerline intact", () => {
  // The path used to be interpolated into a shell command string, so a $, a
  // backtick or a quote anywhere in the home directory changed what ran.
  const names = IS_WINDOWS
    ? ["home with spaces"]
    : ["home with spaces", "home$WITH$dollars", "home`with`ticks", "it's home"];

  for (const homeName of names) {
    test(`survives a home named ${JSON.stringify(homeName)}`, () => {
      const sb = makeSandbox({ homeName });
      try {
        sb.writeJson(sb.configPath, { accounts: { 1: { name: "Personal", configDir: null } } });
        sb.writeJson(join(sb.profilesDir, "claude-powerline.json"), { theme: "dark" });

        const r = runStatusline(sb);
        assert.equal(r.status, 0, r.stderr);

        const args = powerlineCall(sb);
        assert.ok(
          args.includes(join(sb.profilesDir, "claude-powerline.json")),
          `--config path was mangled: ${args}`
        );
      } finally {
        sb.cleanup();
      }
    });
  }

  test("no --config is passed when there is no powerline config file", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: { 1: { name: "Personal", configDir: null } } });
      runStatusline(sb);
      assert.equal(powerlineCall(sb), "--style=powerline");
    } finally {
      sb.cleanup();
    }
  });
});
