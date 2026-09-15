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

// System directories bash and cmd need for the basics (cp, mkdir, grep, where).
const SYSTEM_PATH = IS_WINDOWS
  ? [join(process.env.SystemRoot || "C:\\Windows", "System32"), process.env.SystemRoot || "C:\\Windows"]
  : ["/usr/bin", "/bin"];

/**
 * Create an isolated HOME with stub executables on PATH.
 *
 * @param {object} [opts]
 * @param {string} [opts.homeName]   directory name for HOME — pass something
 *                                   with a space or an apostrophe to exercise
 *                                   quoting.
 * @param {boolean} [opts.powerline] put a stub claude-powerline on PATH.
 * @param {boolean} [opts.node]      put node on PATH (off means "node missing").
 */
export function makeSandbox(opts = {}) {
  const { homeName = "home", powerline = true, node = true } = opts;

  const root = mkdtempSync(join(tmpdir(), "cma-"));
  const home = join(root, homeName);
  const stubs = join(root, "stubs");
  const calls = join(root, "calls.log");
  mkdirSync(home, { recursive: true });
  mkdirSync(stubs, { recursive: true });
  writeFileSync(calls, "");

  writeStub(stubs, "claude", calls);
  if (powerline) writeStub(stubs, "claude-powerline", calls, "POWERLINE-OK");

  const pathParts = [stubs, ...(node ? [NODE_DIR] : []), ...SYSTEM_PATH];
  // Git Bash needs its own bin directories on PATH to run install.sh at all.
  if (IS_WINDOWS) pathParts.push("C:\\Program Files\\Git\\bin", "C:\\Program Files\\Git\\usr\\bin");

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: pathParts.join(delimiter),
    CCC_TEST_CALLS: calls,
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

    writeJson(file, value) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
    },

    readJson(file) {
      return JSON.parse(readFileSync(file, "utf8"));
    },

    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function writeStub(dir, name, logPath, extraOutput) {
  if (IS_WINDOWS) {
    const lines = [
      "@echo off",
      `>>"${logPath}" echo ${name} cfg=[%CLAUDE_CONFIG_DIR%] args=[%*]`,
      ...(extraOutput ? [`echo ${extraOutput}`] : []),
      "exit /b 0",
    ];
    writeFileSync(join(dir, `${name}.cmd`), lines.join("\r\n") + "\r\n");
    return;
  }

  const script = [
    "#!/bin/sh",
    `printf '%s cfg=[%s] args=[%s]\\n' "${name}" "\${CLAUDE_CONFIG_DIR-<unset>}" "$*" >> "${logPath}"`,
    ...(extraOutput ? [`echo "${extraOutput}"`] : []),
    "exit 0",
  ].join("\n");
  const file = join(dir, name);
  writeFileSync(file, script + "\n");
  chmodSync(file, 0o755);
}

function runBash(script, args, env, input, cwd) {
  return spawnSync("bash", [script, ...args], {
    env,
    input,
    cwd,
    encoding: "utf8",
    timeout: 120000,
  });
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
