// picker.mjs - Claude Code account switcher UI
//
// HOW LOGIN DETECTION WORKS
// On macOS, Claude Code keeps OAuth credentials in the login Keychain, not on
// disk. The service name is:
//     "Claude Code-credentials"                      -> default profile (~/.claude)
//     "Claude Code-credentials-<sha256(dir)[0:8]>"   -> any profile launched
//                                                        with CLAUDE_CONFIG_DIR
// where <dir> is the absolute config dir path, e.g.
//     sha256("/Users/you/.claude-profiles/account2")[0:8] = 04f595a6
//
// We probe with an attribute-only lookup (no -w flag), so macOS never shows a
// Keychain access prompt and the check costs ~10ms.
//
// Older Claude Code builds, Linux and Windows still write
// <dir>/.credentials.json, so that path is checked too.
//
// Plan and identity (email, display name) come from the profile's .claude.json
// under the "oauthAccount" key, which is plain JSON and needs no Keychain access.

import { readFileSync, existsSync, realpathSync } from "fs";
import { execFileSync } from "child_process";
import { createInterface } from "readline";
import { homedir, platform } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import profiles from "./profiles.cjs";

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

// ── Credential detection ─────────────────────────────────────
function inKeychain(service) {
  if (platform() !== "darwin") return false;
  try {
    // No -w: attributes only, so this never triggers a Keychain prompt.
    execFileSync("security", ["find-generic-password", "-s", service], {
      stdio: "ignore",
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

// ── Read account info ────────────────────────────────────────
function getAccountInfo(configDir) {
  const isDefault = !configDir;
  const dir = isDefault ? join(HOME, ".claude") : join(PROFILES_DIR, configDir);

  // 1. Logged in? Keychain first, then the legacy on-disk credentials file.
  let ready = inKeychain(profiles.keychainService(dir, isDefault));
  let sub = null;
  let tier = null;

  const credPath = join(dir, ".credentials.json");
  if (existsSync(credPath)) {
    try {
      const oauth =
        JSON.parse(readFileSync(credPath, "utf8")).claudeAiOauth || {};
      ready = true;
      sub = oauth.subscriptionType || null;
      tier = oauth.rateLimitTier || null;
    } catch {}
  }

  // 2. Who is it? The default profile's .claude.json sits at ~/.claude.json,
  //    every other profile keeps its own inside the config dir.
  const statePath = isDefault
    ? join(HOME, ".claude.json")
    : join(dir, ".claude.json");

  let email = null;
  let display = null;
  try {
    const acct = JSON.parse(readFileSync(statePath, "utf8")).oauthAccount || {};
    email = acct.emailAddress || null;
    display = acct.displayName || null;
    sub = sub || acct.organizationType || null; // claude_max | claude_pro | ...
    tier = tier || acct.organizationRateLimitTier || null; // default_claude_max_20x | ...
  } catch {}

  return { ready, sub, tier, email, display };
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
  return Object.entries(config.accounts).map(([key, acc]) => {
    const entry = acc && typeof acc === "object" ? acc : {};
    const info = getAccountInfo(entry.configDir);
    return {
      key,
      // A config entry with no name would otherwise render as "undefined".
      name: entry.name ? String(entry.name) : `Account ${key}`,
      configDir: entry.configDir,
      ...info,
    };
  });
}

// ── Write to stderr so shell wrapper can capture stdout for data ──
const log = (msg = "") => process.stderr.write(msg + "\n");

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function clip(str, max) {
  if (max < 4) return "";
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

// ── Render UI ────────────────────────────────────────────────
const W = 58;

function boxRow(content) {
  const pad = " ".repeat(Math.max(0, W - stripAnsi(content).length));
  log(`  ${c.dim}${c.cyan}┃${c.reset}${content}${pad}${c.dim}${c.cyan}┃${c.reset}`);
}

function render(accounts) {
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

    // Row 1: slot number, status dot, configured label.
    boxRow(
      `   ${c.dim}[${c.reset}${c.white}${c.bold}${acc.key}${c.reset}${c.dim}]${c.reset}  ${status}  ${c.white}${c.bold}${clip(acc.name, W - 12)}${c.reset}`
    );

    // Row 2: which account this actually is, plus the plan on it.
    const planLen = stripAnsi(planStr).length;
    const who = acc.email || acc.display;
    if (who) {
      const budget = W - 9 - planLen - 5;
      const whoStr = clip(who, budget);
      boxRow(`         ${c.gray}${whoStr}${c.reset}  ${c.dim}·${c.reset}  ${planStr}`);
    } else {
      boxRow(`         ${planStr}`);
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

  const ask = () => {
    rl.question(
      `  ${c.white}${c.bold}Select account ${c.dim}[${keys}, q to quit]${c.reset}${c.white}${c.bold}: ${c.reset}`,
      (answer) => {
        const choice = answer.trim();

        if (choice === "q" || choice === "Q" || choice === "") {
          rl.close();
          log(`  ${c.dim}Cancelled.${c.reset}`);
          process.exit(0);
        }

        const acc = accounts.find((a) => a.key === choice);
        if (!acc) {
          log(`  ${c.yellow}Invalid choice. Enter ${keys} or q to quit.${c.reset}`);
          ask();
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
      }
    );
  };

  ask();
}

function main() {
  let accounts;
  try {
    accounts = buildAccounts(loadConfig());
  } catch (err) {
    log(`  ${c.yellow}${err.message}${c.reset}`);
    log(`  ${c.dim}Fix it, or delete it to fall back to the defaults.${c.reset}`);
    process.exit(1);
  }

  render(accounts);
  prompt(accounts);
}

export {
  buildAccounts,
  clip,
  formatPlan,
  getAccountInfo,
  loadConfig,
  main,
  render,
  stripAnsi,
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
