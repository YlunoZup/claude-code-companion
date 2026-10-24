// Tests for install.bat and bin/ccc.bat, running under cmd.exe.
//
// The whole file skips off Windows. There is no static analyser for batch worth
// trusting — every real failure mode in these files is semantic and positional
// (a %VAR% expanded at block-parse time, an endlocal that discards the variable
// about to be set, an `if exist` guard that runs before the thing it guards is
// created), and a regex linter is wrong about all of them in both directions.
// Executing them against a sandboxed %USERPROFILE% is the only check that
// actually catches those, so that is what this does.
//
// What CI cannot cover, and this file deliberately does not claim: a GitHub
// Windows runner is an administrator with UAC disabled, so `mklink` succeeding
// here says nothing about a standard user with Developer Mode off.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, IS_WINDOWS, REPO_ROOT } from "./helpers.test.mjs";

const skip = IS_WINDOWS ? false : "cmd.exe only runs on Windows";

/** Run a .bat through cmd.exe, one invocation per call. */
function cmd(sb, batch, args = [], input) {
  return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/e:on", "/c", batch, ...args], {
    env: sb.env,
    input,
    encoding: "utf8",
    timeout: 120000,
  });
}

function lastClaudeCall(sb) {
  const calls = sb.calls().filter((l) => l.startsWith("claude "));
  assert.ok(calls.length > 0, "claude was never launched");
  const m = /^claude cfg=\[(.*)\] args=\[(.*)\]$/.exec(calls[calls.length - 1]);
  assert.ok(m, `unparsable call line: ${calls[calls.length - 1]}`);
  return { configDir: m[1], args: m[2] };
}

describe("install.bat", { skip }, () => {
  test("a fresh install lays down every file the launcher needs", () => {
    const sb = makeSandbox();
    try {
      const r = cmd(sb, join(REPO_ROOT, "install.bat"));
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);

      for (const f of ["profiles.cjs", "picker.mjs", "statusline.js", "config.json", "package.json"]) {
        assert.ok(existsSync(join(sb.profilesDir, f)), `missing ${f}`);
      }
      assert.ok(existsSync(join(sb.home, ".local", "bin", "ccc.bat")));
    } finally {
      sb.cleanup();
    }
  });

  // The guard that configured account2's statusline used to run twenty lines
  // before the file it guarded on was created, so a first Windows install left
  // account 2 with no statusline at all while printing "[ OK] Configured".
  test("account2 gets a statusline on the very first install", () => {
    const sb = makeSandbox();
    try {
      cmd(sb, join(REPO_ROOT, "install.bat"));

      const settings = join(sb.profilesDir, "account2", "settings.json");
      assert.ok(existsSync(settings), "account2/settings.json was never created");
      assert.match(JSON.parse(readFileSync(settings, "utf8")).statusLine.command, /statusline\.js/);
    } finally {
      sb.cleanup();
    }
  });

  test("the default profile gets one too", () => {
    const sb = makeSandbox();
    try {
      cmd(sb, join(REPO_ROOT, "install.bat"));
      const settings = join(sb.claudeDir, "settings.json");
      assert.ok(existsSync(settings));
      assert.match(JSON.parse(readFileSync(settings, "utf8")).statusLine.command, /statusline\.js/);
    } finally {
      sb.cleanup();
    }
  });

  test("merges into an existing settings.json rather than replacing it", () => {
    const sb = makeSandbox();
    try {
      sb.writeJson(join(sb.claudeDir, "settings.json"), { theme: "dark" });
      cmd(sb, join(REPO_ROOT, "install.bat"));

      const after = JSON.parse(readFileSync(join(sb.claudeDir, "settings.json"), "utf8"));
      assert.equal(after.theme, "dark");
      assert.match(after.statusLine.command, /statusline\.js/);
    } finally {
      sb.cleanup();
    }
  });

  test("the generated statusLine path is quoted", () => {
    const sb = makeSandbox({ homeName: "home with spaces" });
    try {
      cmd(sb, join(REPO_ROOT, "install.bat"));
      const settings = JSON.parse(
        readFileSync(join(sb.profilesDir, "account2", "settings.json"), "utf8")
      );
      assert.match(settings.statusLine.command, /^node "/);
      assert.ok(settings.statusLine.command.includes("home with spaces"));
    } finally {
      sb.cleanup();
    }
  });

  test("never replaces an existing real projects directory", () => {
    const sb = makeSandbox();
    try {
      const projects = join(sb.profilesDir, "account2", "projects");
      mkdirSync(projects, { recursive: true });
      mkdirSync(join(sb.claudeDir, "projects"), { recursive: true });
      writeFileSync(join(projects, "session-history.txt"), "irreplaceable");

      cmd(sb, join(REPO_ROOT, "install.bat"));

      assert.equal(readFileSync(join(projects, "session-history.txt"), "utf8"), "irreplaceable");
    } finally {
      sb.cleanup();
    }
  });

  test("links the shared directories that exist", () => {
    const sb = makeSandbox();
    try {
      mkdirSync(join(sb.claudeDir, "projects"), { recursive: true });
      writeFileSync(join(sb.claudeDir, "projects", "p.txt"), "shared");

      cmd(sb, join(REPO_ROOT, "install.bat"));

      assert.ok(
        existsSync(join(sb.profilesDir, "account2", "projects", "p.txt")),
        "the junction should resolve"
      );
    } finally {
      sb.cleanup();
    }
  });

  // cmd returns only the last command's errorlevel, so this is worth pinning
  // explicitly rather than assuming "the step passed" means "it worked".
  test("a missing source file fails the install instead of reporting success", () => {
    const sb = makeSandbox();
    try {
      const r = cmd(sb, join(sb.root, "nonexistent-install.bat"));
      assert.notEqual(r.status, 0);
    } finally {
      sb.cleanup();
    }
  });
});

describe("ccc.bat", { skip }, () => {
  let sb;
  let ccc;
  before(() => {
    sb = makeSandbox();
    const r = cmd(sb, join(REPO_ROOT, "install.bat"));
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    ccc = join(sb.home, ".local", "bin", "ccc.bat");
  });
  after(() => sb.cleanup());

  test("slot 1 launches the default profile with no CLAUDE_CONFIG_DIR", () => {
    cmd(sb, ccc, ["1"]);
    assert.equal(lastClaudeCall(sb).configDir, "");
  });

  test("slot 2 points at the account2 profile", () => {
    cmd(sb, ccc, ["2"]);
    assert.equal(lastClaudeCall(sb).configDir, join(sb.profilesDir, "account2"));
  });

  // The old code ran endlocal and then set CLAUDE_CONFIG_DIR, which built the
  // path from a variable that had already been discarded.
  test("an unconfigured slot resolves to a complete accountN path", () => {
    cmd(sb, ccc, ["9"]);
    assert.equal(lastClaudeCall(sb).configDir, join(sb.profilesDir, "account9"));
  });

  test("more than nine arguments are all forwarded", () => {
    const args = Array.from({ length: 11 }, (_, i) => `--a${i + 1}`);
    cmd(sb, ccc, ["2", ...args]);
    assert.equal(lastClaudeCall(sb).args, args.join(" "));
  });

  // endlocal-then-set used to write the variable into the caller's session, so
  // every later bare `claude` in that window silently used the wrong account.
  test("does not leak CLAUDE_CONFIG_DIR into the calling session", () => {
    // A batch file rather than `cmd /c "... & echo %VAR%"`: on a command line
    // cmd expands %VAR% before anything on the line has run, and leaves an
    // undefined one as literal text, so that probe could never see a leak.
    const probe = join(sb.root, "probe.bat");
    writeFileSync(
      probe,
      ["@echo off", `call "${ccc}" 2 >nul`, "echo AFTER=[%CLAUDE_CONFIG_DIR%]", ""].join("\r\n")
    );
    const r = cmd(sb, probe);
    assert.match(r.stdout, /AFTER=\[\]/, "CLAUDE_CONFIG_DIR leaked into the caller");
  });
});

describe("ccc.bat add", { skip }, () => {
  test("allocates the next slot and leaves existing entries alone", () => {
    const sb = makeSandbox();
    try {
      assert.equal(cmd(sb, join(REPO_ROOT, "install.bat")).status, 0);
      const ccc = join(sb.home, ".local", "bin", "ccc.bat");

      const r = cmd(sb, ccc, ["add", "Client", "Project"]);
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);

      const config = JSON.parse(readFileSync(sb.configPath, "utf8"));
      // The delayed-expansion bug ate the `!` in the probe, so NEXT came back
      // empty, fell back to 1, and overwrote slot 1.
      assert.equal(config.accounts["4"].name, "Client Project");
      assert.equal(config.accounts["4"].configDir, "account4");
      assert.equal(config.accounts["1"].configDir, null, "slot 1 must be untouched");
      assert.equal(config.accounts["2"].configDir, "account2");
    } finally {
      sb.cleanup();
    }
  });

  test("the new slot is immediately launchable", () => {
    const sb = makeSandbox();
    try {
      cmd(sb, join(REPO_ROOT, "install.bat"));
      const ccc = join(sb.home, ".local", "bin", "ccc.bat");

      cmd(sb, ccc, ["add", "Fresh"]);
      cmd(sb, ccc, ["4"]);
      assert.equal(lastClaudeCall(sb).configDir, join(sb.profilesDir, "account4"));
    } finally {
      sb.cleanup();
    }
  });

  test("prompts for a name when none is given", () => {
    const sb = makeSandbox();
    try {
      cmd(sb, join(REPO_ROOT, "install.bat"));
      const ccc = join(sb.home, ".local", "bin", "ccc.bat");

      const r = cmd(sb, ccc, ["add"], "Typed Name\r\n");
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);

      const config = JSON.parse(readFileSync(sb.configPath, "utf8"));
      // Before, CUSTOM_NAME was built as "%~2 %~3 %~4 %~5", which with no
      // arguments is three spaces — never empty, so the prompt never fired and
      // the account was named "   ".
      assert.equal(config.accounts["4"].name, "Typed Name");
    } finally {
      sb.cleanup();
    }
  });

  test("refuses to touch a config.json it cannot parse", () => {
    const sb = makeSandbox();
    try {
      cmd(sb, join(REPO_ROOT, "install.bat"));
      const ccc = join(sb.home, ".local", "bin", "ccc.bat");

      const original = '{"accounts":{"1":{"name":"One","configDir":null}},}';
      writeFileSync(sb.configPath, original);

      const r = cmd(sb, ccc, ["add", "Nope"]);
      assert.notEqual(r.status, 0);
      assert.equal(readFileSync(sb.configPath, "utf8"), original, "config must be byte-identical");
    } finally {
      sb.cleanup();
    }
  });
});

// The rule the bash launcher follows: a profile that never had a statusLine, or
// lost it, gets one on launch, and anybody else's statusLine is left alone.
describe("ccc.bat wires the statusline on launch", { skip }, () => {
  function installed() {
    const sb = makeSandbox();
    assert.equal(cmd(sb, join(REPO_ROOT, "install.bat")).status, 0);
    return { sb, ccc: join(sb.home, ".local", "bin", "ccc.bat") };
  }

  test("a statusLine that went missing is put back", () => {
    const { sb, ccc } = installed();
    try {
      const file = join(sb.profilesDir, "account2", "settings.json");
      sb.writeJson(file, { theme: "dark" });

      cmd(sb, ccc, ["2"]);

      const settings = sb.readJson(file);
      assert.equal(settings.theme, "dark");
      assert.match(settings.statusLine.command, /statusline\.js/);
    } finally {
      sb.cleanup();
    }
  });

  test("the default profile is covered as well", () => {
    const { sb, ccc } = installed();
    try {
      const file = join(sb.claudeDir, "settings.json");
      sb.writeJson(file, { model: "opus" });

      cmd(sb, ccc, ["1"]);

      assert.match(sb.readJson(file).statusLine.command, /statusline\.js/);
    } finally {
      sb.cleanup();
    }
  });

  test("somebody else's statusline is left exactly as it is", () => {
    const { sb, ccc } = installed();
    try {
      const file = join(sb.profilesDir, "account2", "settings.json");
      sb.writeJson(file, { statusLine: { type: "command", command: "npx -y ccstatusline@latest" } });
      const before = readFileSync(file, "utf8");

      cmd(sb, ccc, ["2"]);

      assert.equal(readFileSync(file, "utf8"), before);
    } finally {
      sb.cleanup();
    }
  });
});

describe("ccc.bat missing dependencies", { skip }, () => {
  test("a missing profiles.cjs points at the installer", () => {
    const sb = makeSandbox();
    try {
      cmd(sb, join(REPO_ROOT, "install.bat"));
      const ccc = join(sb.home, ".local", "bin", "ccc.bat");
      rmSync(join(sb.profilesDir, "profiles.cjs"));

      const r = cmd(sb, ccc, ["2"]);
      assert.notEqual(r.status, 0);
      assert.match(r.stdout, /Re-run the installer/);
    } finally {
      sb.cleanup();
    }
  });
});

describe("ccc.bat commands", { skip }, () => {
  let sb;
  let ccc;
  before(() => {
    sb = makeSandbox();
    const r = cmd(sb, join(REPO_ROOT, "install.bat"));
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    ccc = join(sb.home, ".local", "bin", "ccc.bat");
  });
  after(() => sb.cleanup());

  test("help lists every command", () => {
    const r = cmd(sb, ccc, ["help"]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /ccc login <n>/);
    assert.match(r.stdout, /ccc repair \[n\]/);
  });

  test("list prints the overview without a prompt", () => {
    const r = cmd(sb, ccc, ["list"]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /Account Switcher/);
    assert.doesNotMatch(r.stderr, /Select account/);
  });

  test("login runs claude auth login in that profile", () => {
    cmd(sb, ccc, ["login", "2"]);
    const call = lastClaudeCall(sb);
    assert.equal(call.configDir, join(sb.profilesDir, "account2"));
    assert.equal(call.args.trim(), "auth login");
  });

  test("logout of slot 1 signs the default profile out", () => {
    cmd(sb, ccc, ["logout", "1"]);
    const call = lastClaudeCall(sb);
    assert.equal(call.configDir, "");
    assert.equal(call.args.trim(), "auth logout");
  });

  test("relogin passes what follows to claude auth login", () => {
    cmd(sb, ccc, ["relogin", "3", "--email", "client@example.com"]);
    const call = lastClaudeCall(sb);
    assert.equal(call.configDir, join(sb.profilesDir, "account3"));
    assert.equal(call.args.trim(), "auth login --email client@example.com");
  });

  test("a command without a number says how to use it", () => {
    const r = cmd(sb, ccc, ["login"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /Usage: ccc login <number>/);
  });

  test("rename changes the name in config.json", () => {
    const r = cmd(sb, ccc, ["rename", "2", "Client", "Work"]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(JSON.parse(readFileSync(sb.configPath, "utf8")).accounts["2"].name, "Client Work");
  });

  test("repair of one account checks that account", () => {
    const r = cmd(sb, ccc, ["repair", "2"]);
    assert.match(r.stdout, /\[2\]/);
    assert.doesNotMatch(r.stdout, /\[1\]|\[3\]/);
  });

  test("remove takes the account off the list and keeps its folder", () => {
    const r = cmd(sb, ccc, ["remove", "3"]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(JSON.parse(readFileSync(sb.configPath, "utf8")).accounts["3"], undefined);
    assert.ok(existsSync(join(sb.profilesDir, "account3")));
  });
});

describe("ccc.bat and the GPT models", { skip }, () => {
  let sb;
  let ccc;
  const chatgptDir = () => join(sb.profilesDir, "chatgpt");
  // cmd.exe hands the .cmd stub its arguments still quoted.
  const plain = (args) => args.replace(/"/g, "");

  before(() => {
    sb = makeSandbox();
    const r = cmd(sb, join(REPO_ROOT, "install.bat"));
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    ccc = join(sb.home, ".local", "bin", "ccc.bat");
    const config = JSON.parse(readFileSync(sb.configPath, "utf8"));
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
    sb.writeJson(join(chatgptDir(), "models.json"), { fetchedAt: Date.now(), models: [{ id: "gpt-6.1-sol", name: "GPT-6.1-Sol", efforts: [] }] });
  }
  const signOut = () => rmSync(chatgptDir(), { recursive: true, force: true });

  test("installs the GPT support files", () => {
    for (const f of ["chatgpt.cjs", "translate.cjs", "router.cjs"]) assert.ok(existsSync(join(sb.profilesDir, f)), `missing ${f}`);
  });

  test("gpt status, signed out, says how to sign in", () => {
    signOut();
    const r = cmd(sb, ccc, ["gpt", "status"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /not signed in\. Run: ccc gpt login/);
  });

  test("gpt on|off <n> sets whether a Claude account always gets the GPT models", () => {
    assert.equal(cmd(sb, ccc, ["gpt", "on", "2"]).status, 0);
    assert.equal(JSON.parse(readFileSync(sb.configPath, "utf8")).accounts["2"].gpt, true);
    assert.equal(cmd(sb, ccc, ["gpt", "off", "2"]).status, 0);
    assert.equal(JSON.parse(readFileSync(sb.configPath, "utf8")).accounts["2"].gpt, undefined);
  });

  test("logging the ChatGPT account out goes to ChatGPT, not Claude Code", () => {
    signOut();
    const before = sb.calls().length;
    const r = cmd(sb, ccc, ["logout", "6"]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /ChatGPT was not signed in/);
    assert.equal(sb.calls().length, before);
  });

  test("the ChatGPT account will not start signed out", () => {
    signOut();
    const before = sb.calls().length;
    const r = cmd(sb, ccc, ["6"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ccc gpt login/);
    assert.equal(sb.calls().length, before);
  });

  test("the ChatGPT account starts Claude Code through the router", () => {
    signIn();
    const r = cmd(sb, ccc, ["6", "-c"]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const call = lastClaudeCall(sb);
    assert.equal(call.configDir, join(sb.profilesDir, "account6"));
    assert.match(plain(call.args), /^--settings \S+\.json -c$/);
  });

  test("--gpt adds the GPT models to a Claude account, and never reaches claude", () => {
    signIn();
    const r = cmd(sb, ccc, ["2", "--gpt", "-c"]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const call = lastClaudeCall(sb);
    assert.equal(call.configDir, join(sb.profilesDir, "account2"));
    assert.match(plain(call.args), /^--settings \S+\.json\s+-c$/);
  });
});
