// statusline.js - the Claude Code status line, for every account
//
// Renders: account · model · git branch · working directory · context usage ·
// how much of the 5-hour and weekly limits is left — or, on a GPT model, that
// the ChatGPT plan is paying — using nothing beyond Node itself. Which account
// is active comes from CLAUDE_CONFIG_DIR, which ccc exports before launching
// Claude Code.
//
// CommonJS on purpose, and it keeps the .js extension because existing
// settings.json files point at this exact filename. The installer drops a
// {"type": "commonjs"} package.json next to it so an unrelated ~/package.json
// declaring {"type": "module"} cannot turn it into an ES module.

const { execFileSync } = require("child_process");
const { readFileSync } = require("fs");
const { homedir } = require("os");
const { join, basename, normalize } = require("path");
const profiles = require("./profiles.cjs");
const usage = require("./usage.cjs");

const HOME = homedir();
const PROFILES_DIR = join(HOME, ".claude-profiles");
const CONFIG_PATH = join(PROFILES_DIR, "config.json");

// Bounded so a wedged git cannot stall the statusline. Overridable because a
// loaded machine, or a repository on a slow network drive, can need longer.
const GIT_TIMEOUT_MS = Number(process.env.CCC_GIT_TIMEOUT_MS) || 1000;

const debug = (msg) => {
  if (process.env.CCC_STATUSLINE_DEBUG) process.stderr.write(`statusline: ${msg}\n`);
};

// ── Colours ──────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const fg = ([r, g, b]) => `\x1b[38;2;${r};${g};${b}m`;
const bg = ([r, g, b]) => `\x1b[48;2;${r};${g};${b}m`;

const WHITE = [255, 255, 255];

// How full something is: plenty, getting there, nearly out.
const GREEN = [80, 200, 120];
const AMBER = [240, 190, 50];
const RED = [240, 80, 80];

const COLORS = {
  account: [99, 66, 245], // purple
  model: [30, 130, 180], // teal
  git: [40, 167, 70], // green
  dir: [60, 60, 70], // slate
};

// Drawn after each segment, in that segment's colour. Empty keeps the segments
// flush, which looks the same in any font. "\uE0B0" draws Powerline arrows
// instead, for a terminal using a Nerd Font or a Powerline-patched font.
const SEPARATOR = "";

// Put in front of the branch name. "\uE0A0 " is the Powerline branch symbol,
// for the same fonts.
const BRANCH_MARK = " ";

// ── Account ──────────────────────────────────────────────────

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

// ── Git branch ───────────────────────────────────────────────

// Empty outside a repository, and on a detached HEAD, which has no branch to
// show. git is run directly rather than through a shell, so this works the
// same way on Windows.
function gitBranch(cwd, timeout = GIT_TIMEOUT_MS) {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    return branch === "HEAD" ? "" : branch;
  } catch (err) {
    debug(`no git branch for ${cwd}: ${err.message}`);
    return "";
  }
}

// ── Working directory ────────────────────────────────────────

// "~" for home itself, and anything more than two levels below it cut to its
// last two components: ~/work/clients/acme/api shows as ~/acme/api. Only a path
// that really is inside home gets a ~ — /Users/me2 is not inside /Users/me just
// because it starts with the same characters.
function shortenDir(cwd, home = HOME) {
  if (!cwd) return "";
  if (cwd === home) return "~";

  const inHome = Boolean(home) && (cwd.startsWith(home + "/") || cwd.startsWith(home + "\\"));
  const parts = (inHome ? cwd.slice(home.length + 1) : cwd).split(/[\\/]/).filter(Boolean);
  if (inHome) return "~/" + parts.slice(-2).join("/");
  return parts.length > 2 ? "…/" + parts.slice(-2).join("/") : cwd;
}

// ── Context window ───────────────────────────────────────────

const formatTokens = (n) => (n >= 1000 ? (n / 1000).toFixed(0) + "k" : String(n));

// "ctx 74k/200k (37%)": green below half full, amber below 80%, red from there.
// Empty until Claude Code reports the window.
function contextLabel(ctx) {
  if (!ctx || typeof ctx !== "object") return "";
  const { used_percentage: used, context_window_size: size } = ctx;
  if (used === null || used === undefined || !size) return "";

  const pct = Math.round(used);
  const tokens = Math.round((pct / 100) * size);
  const color = pct < 50 ? GREEN : pct < 80 ? AMBER : RED;
  return `${DIM}ctx${RESET} ${fg(color)}${BOLD}${formatTokens(tokens)}/${formatTokens(size)} (${pct}%)${RESET}`;
}

// ── Plan limits ──────────────────────────────────────────────

// "5h 77% left · week 40% left": how much of the account's 5-hour and weekly
// limits is left, from the rate_limits Claude Code passes in for a
// subscription login — the figures the picker shows. Nothing for an API key,
// or before a session's first response. A window with under a fifth left also
// says when it resets, since that is when it matters. Colours run as in the
// picker: green from half left, amber from a fifth, red below.
function limitsLabel(limits, now = Date.now()) {
  if (!limits || typeof limits !== "object") return "";
  const parts = [];
  for (const [key, label] of [
    ["five_hour", "5h"],
    ["seven_day", "week"],
  ]) {
    const win = limits[key];
    if (!win || typeof win.used_percentage !== "number") continue;
    const left = Math.round(100 - Math.min(100, Math.max(0, win.used_percentage)));
    const color = left >= 50 ? GREEN : left >= 20 ? AMBER : RED;
    let text = `${DIM}${label}${RESET} ${fg(color)}${BOLD}${left}% left${RESET}`;
    // resets_at is in seconds here, where the usage endpoint gives a date.
    if (left < 20 && typeof win.resets_at === "number") {
      const when = usage.formatResetIn(win.resets_at * 1000, now);
      if (when) text += `${DIM}, resets ${when}${RESET}`;
    }
    parts.push(text);
  }
  return parts.join(`${DIM} · ${RESET}`);
}

// ── GPT models ───────────────────────────────────────────────

// Whether the session is on one of the GPT models ccc's router serves: one the
// ChatGPT sign-in last listed, or a name only OpenAI uses.
function isGptModel(id, { home = HOME } = {}) {
  const bare = String(id || "").replace(/\[\d+m\]$/i, "");
  if (!bare) return false;
  if (/^(gpt-|o\d|codex-)/i.test(bare)) return true;
  const cached = profiles.readJsonFile(join(home, ".claude-profiles", "chatgpt", "models.json"));
  return cached.status === "ok" && Array.isArray(cached.value.models) && cached.value.models.some((m) => m && m.id === bare);
}

// A GPT model runs on the ChatGPT plan, so the Claude account's limits say
// nothing about it; say which plan pays instead.
const CHATGPT_PLAN_LABEL = `${DIM}Using ChatGPT plan${RESET}`;

// ── Rendering ────────────────────────────────────────────────

// White bold text on each segment's colour. The separator after a segment is
// drawn in its colour over the next segment's, or over the terminal's own
// background after the last one.
function renderSegments(segments) {
  return segments
    .map(({ text, color }, i) => {
      const next = segments[i + 1];
      const edge = next ? bg(next.color) + fg(color) : fg(color);
      return `${bg(color)}${fg(WHITE)}${BOLD} ${text} ${RESET}${edge}${SEPARATOR}${RESET}`;
    })
    .join("");
}

// The whole line for one refresh, from the session JSON Claude Code pipes in
// and the active profile directory.
function render(session, configDir, { home = HOME, configPath = CONFIG_PATH, now = Date.now() } = {}) {
  const data = session && typeof session === "object" ? session : {};
  const cwd = (data.workspace && data.workspace.current_dir) || "";
  const model = data.model && data.model.display_name;
  const branch = gitBranch(cwd || process.cwd());
  const dir = shortenDir(cwd, home);

  const segments = [{ text: resolveAccountName(configDir, { home, configPath }), color: COLORS.account }];
  if (model) segments.push({ text: model, color: COLORS.model });
  if (branch) segments.push({ text: BRANCH_MARK + branch, color: COLORS.git });
  if (dir) segments.push({ text: dir, color: COLORS.dir });

  const context = contextLabel(data.context_window);
  const limits = isGptModel(data.model && data.model.id, { home }) ? CHATGPT_PLAN_LABEL : limitsLabel(data.rate_limits, now);
  return renderSegments(segments) + (context ? "  " + context : "") + (limits ? "  " + limits : "");
}

// ── Entry point ──────────────────────────────────────────────

function main() {
  // Claude Code pipes a JSON blob in. Reading fd 0 when it is a terminal blocks
  // forever, which used to make running this by hand to debug it look like a
  // hang, so only read when something is actually piped.
  let session = {};
  if (!process.stdin.isTTY) {
    try {
      const raw = readFileSync(0, "utf8");
      if (raw.trim()) session = JSON.parse(raw);
    } catch (err) {
      debug(`ignoring unreadable input: ${err.message}`);
    }
  }

  process.stdout.write(render(session, process.env.CLAUDE_CONFIG_DIR) + "\n");
}

module.exports = {
  COLORS,
  resolveAccountName,
  gitBranch,
  shortenDir,
  contextLabel,
  limitsLabel,
  isGptModel,
  renderSegments,
  render,
  main,
};

if (require.main === module) {
  main();
}
