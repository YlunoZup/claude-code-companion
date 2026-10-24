// picker.mjs - Claude Code account switcher UI
//
// Shows every account: who it is signed in as, its plan, and how much of its
// 5-hour and weekly limits is left right now. Pick one to launch it.
//
// Sign-in state and identity come from profiles.cjs, which reads neither a token
// nor any other secret: on macOS it asks the Keychain whether a login exists,
// attributes only, and identity is plain JSON in the profile's .claude.json.
// Live usage comes from usage.cjs, which asks Claude Code itself.
//
// With --list it prints the same overview to stdout and exits, for `ccc list`.

import { realpathSync } from "fs";
import { createInterface } from "readline";
import { homedir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import profiles from "./profiles.cjs";
import usage from "./usage.cjs";

const HOME = homedir();
const PROFILES_DIR = join(HOME, ".claude-profiles");
const CONFIG_PATH = join(PROFILES_DIR, "config.json");

// ── Colors & Styles ──────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  white: "\x1b[97m",
  gray: "\x1b[90m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  bgDim: "\x1b[48;5;236m",
  orange: "\x1b[38;5;208m",
};

// ── Load Config ──────────────────────────────────────────────
// No config.json is the ordinary first-run state and falls back to the built-in
// pair of accounts. A config.json that exists but cannot be parsed is not: it
// means the account list on screen would not be the user's, and picking from it
// would launch the wrong profile. Say so and stop.
function loadConfig(configPath = CONFIG_PATH) {
  const result = profiles.readConfig(configPath);
  if (result.status === "missing") return profiles.defaultConfig();
  if (result.status === "ok") return result.config;
  const reason = result.error ? result.error.message : "unknown error";
  throw new Error(`${configPath} could not be read: ${reason}`);
}

function formatPlan(info) {
  if (!info.ready) return `${c.yellow}${c.dim}not logged in${c.reset}`;

  // "default_claude_max_20x" -> "Claude Max 20x"
  const m = String(info.tier || "").match(/max_(\d+)x/i);
  if (m) return `${c.orange}${c.bold}Claude Max ${m[1]}x${c.reset}`;

  const sub = String(info.sub || "").toLowerCase();
  if (sub.includes("enterprise"))
    return `${c.blue}${c.bold}Claude Enterprise${c.reset}`;
  if (sub.includes("team")) return `${c.blue}${c.bold}Claude Team${c.reset}`;
  if (sub.includes("max")) return `${c.orange}${c.bold}Claude Max${c.reset}`;
  if (sub.includes("pro")) return `${c.cyan}${c.bold}Claude Pro${c.reset}`;
  return `${c.green}${c.bold}logged in${c.reset}`;
}

// ── Build Account List ───────────────────────────────────────
function buildAccounts(config) {
  const accounts = Object.entries(config.accounts).map(([key, acc]) => {
    const entry = acc && typeof acc === "object" ? acc : {};
    const state = profiles.accountState(entry.configDir || null);
    return {
      key,
      // A config entry with no name would otherwise render as "undefined".
      name: entry.name ? String(entry.name) : `Account ${key}`,
      configDir: entry.configDir || null,
      dir: state.dir,
      ready: state.signedIn,
      email: state.email,
      display: state.displayName,
      accountUuid: state.accountUuid,
      sub: state.subscription,
      tier: state.tier,
      usage: null,
      sameAs: null,
    };
  });

  // Two slots signed into one Claude account share its limits, which is easy to
  // miss when they carry different names. Point the later one at the first.
  for (const [i, acc] of accounts.entries()) {
    if (!acc.ready || !acc.accountUuid) continue;
    const first = accounts.slice(0, i).find((o) => o.ready && o.accountUuid === acc.accountUuid);
    if (first) acc.sameAs = first.key;
  }
  return accounts;
}

// ── Write to stderr so shell wrapper can capture stdout for data ──
let write = (text) => process.stderr.write(text);
const log = (msg = "") => write(msg + "\n");

// ── Live usage ───────────────────────────────────────────────
// Every signed-in account at once: each answer takes Claude Code a second or
// two to give. A slot sharing another's login reuses that answer.
async function loadUsage(accounts) {
  if (process.env.CCC_NO_USAGE) return;
  const asking = accounts.filter((a) => a.ready && !a.sameAs);
  if (asking.length === 0) return;

  // The progress line always goes to stderr, so `ccc list > file` stays clean.
  const tty = process.stderr.isTTY;
  process.stderr.write(`  ${c.dim}Checking live usage…${c.reset}${tty ? "" : "\n"}`);

  const answers = await Promise.all(asking.map((a) => usage.fetchUsage(a.configDir ? a.dir : null)));
  asking.forEach((a, i) => (a.usage = answers[i]));
  for (const acc of accounts) {
    if (acc.sameAs) acc.usage = accounts.find((a) => a.key === acc.sameAs).usage;
  }
  if (tty) process.stderr.write("\r\x1b[K");
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function clip(str, max) {
  if (max < 4) return "";
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

// "5h    ██████░░░░  55% left · resets in 4h 2m"
function usageRow(label, win, now) {
  if (!win) return `${c.gray}${label.padEnd(6)}${c.reset}${c.dim}no limit reported${c.reset}`;
  const left = Math.round(win.left);
  const color = left >= 50 ? c.green : left >= 20 ? c.yellow : c.red;
  const filled = Math.round(left / 10);
  const bar = `${color}${"█".repeat(filled)}${c.reset}${c.dim}${"░".repeat(10 - filled)}${c.reset}`;
  const when = usage.formatResetIn(win.resetsAt, now);
  const reset = when ? `${c.dim} · resets ${when}${c.reset}` : "";
  return `${c.gray}${label.padEnd(6)}${c.reset}${bar} ${color}${c.bold}${String(left).padStart(3)}% left${c.reset}${reset}`;
}

// ── Render UI ────────────────────────────────────────────────
const W = 58;

function boxRow(content) {
  const pad = " ".repeat(Math.max(0, W - stripAnsi(content).length));
  log(`  ${c.dim}${c.cyan}┃${c.reset}${content}${pad}${c.dim}${c.cyan}┃${c.reset}`);
}

function render(accounts, now = Date.now()) {
  const line = "━".repeat(W);
  const blank = "";

  log("");
  log(`  ${c.dim}${c.cyan}┏${line}┓${c.reset}`);
  boxRow(blank);
  boxRow(`   ${c.orange}${c.bold}◆${c.reset}  ${c.white}${c.bold}Claude Code${c.reset}`);
  boxRow(`      ${c.dim}Account Switcher${c.reset}`);
  boxRow(blank);
  log(`  ${c.dim}${c.cyan}┣${line}┫${c.reset}`);
  boxRow(blank);

  for (const acc of accounts) {
    const status = acc.ready ? `${c.green}●${c.reset}` : `${c.dim}○${c.reset}`;
    const planStr = formatPlan(acc);

    // Row 1: slot number, status dot, configured label, and a warning when the
    // slot shares its login with an earlier one.
    const twin = acc.sameAs ? `  same login as [${acc.sameAs}]` : "";
    boxRow(
      `   ${c.dim}[${c.reset}${c.white}${c.bold}${acc.key}${c.reset}${c.dim}]${c.reset}  ${status}  ${c.white}${c.bold}${clip(acc.name, W - 12 - twin.length)}${c.reset}${c.yellow}${twin}${c.reset}`
    );

    // Row 2: which account this actually is, plus the plan on it.
    const planLen = stripAnsi(planStr).length;
    const who = acc.email || acc.display;
    if (!acc.ready) {
      boxRow(`         ${planStr}${c.dim}  ·  ccc login ${acc.key}${c.reset}`);
    } else if (who) {
      const budget = W - 9 - planLen - 5;
      const whoStr = clip(who, budget);
      boxRow(`         ${c.gray}${whoStr}${c.reset}  ${c.dim}·${c.reset}  ${planStr}`);
    } else {
      boxRow(`         ${planStr}`);
    }

    // Rows 3 and 4: how much of each limit is left.
    const u = acc.usage;
    if (u && u.status === "ok") {
      boxRow(`         ${usageRow("5h", u.fiveHour, now)}`);
      boxRow(`         ${usageRow("week", u.weekly, now)}`);
    } else if (u && u.status === "unavailable") {
      boxRow(`         ${c.dim}no plan limits on this login${c.reset}`);
    } else if (u) {
      boxRow(`         ${c.dim}${clip(`usage unavailable: ${u.error}`, W - 10)}${c.reset}`);
    }

    boxRow(blank);
  }

  log(`  ${c.dim}${c.cyan}┗${line}┛${c.reset}`);
  log("");
}

// ── Prompt ───────────────────────────────────────────────────
function prompt(accounts) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const keys = accounts.map((a) => a.key).join("/");
  rl.setPrompt(
    `  ${c.white}${c.bold}Select account ${c.dim}[${keys}, r to refresh, q to quit]${c.reset}${c.white}${c.bold}: ${c.reset}`
  );

  // A refresh takes a second or two. Anything typed meanwhile waits its turn,
  // rather than arriving while nothing is listening and being lost.
  let busy = false;
  let closed = false;
  const waiting = [];
  rl.on("close", () => (closed = true));

  const next = () => {
    if (waiting.length) handle(waiting.shift());
    else if (!closed) rl.prompt();
  };

  const handle = async (line) => {
    const choice = line.trim();

    if (choice === "q" || choice === "Q" || choice === "") {
      rl.close();
      log(`  ${c.dim}Cancelled.${c.reset}`);
      process.exit(0);
    }

    if (choice === "r" || choice === "R") {
      busy = true;
      await loadUsage(accounts);
      render(accounts);
      busy = false;
      next();
      return;
    }

    const acc = accounts.find((a) => a.key === choice);
    if (!acc) {
      log(`  ${c.yellow}Invalid choice. Enter ${keys}, r to refresh, or q to quit.${c.reset}`);
      next();
      return;
    }

    rl.close();

    if (!acc.ready) {
      log(
        `\n  ${c.yellow}${acc.name} is not logged in yet; Claude will prompt you to sign in.${c.reset}\n`
      );
    }

    // stdout: only the profile path (read by shell wrapper)
    if (acc.configDir) {
      process.stdout.write(join(PROFILES_DIR, acc.configDir));
    } else {
      process.stdout.write("__DEFAULT__");
    }
  };

  rl.on("line", (line) => {
    if (busy) waiting.push(line);
    else handle(line);
  });
  rl.prompt();
}

async function main(argv = process.argv.slice(2)) {
  const listOnly = argv.includes("--list");
  if (listOnly) write = (text) => process.stdout.write(text);

  // Colour is for a terminal: `ccc list > file` or `| grep` gets plain text.
  // NO_COLOR is the convention for turning it off everywhere.
  if (process.env.NO_COLOR || (listOnly && !process.stdout.isTTY)) {
    for (const key of Object.keys(c)) c[key] = "";
  }

  let accounts;
  try {
    accounts = buildAccounts(loadConfig());
  } catch (err) {
    process.stderr.write(`  ${c.yellow}${err.message}${c.reset}\n`);
    process.stderr.write(`  ${c.dim}Fix it, or delete it to fall back to the defaults.${c.reset}\n`);
    process.exit(1);
  }

  await loadUsage(accounts);
  render(accounts);
  if (!listOnly) prompt(accounts);
}

export {
  buildAccounts,
  clip,
  formatPlan,
  loadConfig,
  loadUsage,
  main,
  render,
  stripAnsi,
  usageRow,
  W,
};

// Run only when invoked directly, so the helpers above can be imported by
// tests. Compare real paths: import.meta.url is already symlink-resolved, and
// argv[1] is whatever the caller typed — on macOS /var vs /private/var alone is
// enough to make a naive comparison disagree.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main();
}
