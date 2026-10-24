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

describe("limitsLabel", () => {
  const MINUTE = 60000;
  const HOUR = 60 * MINUTE;
  const now = Date.UTC(2026, 9, 24, 12, 0, 0);
  // Claude Code gives resets_at in seconds, where the usage endpoint gives a date.
  const seconds = (ms) => Math.floor(ms / 1000);
  const window = (used, resetsInMs = 3 * HOUR) => ({ used_percentage: used, resets_at: seconds(now + resetsInMs) });

  test("shows how much of each window is left", () => {
    const label = statusline.limitsLabel({ five_hour: window(23), seven_day: window(60, 96 * HOUR) }, now);
    assert.equal(stripAnsi(label), "5h 77% left · week 40% left");
  });

  test("a window with under a fifth left also says when it resets", () => {
    const label = statusline.limitsLabel({ five_hour: window(85, 72 * MINUTE), seven_day: window(10) }, now);
    assert.equal(stripAnsi(label), "5h 15% left, resets in 1h 12m · week 90% left");
  });

  test("green from half left, amber from a fifth, red below", () => {
    const colorOf = (used) => statusline.limitsLabel({ seven_day: window(used) }, now);
    assert.match(colorOf(50), /38;2;80;200;120m/, "50% left is green");
    assert.match(colorOf(51), /38;2;240;190;50m/, "49% left is amber");
    assert.match(colorOf(80), /38;2;240;190;50m/, "20% left is amber");
    assert.match(colorOf(81), /38;2;240;80;80m/, "19% left is red");
  });

  // Claude Code drops a window once its reset time has passed, until the
  // next response reports a new one.
  test("a window Claude Code did not pass in is left out", () => {
    assert.equal(stripAnsi(statusline.limitsLabel({ seven_day: window(60) }, now)), "week 40% left");
  });

  test("nothing for an API key, or before the first response", () => {
    for (const limits of [undefined, null, {}, "nonsense", { five_hour: {} }]) {
      assert.equal(statusline.limitsLabel(limits, now), "", JSON.stringify(limits));
    }
  });

  test("percentages outside 0-100 are clamped", () => {
    assert.equal(stripAnsi(statusline.limitsLabel({ five_hour: window(104) }, now)), "5h 0% left, resets in 3h 0m");
    assert.equal(stripAnsi(statusline.limitsLabel({ five_hour: window(-3) }, now)), "5h 100% left");
  });

  test("the line ends with the limits when Claude Code passes them in", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: { 1: { name: "Personal", configDir: null } } });
      const now = Date.now();
      const r = runStatusline(
        sb,
        session(sb.home, {
          rate_limits: {
            five_hour: { used_percentage: 23, resets_at: Math.floor((now + 3 * HOUR) / 1000) },
            seven_day: { used_percentage: 60, resets_at: Math.floor((now + 96 * HOUR) / 1000) },
          },
        })
      );
      assert.equal(r.status, 0, r.stderr);
      assert.equal(stripAnsi(r.stdout), " Personal  Opus 4.1  ~   ctx 74k/200k (37%)  5h 77% left · week 40% left\n");
    } finally {
      sb.cleanup();
    }
  });
});

describe("GPT models", () => {
  test("a GPT model is known by its name, or by the list the ChatGPT sign-in last gave", () => {
    const sb = makeSandbox();
    try {
      assert.equal(statusline.isGptModel("gpt-6.1-sol", { home: sb.home }), true);
      assert.equal(statusline.isGptModel("claude-opus-5-5", { home: sb.home }), false);
      assert.equal(statusline.isGptModel("", { home: sb.home }), false);
      assert.equal(statusline.isGptModel("sol-next", { home: sb.home }), false);
      sb.writeJson(join(sb.profilesDir, "chatgpt", "models.json"), { fetchedAt: Date.now(), models: [{ id: "sol-next" }] });
      assert.equal(statusline.isGptModel("sol-next", { home: sb.home }), true);
    } finally {
      sb.cleanup();
    }
  });

  // A GPT row behaves as a 1M Claude model, so Claude Code reports 1M; the
  // window that applies is the GPT model's own.
  test("a GPT model's context is shown against its own window", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(join(sb.profilesDir, "chatgpt", "models.json"), { fetchedAt: Date.now(), models: [{ id: "gpt-6-luna", contextWindow: 272000 }] });
      const ctx = { used_percentage: 14, context_window_size: 1000000, current_usage: { input_tokens: 1000, cache_creation_input_tokens: 15000, cache_read_input_tokens: 120000, output_tokens: 900 } };
      const window = statusline.gptModel("gpt-6-luna", { home: sb.home }).window;
      assert.equal(window, 272000);
      assert.equal(stripAnsi(statusline.contextLabel(ctx, window)), "ctx 136k/272k (50%)");
      assert.equal(stripAnsi(statusline.contextLabel(ctx)), "ctx 140k/1000k (14%)", "a Claude model's figures stay as reported");
      assert.equal(statusline.gptModel("gpt-unlisted", { home: sb.home }).window, 272000, "an unlisted GPT model gets the usual window");
      assert.equal(statusline.gptModel("claude-opus-5-5", { home: sb.home }), null);
    } finally {
      sb.cleanup();
    }
  });

  // The rate limits Claude Code passes in are the Claude account's, left over
  // from its last Claude reply; on a GPT model they would mislead.
  test("on a GPT model the line says the ChatGPT plan is paying, in place of the Claude limits", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(sb.configPath, { accounts: { 6: { name: "ChatGPT", configDir: "account6", provider: "chatgpt" } } });
      const now = Date.now();
      const r = runStatusline(
        sb,
        session(sb.home, {
          model: { id: "gpt-6.1-sol", display_name: "GPT-6.1-Sol" },
          rate_limits: { five_hour: { used_percentage: 23, resets_at: Math.floor(now / 1000) + 3600 } },
        }),
        join(sb.profilesDir, "account6")
      );
      assert.equal(r.status, 0, r.stderr);
      assert.equal(stripAnsi(r.stdout), " ChatGPT  GPT-6.1-Sol  ~   ctx 74k/200k (37%)  Using ChatGPT plan\n");
    } finally {
      sb.cleanup();
    }
  });
});

describe("the ChatGPT plan's usage", () => {
  const limits = (sb, fetchedAt, windows) =>
    sb.writeJson(join(sb.profilesDir, "chatgpt", "limits.json"), { status: "ok", planType: "pro", windows, fetchedAt });

  test("a GPT model shows how much of the plan is left, as Codex last reported it", () => {
    const sb = makeSandbox();
    try {
      const now = Date.now();
      limits(sb, now - 60000, [{ label: "week", minutes: 10080, used: 4, left: 96, resetsAt: now + 5 * 86400000 }]);
      assert.equal(stripAnsi(statusline.chatgptLabel({ home: sb.home, now })), "ChatGPT plan week 96% left");
    } finally {
      sb.cleanup();
    }
  });

  test("under a fifth left it says when it resets; old figures say how old they are", () => {
    const sb = makeSandbox();
    try {
      const now = Date.now();
      limits(sb, now - 45 * 60000, [
        { label: "5h", minutes: 300, used: 90, left: 10, resetsAt: now + 125 * 60000 },
        { label: "week", minutes: 10080, used: 40, left: 60, resetsAt: now + 3 * 86400000 },
      ]);
      assert.equal(stripAnsi(statusline.chatgptLabel({ home: sb.home, now })), "ChatGPT plan 5h 10% left, resets in 2h 5m · week 60% left (45m ago)");
    } finally {
      sb.cleanup();
    }
  });

  test("with no figures at all it just says which plan pays", () => {
    const sb = makeSandbox();
    try {
      assert.equal(stripAnsi(statusline.chatgptLabel({ home: sb.home })), "Using ChatGPT plan");
    } finally {
      sb.cleanup();
    }
  });
});
