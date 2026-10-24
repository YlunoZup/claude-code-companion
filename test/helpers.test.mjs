// Shared test harness, plus the tests that prove the harness itself works.
//
// Node's test runner treats every file under test/ as a test file, so this one
// carries its own tests rather than pretending to be a plain module.
//
// Nothing here touches the real home directory, the real Keychain, or a real
// Claude account. Every test gets a throwaway HOME and a stub `claude` on PATH
// that records what it was called with instead of launching anything.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const IS_WINDOWS = process.platform === "win32";
const NODE_DIR = dirname(process.execPath);

// What bash and cmd need for the basics (cp, mkdir, grep, where).
//
// On Windows, Git's bin comes first. System32 has a bash.exe of its own, the
// WSL launcher, which fails outright where no Linux distribution is installed,
// and in front of Git's it was the bash every test ran. Git's bin holds only
// bash, sh and git, so it shadows nothing cmd needs; the rest of Git Bash's
// tools come after Windows' own, so cmd keeps its own find and sort.
const WINDOWS_DIR = process.env.SystemRoot || "C:\\Windows";
const SYSTEM_PATH = IS_WINDOWS
  ? ["C:\\Program Files\\Git\\bin", join(WINDOWS_DIR, "System32"), WINDOWS_DIR, "C:\\Program Files\\Git\\usr\\bin"]
  : ["/usr/bin", "/bin"];

/**
 * Create an isolated HOME with stub executables on PATH.
 *
 * @param {object} [opts]
 * @param {string} [opts.homeName]   directory name for HOME — pass something
 *                                   with a space or an apostrophe to exercise
 *                                   quoting.
 * @param {boolean} [opts.node]      put node on PATH (off means "node missing").
 */
export function makeSandbox(opts = {}) {
  const { homeName = "home", node = true } = opts;

  const root = mkdtempSync(join(tmpdir(), "cma-"));
  const home = join(root, homeName);
  const stubs = join(root, "stubs");
  const calls = join(root, "calls.log");
  mkdirSync(home, { recursive: true });
  mkdirSync(stubs, { recursive: true });
  writeFileSync(calls, "");

  writeStub(stubs, "claude", calls);

  const pathParts = [stubs, ...(node ? [NODE_DIR] : []), ...SYSTEM_PATH];

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: pathParts.join(delimiter),
    CCC_TEST_CALLS: calls,
    // What the stub claude answers a usage request with; see setUsage.
    CCC_TEST_USAGE: join(root, "usage.json"),
    // The default profile's Keychain service name does not depend on HOME, so
    // without this a test on a Mac would find the developer's real login.
    CCC_NO_KEYCHAIN: "1",
    // Nothing may ask a real Codex for a real account's ChatGPT limits.
    CCC_CODEX_BIN: "none",
    // Test files run in parallel, so spawning git from the statusline can take
    // longer than the production default. Without this the statusline tests
    // are flaky under load rather than wrong.
    CCC_GIT_TIMEOUT_MS: "60000",
  };
  // A developer running the suite inside Claude Code has this set; leaking it
  // into a child would silently rewrite what every test observes.
  delete env.CLAUDE_CONFIG_DIR;

  return {
    root,
    home,
    stubs,
    env,
    profilesDir: join(home, ".claude-profiles"),
    claudeDir: join(home, ".claude"),
    configPath: join(home, ".claude-profiles", "config.json"),

    /** Everything the stub claude was invoked with, one line per call. */
    calls() {
      return readFileSync(calls, "utf8").trim().split("\n").filter(Boolean);
    },

    /** Run install.sh against this sandbox. */
    install(...args) {
      // cwd inside the sandbox: a relative install directory resolves against
      // it, instead of leaving a stray directory in the repository.
      return runBash(join(REPO_ROOT, "install.sh"), args, env, undefined, root);
    },

    /**
     * Run the installed launcher.
     * @param {string[]} [args]
     * @param {{input?: string, env?: object}} [opts]
     */
    ccc(args = [], opts = {}) {
      return runBash(join(home, ".local", "bin", "ccc"), args, opts.env || env, opts.input, root);
    },

    /** The sandbox environment with node removed from PATH. */
    envWithoutNode() {
      return {
        ...env,
        PATH: env.PATH.split(delimiter)
          .filter((p) => p !== NODE_DIR)
          .join(delimiter),
      };
    },

    /** Run a script under node — a repo-relative path, or an absolute one. */
    node(script, args = [], extraEnv = {}, input = undefined) {
      const file = isAbsolute(script) ? script : join(REPO_ROOT, script);
      return spawnSync(process.execPath, [file, ...args], {
        env: { ...env, ...extraEnv },
        input,
        encoding: "utf8",
        timeout: 30000,
      });
    },

    /**
     * What the stub claude answers a get_usage request with, per profile: keys
     * are the profile's directory name, or "default". A value is the answer
     * Claude Code gives — see usageAnswer() — or {__error: message} for a
     * failed request, {__silent: true} for no answer at all, and {__sleepMs: n}
     * alongside an answer to give it late. Unlisted profiles get no answer.
     */
    setUsage(map) {
      writeFileSync(env.CCC_TEST_USAGE, JSON.stringify(map));
    },

    /** Mark a profile signed in the way Linux and Windows record it. */
    signIn(configDir, { email, accountUuid, tier } = {}) {
      const dir = configDir ? join(home, ".claude-profiles", configDir) : join(home, ".claude");
      this.writeJson(join(dir, ".credentials.json"), { claudeAiOauth: {} });
      if (email || accountUuid || tier) {
        const state = configDir ? join(dir, ".claude.json") : join(home, ".claude.json");
        this.writeJson(state, {
          oauthAccount: { emailAddress: email, accountUuid, organizationRateLimitTier: tier },
        });
      }
    },

    writeJson(file, value) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
    },

    readJson(file) {
      return JSON.parse(readFileSync(file, "utf8"));
    },

    cleanup() {
      // Windows will not remove a directory a process is still running in, and
      // the claude behind a usage request can outlive its answer by a moment.
      // rmSync's own maxRetries does not cover a busy directory before Node 22,
      // so retry here.
      for (let attempt = 1; ; attempt++) {
        try {
          rmSync(root, { recursive: true, force: true });
          return;
        } catch (err) {
          if (attempt >= 50 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(err.code)) throw err;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        }
      }
    },
  };
}

// A stub that logs its name, CLAUDE_CONFIG_DIR and arguments instead of doing
// anything — except `-p`, a usage request, which goes to USAGE_STUB. Windows
// gets two, as npm installs two: a .cmd for cmd.exe, and an extensionless shell
// script, which is the only kind Git Bash can run.
function writeStub(dir, name, logPath) {
  const usageStub = join(dir, "claude-usage.mjs");
  writeFileSync(usageStub, USAGE_STUB);

  const script = [
    "#!/bin/sh",
    `if [ "$1" = "-p" ]; then exec node "${usageStub.replace(/\\/g, "/")}" "$@"; fi`,
    // Drain stdin first, as the real program would: a stub that exits without
    // reading what it was piped makes the parent's write fail with EPIPE.
    "cat > /dev/null 2>&1",
    `printf '%s cfg=[%s] args=[%s]\\n' "${name}" "\${CLAUDE_CONFIG_DIR-<unset>}" "$*" >> "${logPath.replace(/\\/g, "/")}"`,
    "exit 0",
  ].join("\n");
  const file = join(dir, name);
  writeFileSync(file, script + "\n");
  chmodSync(file, 0o755);

  if (IS_WINDOWS) {
    const lines = [
      "@echo off",
      // The first argument goes through echo rather than `if "%~1"==...`: the
      // router escapes each argument for an npm shim, which only ever passes
      // %* on, and an argument escaped that way breaks an `if` comparison.
      'echo(%1| findstr /x /c:"-p" >nul && goto usage',
      // The same drain, for the same reason.
      "more > nul 2>&1",
      `>>"${logPath}" echo ${name} cfg=[%CLAUDE_CONFIG_DIR%] args=[%*]`,
      "exit /b 0",
      ":usage",
      `node "${usageStub}" %*`,
      "exit /b %ERRORLEVEL%",
    ];
    writeFileSync(join(dir, `${name}.cmd`), lines.join("\r\n") + "\r\n");
  }
}

// Stands in for `claude -p` answering one get_usage control request, with what
// the test set through setUsage() for this profile, and logs how it was run.
const USAGE_STUB = `import { appendFileSync, readFileSync } from "node:fs";
import { basename } from "node:path";

let input = "";
for await (const chunk of process.stdin) input += chunk;

const dir = process.env.CLAUDE_CONFIG_DIR;
const key = dir ? basename(dir) : "default";
appendFileSync(
  process.env.CCC_TEST_CALLS,
  \`claude-usage cfg=[\${dir ?? "<unset>"}] args=[\${process.argv.slice(2).join(" ")}]\\n\`
);

let answers = {};
try {
  answers = JSON.parse(readFileSync(process.env.CCC_TEST_USAGE, "utf8"));
} catch {}
const answer = answers[key];
if (!answer || answer.__silent) process.exit(0);
if (answer.__sleepMs) await new Promise((r) => setTimeout(r, answer.__sleepMs));

const request = JSON.parse(input.split("\\n")[0] || "{}");
const response = answer.__error
  ? { subtype: "error", request_id: request.request_id, error: answer.__error }
  : { subtype: "success", request_id: request.request_id, response: answer };
process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "control_response", response }) + "\\n");
`;

/**
 * A get_usage answer in the shape Claude Code gives one. Percentages are the
 * share used, as the endpoint reports them; resets are epoch ms, or null for a
 * window that has not started.
 */
export function usageAnswer({ fiveHour = 0, weekly = 0, fiveHourReset = null, weeklyReset = null, subscription = "pro" } = {}) {
  const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());
  return {
    subscription_type: subscription,
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: fiveHour, resets_at: iso(fiveHourReset) },
      seven_day: { utilization: weekly, resets_at: iso(weeklyReset) },
    },
  };
}

function runBash(script, args, env, input, cwd) {
  // Forward slashes on Windows: install.sh finds its own directory with
  // dirname, which does not take a backslash for a separator.
  const path = IS_WINDOWS ? script.replace(/\\/g, "/") : script;
  return spawnSync("bash", [path, ...args], {
    env,
    input,
    cwd,
    encoding: "utf8",
    timeout: 120000,
  });
}

/**
 * Why the bash launchers cannot run from a home at this path, or false.
 *
 * Git Bash turns a /c/... argument into C:\... before handing it to a Windows
 * program such as node, except one containing an apostrophe, which it passes on
 * unconverted and node then cannot open. It also reads a bare apostrophe on its
 * own command line as a quote. Under Git Bash such a home is unsupported, so
 * those tests are skipped there rather than left failing.
 */
export function gitBashCannotUse(path) {
  return IS_WINDOWS && path.includes("'")
    ? "Git Bash hands node a path containing an apostrophe unconverted"
    : false;
}

/** Strip ANSI SGR sequences so assertions can look at plain text. */
export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ── Tests for the harness itself ─────────────────────────────

test("sandbox isolates HOME and scrubs CLAUDE_CONFIG_DIR", () => {
  const sb = makeSandbox();
  try {
    assert.ok(sb.home.startsWith(tmpdir()), "HOME must live under the temp dir");
    assert.equal(sb.env.HOME, sb.home);
    assert.equal(sb.env.USERPROFILE, sb.home);
    assert.ok(!("CLAUDE_CONFIG_DIR" in sb.env), "CLAUDE_CONFIG_DIR must not leak in");

    // node resolves its own idea of home from the same variables.
    const r = spawnSync(process.execPath, ["-e", "process.stdout.write(require('os').homedir())"], {
      env: sb.env,
      encoding: "utf8",
    });
    assert.equal(r.stdout, sb.home, "os.homedir() must follow the sandbox");
  } finally {
    sb.cleanup();
  }
});

test("stub claude records CLAUDE_CONFIG_DIR and arguments instead of launching", () => {
  const sb = makeSandbox();
  try {
    const bin = IS_WINDOWS ? "claude.cmd" : "claude";
    const r = spawnSync(join(sb.stubs, bin), ["--hello"], {
      env: { ...sb.env, CLAUDE_CONFIG_DIR: "/some/profile" },
      encoding: "utf8",
      shell: IS_WINDOWS,
    });
    assert.equal(r.status, 0);
    const calls = sb.calls();
    assert.equal(calls.length, 1);
    assert.match(calls[0], /claude cfg=\[.*some.profile\] args=\[--hello\]/);
  } finally {
    sb.cleanup();
  }
});

test("a sandbox can be given a home directory whose name needs quoting", () => {
  const sb = makeSandbox({ homeName: "it's a home" });
  try {
    assert.ok(sb.home.includes("it's a home"));
    assert.ok(existsSync(sb.home));
  } finally {
    sb.cleanup();
  }
});
