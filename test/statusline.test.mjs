// Tests for the statusline script.
//
// Every run gets a throwaway HOME, so nothing here reads the real config.json,
// ~/.claude.json, or a repository that happens to surround the test run.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, stripAnsi, REPO_ROOT } from "./helpers.test.mjs";

const require = createRequire(import.meta.url);
const statusline = require(join(REPO_ROOT, "src", "statusline.js"));

const noGit = spawnSync("git", ["--version"]).status === 0 ? false : "git is not installed";

// Generous, because test files run in parallel and a loaded machine can be slow
// to spawn git. The production default is a second.
const GIT_TIMEOUT = 60000;

/**
 * Run the statusline as Claude Code does: the session JSON on stdin.
 * Debug is on so a failed assertion reports why, not just that.
 */
function runStatusline(sb, session, configDir) {
  const env = { CCC_STATUSLINE_DEBUG: "1" };
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  const input = typeof session === "string" ? session : JSON.stringify(session);
  return sb.node("src/statusline.js", [], env, input);
}

/** A repository with one commit, so HEAD resolves, on the given branch. */
function makeRepo(dir, branch) {
  mkdirSync(dir, { recursive: true });
  const git = (...args) => {
    const r = spawnSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
      { cwd: dir, encoding: "utf8" }
    );
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  };
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "init");
  git("checkout", "-q", "-b", branch);
  return git;
}

const session = (cwd, extra = {}) => ({
  model: { display_name: "Opus 4.1" },
  workspace: { current_dir: cwd },
  context_window: { used_percentage: 37.4, context_window_size: 200000 },
  ...extra,
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

describe("shortenDir", () => {
  const HOME = "/Users/me";

  test("home itself is ~", () => {
    assert.equal(statusline.shortenDir(HOME, HOME), "~");
  });

  test("up to two levels below home are shown in full", () => {
    assert.equal(statusline.shortenDir(`${HOME}/code`, HOME), "~/code");
    assert.equal(statusline.shortenDir(`${HOME}/code/api`, HOME), "~/code/api");
  });

  test("anything deeper keeps its last two components", () => {
    assert.equal(statusline.shortenDir(`${HOME}/work/clients/acme/api`, HOME), "~/acme/api");
  });

  test("a path outside home is never shown under ~", () => {
    assert.equal(statusline.shortenDir("/opt/tools/x/y", HOME), "…/x/y");
    assert.equal(statusline.shortenDir("/opt/tools", HOME), "/opt/tools");
  });

  test("a sibling that merely shares the home prefix is not inside home", () => {
    assert.equal(statusline.shortenDir("/Users/me2", HOME), "/Users/me2");
    assert.equal(statusline.shortenDir("/Users/me2/a/b/c", HOME), "…/b/c");
  });

  test("Windows separators are understood", () => {
    const home = "C:\\Users\\me";
    assert.equal(statusline.shortenDir(`${home}\\code`, home), "~/code");
    assert.equal(statusline.shortenDir(`${home}\\work\\clients\\acme\\api`, home), "~/acme/api");
  });

  test("no directory, no segment", () => {
    assert.equal(statusline.shortenDir("", HOME), "");
    assert.equal(statusline.shortenDir(undefined, HOME), "");
  });
});

describe("contextLabel", () => {
  const label = (used, size = 200000) =>
    statusline.contextLabel({ used_percentage: used, context_window_size: size });

  test("shows the tokens used, the window size and the percentage", () => {
    assert.equal(stripAnsi(label(37.4)), "ctx 74k/200k (37%)");
    assert.equal(stripAnsi(label(100, 1000000)), "ctx 1000k/1000k (100%)");
  });

  test("small numbers are not abbreviated", () => {
    assert.equal(stripAnsi(label(0, 800)), "ctx 0/800 (0%)");
  });

  test("green below half full, amber below 80%, red from there", () => {
    const GREEN = /38;2;80;200;120m/;
    const AMBER = /38;2;240;190;50m/;
    const RED = /38;2;240;80;80m/;
    assert.match(label(49.4), GREEN);
    assert.match(label(49.6), AMBER, "49.6 rounds to 50");
    assert.match(label(79.4), AMBER);
    assert.match(label(80), RED);
  });

  test("nothing until Claude Code reports the window", () => {
    assert.equal(statusline.contextLabel(undefined), "");
    assert.equal(statusline.contextLabel("nonsense"), "");
    assert.equal(label(null), "");
    assert.equal(label(50, 0), "");
  });
});

describe("gitBranch", { skip: noGit }, () => {
  test("names the branch that is checked out", () => {
    const sb = makeSandbox();
    try {
      const repo = join(sb.root, "repo");
      makeRepo(repo, "feature/x");
      assert.equal(statusline.gitBranch(repo, GIT_TIMEOUT), "feature/x");
    } finally {
      sb.cleanup();
    }
  });

  test("a detached HEAD has no branch to show", () => {
    const sb = makeSandbox();
    try {
      const repo = join(sb.root, "repo");
      makeRepo(repo, "feature/x")("checkout", "-q", "--detach");
      assert.equal(statusline.gitBranch(repo, GIT_TIMEOUT), "");
    } finally {
      sb.cleanup();
    }
  });

  test("outside a repository there is none", () => {
    const sb = makeSandbox();
    try {
      assert.equal(statusline.gitBranch(sb.home, GIT_TIMEOUT), "");
      assert.equal(statusline.gitBranch(join(sb.root, "does-not-exist"), GIT_TIMEOUT), "");
    } finally {
      sb.cleanup();
    }
  });
});

describe("end to end", () => {
  // Pinned byte for byte, so a refactor cannot quietly change what every
  // session shows.
  test("the line is exactly the one it has always been", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, {
        accounts: { 1: { name: "Personal", configDir: null }, 2: { name: "Work", configDir: "account2" } },
      });
      const cwd = join(sb.home, "code", "acme", "api");
      mkdirSync(cwd, { recursive: true });

      const r = runStatusline(sb, session(cwd), join(sb.profilesDir, "account2"));

      assert.equal(r.status, 0, r.stderr);
      assert.equal(
        r.stdout,
        "\x1b[48;2;99;66;245m\x1b[38;2;255;255;255m\x1b[1m Work \x1b[0m" +
          "\x1b[48;2;30;130;180m\x1b[38;2;99;66;245m\x1b[0m" +
          "\x1b[48;2;30;130;180m\x1b[38;2;255;255;255m\x1b[1m Opus 4.1 \x1b[0m" +
          "\x1b[48;2;60;60;70m\x1b[38;2;30;130;180m\x1b[0m" +
          "\x1b[48;2;60;60;70m\x1b[38;2;255;255;255m\x1b[1m ~/acme/api \x1b[0m" +
          "\x1b[38;2;60;60;70m\x1b[0m" +
          "  \x1b[2mctx\x1b[0m \x1b[38;2;80;200;120m\x1b[1m74k/200k (37%)\x1b[0m\n"
      );
    } finally {
      sb.cleanup();
    }
  });

  test("the default profile shows its name from config.json", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: { 1: { name: "Personal", configDir: null } } });
      const r = runStatusline(sb, session(sb.home));

      assert.equal(r.status, 0, r.stderr);
      assert.equal(stripAnsi(r.stdout), " Personal  Opus 4.1  ~   ctx 74k/200k (37%)\n");
    } finally {
      sb.cleanup();
    }
  });

  test("shows the branch when the session is inside a repository", { skip: noGit }, () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: { 1: { name: "Personal", configDir: null } } });
      const repo = join(sb.home, "code", "repo");
      makeRepo(repo, "feature/x");

      const r = runStatusline(sb, session(repo));

      assert.equal(stripAnsi(r.stdout), " Personal  Opus 4.1   feature/x  ~/code/repo   ctx 74k/200k (37%)\n");
      assert.match(r.stdout, /48;2;40;167;70m/, "the branch segment should be green");
    } finally {
      sb.cleanup();
    }
  });

  test("still names the account with nothing on stdin, or something that is not JSON", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: { 1: { name: "Personal", configDir: null } } });
      for (const input of ["", "{nope", "null"]) {
        const r = runStatusline(sb, input);
        assert.equal(r.status, 0, `${JSON.stringify(input)}: ${r.stderr}`);
        assert.match(stripAnsi(r.stdout), /^ Personal /, JSON.stringify(input));
      }
    } finally {
      sb.cleanup();
    }
  });

  test("stays quiet on stderr unless debug is asked for", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: { 1: { name: "Personal", configDir: null } } });

      const quiet = sb.node("src/statusline.js", [], {}, "{nope");
      assert.equal(quiet.stderr, "", "bad input must not print anything");

      const loud = sb.node("src/statusline.js", [], { CCC_STATUSLINE_DEBUG: "1" }, "{nope");
      assert.match(loud.stderr, /ignoring unreadable input/);
    } finally {
      sb.cleanup();
    }
  });
});
