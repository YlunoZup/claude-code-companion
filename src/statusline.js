// statusline.js - the account badge Claude Code renders, plus claude-powerline
//
// CommonJS on purpose, and it keeps the .js extension because existing
// settings.json files point at this exact filename. The installer drops a
// {"type": "commonjs"} package.json next to it so an unrelated ~/package.json
// declaring {"type": "module"} cannot turn it into an ES module.

const { execSync, execFileSync } = require("child_process");
const { readFileSync, existsSync, writeFileSync, mkdirSync, unlinkSync } = require("fs");
const { homedir } = require("os");
const { join, basename, normalize } = require("path");
const profiles = require("./profiles.cjs");

const HOME = homedir();
const PROFILES_DIR = join(HOME, ".claude-profiles");
const CONFIG_PATH = join(PROFILES_DIR, "config.json");
const POWERLINE_CONFIG = join(PROFILES_DIR, "claude-powerline.json");

// Shared powerline cache — invalidate when account changes
const CACHE_DIR = join(HOME, ".claude", "powerline", "usage");
const ACCOUNT_MARKER = join(CACHE_DIR, ".last-account");
const TODAY_CACHE = join(CACHE_DIR, "today.json");

const debug = (msg) => {
  if (process.env.CCC_STATUSLINE_DEBUG) process.stderr.write(`statusline: ${msg}\n`);
};

// ── Account identity ─────────────────────────────────────────

// Which account is active, as a stable id for the cache marker.
function accountIdFor(configDir) {
  return configDir ? basename(normalize(configDir)) : "__default__";
}

// Look the name up in config.json for every account, including the default one.
// No CLAUDE_CONFIG_DIR means the default profile, which is the entry whose
// configDir is null; it is not necessarily literally named "Account 1".
//
// Falls back to the identity Claude Code recorded when config.json has no
// entry. The default profile keeps its state in ~/.claude.json (home root);
// every other profile keeps its own inside the config dir.
function resolveAccountName(configDir, { home = HOME, configPath = CONFIG_PATH } = {}) {
  const dirName = configDir ? basename(normalize(configDir)) : null;

  const read = profiles.readConfig(configPath);
  if (read.status === "ok") {
    const name = profiles.accountNameFor(read.config, dirName);
    if (name) return name;
  } else if (read.status !== "missing") {
    debug(`ignoring unreadable ${configPath}`);
  }

  const statePath = configDir ? join(configDir, ".claude.json") : join(home, ".claude.json");
  const state = profiles.readJsonFile(statePath);
  if (state.status === "ok") {
    const acct = state.value.oauthAccount || {};
    if (acct.displayName) return String(acct.displayName);
    if (acct.emailAddress) return String(acct.emailAddress);
  }

  return dirName || "Account 1";
}

// Purple for the default profile, orange for the others.
function buildBadge(name, configDir) {
  const accentRgb = configDir ? "230;126;34" : "99;66;245";
  return (
    `\x1b[48;2;${accentRgb}m\x1b[38;2;255;255;255m\x1b[1m \u{1F464} ${name} \x1b[0m` +
    `\x1b[38;2;${accentRgb}m\x1b[0m`
  );
}

// ── claude-powerline ─────────────────────────────────────────

// The config path used to be interpolated into a shell command string, so a $,
// a backtick or a quote anywhere in the home directory changed what ran. On
// POSIX there is no shell here at all now.
function runPowerline(input, configPath, platform) {
  const args = ["--style=powerline"];
  if (configPath) args.push("--config", configPath);

  const opts = { input, encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] };

  if ((platform || process.platform) === "win32") {
    // npm installs claude-powerline as a .cmd shim, which cannot be run without
    // a shell. A Windows path cannot contain a double quote and cmd.exe expands
    // neither $ nor backticks, so quoting the arguments is enough there.
    const quoted = args.map((a) => (/[\s&^|<>()]/.test(a) ? `"${a}"` : a)).join(" ");
    return execSync(`claude-powerline ${quoted}`, opts).trim();
  }

  return execFileSync("claude-powerline", args, opts).trim();
}

// ── Cache invalidation ───────────────────────────────────────

// All accounts share ~/.claude/powerline/usage, so the today cache has to go
// when the active account changes or it reports the previous account's spend.
function invalidateCacheOnAccountChange(accountId) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    let lastAccount = "";
    try {
      lastAccount = readFileSync(ACCOUNT_MARKER, "utf8").trim();
    } catch {}

    if (lastAccount !== accountId) {
      try {
        unlinkSync(TODAY_CACHE);
      } catch {}
      writeFileSync(ACCOUNT_MARKER, accountId, "utf8");
      return true;
    }
  } catch (err) {
    debug(`cache invalidation skipped: ${err.message}`);
  }
  return false;
}

// ── Entry point ──────────────────────────────────────────────

function main() {
  // Claude Code pipes a JSON blob in. Reading fd 0 when it is a terminal blocks
  // forever, which used to make running this by hand to debug it look like a
  // hang, so only read when something is actually piped.
  let input = "";
  if (!process.stdin.isTTY) {
    try {
      input = readFileSync(0, "utf8");
    } catch {}
  }

  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const name = resolveAccountName(configDir);
  const label = buildBadge(name, configDir);

  invalidateCacheOnAccountChange(accountIdFor(configDir));

  let powerline = "";
  try {
    powerline = runPowerline(input, existsSync(POWERLINE_CONFIG) ? POWERLINE_CONFIG : null);
  } catch (err) {
    // Degrade to the badge alone: claude-powerline is optional, and a broken
    // statusline should never take the session with it. Set
    // CCC_STATUSLINE_DEBUG=1 to find out why it produced nothing.
    debug(`claude-powerline failed: ${err.message}`);
  }

  process.stdout.write(`${label} ${powerline}\n`);
}

module.exports = {
  accountIdFor,
  resolveAccountName,
  buildBadge,
  runPowerline,
  invalidateCacheOnAccountChange,
  main,
};

if (require.main === module) {
  main();
}
