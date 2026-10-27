"use strict";

// profiles.cjs — the one place the profile layout, config.json and settings.json
// rules live.
//
// Every launcher and installer calls into this file instead of embedding its own
// `node -e` snippet. Paths and names arrive as argv entries or environment
// values and are never interpolated into JavaScript source, so a home directory
// containing a space, a quote or a backslash cannot change what the script does.
//
// CommonJS on purpose: statusline.js is CommonJS and requires it, picker.mjs is
// ESM and imports it, and the shell and batch launchers run it directly as a
// CLI. The explicit .cjs extension also keeps it loading when an unrelated
// ~/package.json declares {"type": "module"}.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const KEYCHAIN_SERVICE = "Claude Code-credentials";

// Used when config.json is absent. Deliberately the two accounts the installer
// sets up, not the three in config.example.json.
const DEFAULT_ACCOUNTS = {
  1: { name: "Account 1", configDir: null },
  2: { name: "Account 2", configDir: "account2" },
};

// ── Layout ───────────────────────────────────────────────────

function paths(home) {
  const base = home || os.homedir();
  const profiles = path.join(base, ".claude-profiles");
  return {
    home: base,
    profiles,
    claude: path.join(base, ".claude"),
    config: path.join(profiles, "config.json"),
    statusline: path.join(profiles, "statusline.js"),
  };
}

// ── Reading JSON ─────────────────────────────────────────────

// A missing file and an unparsable one are different events: the first is the
// normal first-run state, the second means a user's data is at risk. Callers
// that cannot tell them apart end up rewriting a file they failed to read.
function readJsonFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { status: "missing", value: undefined };
    return { status: "unreadable", error: err };
  }

  // A BOM is routine on Windows and makes JSON.parse throw on otherwise valid
  // content; stripping it is the difference between a merge and a wipe.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  let value;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    return { status: "invalid", error: err };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { status: "invalid", error: new Error(`${file} is not a JSON object`) };
  }
  return { status: "ok", value };
}

function readConfig(configPath) {
  const result = readJsonFile(configPath);
  if (result.status === "missing") return { status: "missing", config: { accounts: {} } };
  if (result.status !== "ok") return result;

  const config = result.value;
  if (config.accounts === undefined || config.accounts === null) config.accounts = {};
  if (typeof config.accounts !== "object" || Array.isArray(config.accounts)) {
    return { status: "invalid", error: new Error(`${configPath}: "accounts" is not an object`) };
  }
  return { status: "ok", config };
}

// What the picker falls back to when there is no config.json at all.
function defaultConfig() {
  return { accounts: JSON.parse(JSON.stringify(DEFAULT_ACCOUNTS)) };
}

// ── Writing JSON ─────────────────────────────────────────────

// Temp file plus rename, so an interrupted write cannot leave a half-written
// config.json behind — the state every "config.json was silently reset" report
// starts from.
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

// ── Accounts ─────────────────────────────────────────────────

function nextAccountNumber(config) {
  const keys = Object.keys((config && config.accounts) || {})
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  return Math.max(0, ...keys) + 1;
}

// Resolve a slot to a profile directory. An entry with no configDir is the
// default ~/.claude profile. With no entry at all, slot 1 is the default and
// everything else follows the accountN convention — the behaviour the launchers
// have always had when config.json does not mention a slot.
function resolveAccount(config, key, profilesDir) {
  const account = ((config && config.accounts) || {})[String(key)];

  if (account && account.configDir) {
    return {
      kind: "profile",
      dirName: account.configDir,
      dir: path.join(profilesDir, account.configDir),
      configured: true,
    };
  }
  if (account) return { kind: "default", configured: true };
  if (String(key) === "1") return { kind: "default", configured: false };

  const dirName = `account${key}`;
  return { kind: "profile", dirName, dir: path.join(profilesDir, dirName), configured: false };
}

function accountNameFor(config, dirName) {
  const accounts = (config && config.accounts) || {};
  const match = Object.values(accounts).find(
    (a) => a && typeof a === "object" && (dirName ? a.configDir === dirName : !a.configDir)
  );
  return match && match.name ? String(match.name) : null;
}

// ── Statusline ───────────────────────────────────────────────

// Claude Code runs statusLine.command through a shell, so the path has to
// survive it. An unquoted path breaks on the first space — "C:\Users\John
// Smith" and "/Users/me/Library/Mobile Documents" are both ordinary.
function quoteForShell(value, platform) {
  if ((platform || process.platform) === "win32") {
    // cmd.exe needs only the quotes; " is not a legal path character on NTFS,
    // and $ and ` are not special to cmd.
    return `"${value}"`;
  }
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function statusLineCommand(profilesDir, platform) {
  // Forward slashes so the same string works in cmd.exe and in a POSIX shell.
  const script = path.join(profilesDir, "statusline.js").replace(/\\/g, "/");
  return `node ${quoteForShell(script, platform)}`;
}

// Merge the statusLine key into an existing settings.json, preserving every
// other key. Refuses to write over a file it could not read, rather than
// replacing a user's theme, permissions and hooks with a one-key object.
function applyStatusLine(settingsPath, profilesDir, platform) {
  const existing = readJsonFile(settingsPath);
  if (existing.status === "unreadable" || existing.status === "invalid") {
    return { status: existing.status, error: existing.error };
  }

  const settings = existing.status === "missing" ? {} : existing.value;
  settings.statusLine = {
    type: "command",
    command: statusLineCommand(profilesDir, platform),
  };
  writeJsonAtomic(settingsPath, settings);
  return { status: existing.status === "missing" ? "created" : "updated", settings };
}

// Split a command line into words the way the shell running it would, for the
// one purpose of finding a script path inside it. Quotes group; on POSIX a
// backslash escapes, while to cmd.exe it is a path separator and a single
// quote is an ordinary character. A word the shell would expand — ~, $VAR,
// `cmd`, %VAR% — is flagged, because its real value cannot be known here.
function shellWords(command, platform) {
  const isWindows = (platform || process.platform) === "win32";
  const words = [];
  let word = null; // { text, expands } inside a word, null between words
  let quote = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

    if (!quote && /\s/.test(ch)) {
      word = null;
      continue;
    }
    if (!word) words.push((word = { text: "", expands: false }));

    if (isWindows) {
      // Only double quotes group, and %VAR% expands inside them as well.
      if (ch === '"') quote = quote ? null : ch;
      else {
        if (ch === "%") word.expands = true;
        word.text += ch;
      }
    } else if (quote === "'") {
      if (ch === "'") quote = null;
      else word.text += ch;
    } else if (ch === "\\" && next !== undefined && (!quote || '"\\$`'.includes(next))) {
      // Inside double quotes a backslash escapes only these four, which are
      // exactly the ones quoteForShell escapes.
      word.text += next;
      i++;
    } else if (ch === '"' || (ch === "'" && !quote)) {
      quote = quote ? null : ch;
    } else {
      if (ch === "$" || ch === "`" || (ch === "~" && !quote && word.text === "")) word.expands = true;
      word.text += ch;
    }
  }
  return words;
}

// Whether two paths name the same file, allowing for the forward slashes
// statusLineCommand writes on Windows, where case does not matter either.
function samePath(a, b, platform) {
  if ((platform || process.platform) === "win32") {
    return path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
  }
  return path.posix.normalize(a) === path.posix.normalize(b);
}

// The .claude-profiles script a statusLine command runs, or null when it runs
// something else. A path only the shell could finish — ~, $HOME, %USERPROFILE%
// — also gives null: if we cannot tell whether the script exists, we must not
// decide that it is gone.
function statusLineScript(command, platform) {
  const isWindows = (platform || process.platform) === "win32";
  const script = shellWords(command, platform).find((w) =>
    /\.claude-profiles[\\/].+\.[cm]?js$/i.test(w.text)
  );
  if (!script || script.expands) return null;
  return (isWindows ? path.win32 : path.posix).isAbsolute(script.text) ? script.text : null;
}

// Make sure a profile's settings.json runs the statusline, without overriding
// a choice the user made. The launchers call this on every launch, because a
// profile created by logging in for the first time — rather than by `ccc add`
// — never gets the key and silently shows no statusline.
//
//   no settings.json, or no statusLine key in it  -> ours is added
//   a .claude-profiles script that is gone        -> repointed at ours;
//     renaming or consolidating the statusline scripts leaves exactly this
//   anything else                                 -> left alone
//
// Like applyStatusLine, it never writes over a file it could not read.
function ensureStatusLine(settingsPath, profilesDir, platform) {
  const existing = readJsonFile(settingsPath);
  if (existing.status === "unreadable" || existing.status === "invalid") {
    return { status: existing.status, error: existing.error };
  }

  const settings = existing.status === "missing" ? {} : existing.value;
  const current = settings.statusLine;
  let status = existing.status === "missing" ? "created" : "added";

  if (current) {
    if (current.type !== "command" || typeof current.command !== "string") {
      return { status: "custom" };
    }
    const script = statusLineScript(current.command, platform);
    if (!script) return { status: "custom" };
    // Pointing at statusline.js itself counts even when it is missing: writing
    // the same path back cannot bring it back, the installer can.
    if (fs.existsSync(script) || samePath(script, path.join(profilesDir, "statusline.js"), platform)) {
      return { status: "current" };
    }
    status = "repointed";
  }

  settings.statusLine = {
    type: "command",
    command: statusLineCommand(profilesDir, platform),
  };
  writeJsonAtomic(settingsPath, settings);
  return { status, settings };
}

// ── Shared session history ───────────────────────────────────

// Every account shares one session history: <profile>/projects points at
// ~/.claude/projects, so /resume and the memory dir are common to all of them.
//
// Anything already at that path is left exactly as it is. A real directory
// there holds session transcripts, and replacing it with a link destroys them.
// Point linkPath at targetPath, and do nothing at all if something is already
// there. Returns one of: exists | linked | no-target | failed.
function ensureLink(linkPath, targetPath, platform) {
  // lstat, not existsSync: a symlink whose target is missing still occupies the
  // path and must not be replaced. A link that is already there is the settled
  // state; anything else is a real file or directory standing in the way, and
  // the caller needs to know the difference.
  try {
    const stat = fs.lstatSync(linkPath);
    return { status: stat.isSymbolicLink() ? "already-linked" : "exists" };
  } catch {}

  let targetStat;
  try {
    targetStat = fs.statSync(targetPath);
  } catch {
    return { status: "no-target" };
  }

  const isWindows = (platform || process.platform) === "win32";
  try {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    if (targetStat.isDirectory()) {
      // "junction" on Windows: unlike a real symlink it needs no administrator
      // rights and no Developer Mode, and unlike Git Bash's `ln -s` it does not
      // silently deep-copy the whole tree.
      fs.symlinkSync(targetPath, linkPath, isWindows ? "junction" : "dir");
    } else if (isWindows) {
      // Junctions are directory-only, so a shared file gets a hard link.
      fs.linkSync(targetPath, linkPath);
    } else {
      fs.symlinkSync(targetPath, linkPath, "file");
    }
    return { status: "linked", target: targetPath };
  } catch (err) {
    return { status: "failed", error: err };
  }
}

function ensureSharedProjects(profileDir, claudeDir, platform) {
  if (!profileDir) return { status: "skipped" };

  const target = path.join(claudeDir, "projects");
  try {
    fs.mkdirSync(profileDir, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
  } catch (err) {
    return { status: "failed", error: err };
  }

  return ensureLink(path.join(profileDir, "projects"), target, platform);
}

// ── Credentials ──────────────────────────────────────────────

// On macOS, Claude Code stores OAuth credentials in the login Keychain under a
// service name derived from the config dir it was launched with:
//   "Claude Code-credentials"                    -> default profile (~/.claude)
//   "Claude Code-credentials-<sha256(dir)[0:8]>" -> any CLAUDE_CONFIG_DIR
// The hash is taken over the literal directory string Claude Code saw, so
// callers must pass the same absolute path they export.
function keychainService(dir, isDefault) {
  if (isDefault) return KEYCHAIN_SERVICE;
  return `${KEYCHAIN_SERVICE}-${crypto.createHash("sha256").update(dir).digest("hex").slice(0, 8)}`;
}

// Whether the Keychain holds a login for this profile. Attributes only — no -w
// — so this never reads the secret and never raises a Keychain prompt.
//
// CCC_NO_KEYCHAIN skips the lookup. The default profile's service name does not
// depend on HOME, so a test with a throwaway HOME would otherwise find the real
// one.
function inKeychain(dir, isDefault, platform) {
  if ((platform || process.platform) !== "darwin" || process.env.CCC_NO_KEYCHAIN) return false;
  try {
    execFileSync("security", ["find-generic-password", "-s", keychainService(dir, isDefault)], {
      stdio: "ignore",
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

// Who a profile is signed in as, as far as can be told without reading a
// secret. Signed in means a Keychain entry or, as older builds, Linux and
// Windows keep it, <dir>/.credentials.json. Identity comes from the profile's
// .claude.json, which Claude Code writes at login: the default profile's sits
// at ~/.claude.json in the home directory, every other profile keeps its own
// inside the config dir.
function accountState(configDir, { home, platform } = {}) {
  const p = paths(home);
  const isDefault = !configDir;
  const dir = isDefault ? p.claude : path.join(p.profiles, configDir);
  const state = {
    dir,
    isDefault,
    signedIn: inKeychain(dir, isDefault, platform),
    email: null,
    displayName: null,
    accountUuid: null,
    subscription: null,
    tier: null,
  };

  const creds = readJsonFile(path.join(dir, ".credentials.json"));
  if (creds.status === "ok") {
    const oauth = creds.value.claudeAiOauth || {};
    state.signedIn = true;
    state.subscription = oauth.subscriptionType || null;
    state.tier = oauth.rateLimitTier || null;
  }

  const identity = readJsonFile(isDefault ? path.join(p.home, ".claude.json") : path.join(dir, ".claude.json"));
  if (identity.status === "ok") {
    const acct = identity.value.oauthAccount || {};
    state.email = acct.emailAddress || null;
    state.displayName = acct.displayName || null;
    state.accountUuid = acct.accountUuid || null;
    state.subscription = state.subscription || acct.organizationType || null; // claude_max | claude_pro | ...
    state.tier = state.tier || acct.organizationRateLimitTier || null; // default_claude_max_20x | ...
  }
  return state;
}

// ── Composite operation used by `ccc add` ────────────────────

function addAccount({ home, key, name, platform }) {
  const p = paths(home);
  const read = readConfig(p.config);
  if (read.status === "unreadable" || read.status === "invalid") {
    return { status: read.status, error: read.error };
  }

  const config = read.config;
  const dirName = `account${key}`;
  const dir = path.join(p.profiles, dirName);

  config.accounts[String(key)] = { name, configDir: dirName };
  writeJsonAtomic(p.config, config);

  fs.mkdirSync(dir, { recursive: true });
  const settings = applyStatusLine(path.join(dir, "settings.json"), p.profiles, platform);
  const shared = ensureSharedProjects(dir, p.claude, platform);

  return { status: "ok", key: String(key), name, dirName, dir, settings, shared };
}

// ── The ChatGPT account ──────────────────────────────────────
//
// An entry with "provider": "chatgpt" runs Claude Code on the GPT models, signed
// in with ChatGPT rather than a Claude login. Any other account can have the GPT
// models added to its /model picker — for one launch with --gpt, or for every
// launch with "gpt": true — while its own Claude login carries on as usual.

function isGptAccount(entry) {
  return Boolean(entry && typeof entry === "object" && entry.provider === "chatgpt");
}

// The slot of the ChatGPT account, adding one when there is none. Called after a
// ChatGPT sign-in, so that signing in is all it takes to get the entry.
function ensureGptAccount({ home, name = "ChatGPT", platform } = {}) {
  const p = paths(home);
  const read = readConfig(p.config);
  if (read.status === "unreadable" || read.status === "invalid") return { status: read.status, error: read.error };
  const config = read.status === "missing" ? defaultConfig() : read.config;

  const existing = Object.entries(config.accounts).find(([, entry]) => isGptAccount(entry));
  if (existing) return { status: "ok", key: existing[0], name: existing[1].name || name, created: false };

  const key = String(nextAccountNumber(config));
  const dirName = `account${key}`;
  const dir = path.join(p.profiles, dirName);
  config.accounts[key] = { name, configDir: dirName, provider: "chatgpt" };
  writeJsonAtomic(p.config, config);
  fs.mkdirSync(dir, { recursive: true });
  applyStatusLine(path.join(dir, "settings.json"), p.profiles, platform);
  ensureSharedProjects(dir, p.claude, platform);
  return { status: "ok", key, name, created: true, dir };
}

function syncGptWorkflow({ home, sourceKey, platform } = {}) {
  const p = paths(home);
  const read = readConfig(p.config);
  if (read.status !== "ok") return { status: read.status, error: read.error };
  const source = read.config.accounts[String(sourceKey)];
  if (!source || isGptAccount(source)) return { status: "bad-source" };
  const target = Object.entries(read.config.accounts).find(([, entry]) => isGptAccount(entry));
  if (!target) return { status: "no-gpt" };
  const sourceDir = source.configDir ? path.join(p.profiles, source.configDir) : p.claude;
  const targetDir = target[1].configDir ? path.join(p.profiles, target[1].configDir) : p.claude;
  if (sourceDir === targetDir) return { status: "bad-source" };
  const stateFile = (dir) => dir === p.claude ? path.join(p.home, ".claude.json") : path.join(dir, ".claude.json");
  const files = {
    sourceSettings: path.join(sourceDir, "settings.json"),
    targetSettings: path.join(targetDir, "settings.json"),
    sourcePlugins: path.join(sourceDir, "plugins", "installed_plugins.json"),
    targetPlugins: path.join(targetDir, "plugins", "installed_plugins.json"),
    sourceMarkets: path.join(sourceDir, "plugins", "known_marketplaces.json"),
    targetMarkets: path.join(targetDir, "plugins", "known_marketplaces.json"),
    sourceState: stateFile(sourceDir),
    targetState: stateFile(targetDir),
  };
  const data = {};
  const original = {};
  for (const [key, file] of Object.entries(files)) {
    const result = readJsonFile(file);
    if (result.status !== "ok" && result.status !== "missing") return { status: result.status, error: new Error(`Cannot read ${file}: ${result.error.message}`) };
    data[key] = result.value || {};
    original[key] = JSON.stringify(data[key]);
  }
  const { sourceSettings, targetSettings, sourcePlugins, targetPlugins, sourceMarkets, targetMarkets, sourceState, targetState } = data;
  const result = { status: "ok", key: target[0], plugins: [], servers: [], linked: [], kept: [], skipped: [] };
  const enabled = { ...targetSettings.enabledPlugins };
  const installed = { ...targetPlugins.plugins };
  for (const [id, value] of Object.entries(sourceSettings.enabledPlugins || {})) {
    if (value === false) continue;
    if (Object.hasOwn(enabled, id)) {
      result.kept.push(id);
      continue;
    }
    const entries = (sourcePlugins.plugins && sourcePlugins.plugins[id]) || [];
    if (!Array.isArray(entries)) return { status: "invalid", error: new Error(`Invalid plugin installation list for ${id}`) };
    const available = entries.filter((entry) => entry && entry.scope === "user" && typeof entry.installPath === "string" && path.isAbsolute(entry.installPath) && fs.existsSync(entry.installPath));
    if (!available.length) {
      result.skipped.push(`${id}: no local user installation`);
      continue;
    }
    const market = id.slice(id.lastIndexOf("@") + 1);
    const known = sourceMarkets[market];
    if (known && targetMarkets[market] && JSON.stringify(known.source) !== JSON.stringify(targetMarkets[market].source)) {
      result.skipped.push(`${id}: the target uses a different marketplace source`);
      continue;
    }
    if (!Object.hasOwn(targetMarkets, market) && known) {
      if (!["github", "directory", "file"].includes(known.source && known.source.source) || known.source.headers || known.source.headersHelper) {
        result.skipped.push(`${id}: add its marketplace in the ChatGPT profile first`);
        continue;
      }
      targetMarkets[market] = known;
    }
    enabled[id] = value;
    if (!Object.hasOwn(installed, id)) installed[id] = available;
    const options = sourceSettings.pluginConfigs && sourceSettings.pluginConfigs[id] && sourceSettings.pluginConfigs[id].options;
    if (options) {
      const existing = targetSettings.pluginConfigs && targetSettings.pluginConfigs[id];
      targetSettings.pluginConfigs = { ...targetSettings.pluginConfigs, [id]: { ...existing, options: { ...options, ...(existing && existing.options) } } };
    }
    result.plugins.push(id);
  }
  if (result.plugins.length) {
    targetSettings.enabledPlugins = enabled;
    targetPlugins.version = targetPlugins.version || sourcePlugins.version || 2;
    targetPlugins.plugins = installed;
  }
  const servers = { ...targetState.mcpServers };
  for (const [name, server] of Object.entries(sourceState.mcpServers || {})) {
    if (!server || typeof server !== "object") return { status: "invalid", error: new Error(`Invalid MCP configuration for ${name}`) };
    if (Object.hasOwn(servers, name)) {
      result.kept.push(`MCP ${name}`);
      continue;
    }
    let url;
    try {
      url = new URL(server.url);
    } catch {}
    if (!["http", "sse"].includes(server.type) || !url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || server.headers || server.headersHelper || server.env || (server.oauth && server.oauth.clientSecret)) {
      result.skipped.push(`MCP ${name}: re-add it without copying inline credentials`);
      continue;
    }
    const clean = { type: server.type, url: server.url };
    if (server.oauth) {
      const { clientId, callbackPort } = server.oauth;
      if (typeof clientId === "string" || typeof callbackPort === "number") clean.oauth = {
        ...(typeof clientId === "string" ? { clientId } : {}),
        ...(typeof callbackPort === "number" ? { callbackPort } : {}),
      };
    }
    servers[name] = clean;
    result.servers.push(name);
  }
  if (result.servers.length) targetState.mcpServers = servers;
  const targets = ["targetSettings", "targetPlugins", "targetMarkets", "targetState"];
  for (const key of targets) {
    const current = readJsonFile(files[key]);
    if (!["ok", "missing"].includes(current.status) || JSON.stringify(current.value || {}) !== original[key]) {
      return { status: "changed", error: new Error(`${files[key]} changed during the sync; run the command again`) };
    }
  }
  for (const key of targets) {
    if (original[key] !== JSON.stringify(data[key])) require("./chatgpt.cjs").writePrivate(files[key], data[key]);
  }
  for (const name of ["skills", "commands", "agents", "rules"]) {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(sourceDir, name));
    } catch {}
    for (const entry of entries.filter((e) => e !== "synced" && !e.startsWith("."))) {
      const link = ensureLink(path.join(targetDir, name, entry), path.join(sourceDir, name, entry), platform);
      if (link.status === "linked") result.linked.push(`${name}/${entry}`);
      else if (link.status === "exists" || link.status === "already-linked") result.kept.push(`${name}/${entry}`);
      else result.skipped.push(`${name}/${entry}: could not link it`);
    }
  }
  if (fs.existsSync(path.join(sourceDir, "CLAUDE.md"))) {
    const link = ensureLink(path.join(targetDir, "CLAUDE.md"), path.join(sourceDir, "CLAUDE.md"), platform);
    if (link.status === "linked") result.linked.push("CLAUDE.md");
    else if (link.status === "exists" || link.status === "already-linked") result.kept.push("CLAUDE.md");
    else result.skipped.push("CLAUDE.md: could not link it");
  }
  return result;
}

// The model a profile starts on when nothing else says, as /model saved it.
function savedModel(settingsPath) {
  const settings = readJsonFile(settingsPath);
  return settings.status === "ok" && typeof settings.value.model === "string" ? settings.value.model : null;
}

// How to start a slot:
//   "gpt"     the ChatGPT account: GPT models only
//   "mixed"   a Claude account with the GPT models added — asked for with
//             --gpt, set with `ccc gpt on`, or because /model saved a GPT model
//             as the account's default, which plain Claude Code cannot run
//   "claude"  as always
function launchMode(config, key, { home, wantGpt = false } = {}) {
  const entry = ((config && config.accounts) || {})[String(key)];
  if (isGptAccount(entry)) return { mode: "gpt" };
  if (wantGpt) return { mode: "mixed", reason: "asked" };
  if (entry && entry.gpt === true) return { mode: "mixed", reason: "always" };

  const p = paths(home);
  const resolved = resolveAccount(config, key, p.profiles);
  const dir = resolved.kind === "default" ? p.claude : resolved.dir;
  const model = savedModel(path.join(dir, "settings.json"));
  if (model && require("./chatgpt.cjs").isGptModelId(model, gptModels(home))) return { mode: "mixed", reason: "saved-model", model };
  return { mode: "claude" };
}

// The GPT models last listed for the ChatGPT sign-in, without asking OpenAI.
function gptModels(home) {
  const cached = readJsonFile(path.join(paths(home).profiles, "chatgpt", "models.json"));
  return cached.status === "ok" && Array.isArray(cached.value.models) ? cached.value.models : [];
}

// `ccc gpt on|off <n>`: offer the GPT models in a Claude account on every
// launch, or stop.
function setGpt({ home, key, on }) {
  const p = paths(home);
  const read = readConfig(p.config);
  if (read.status !== "ok") return { status: read.status === "missing" ? "no-account" : read.status, error: read.error };
  const entry = read.config.accounts[String(key)];
  if (!entry || typeof entry !== "object") return { status: "no-account" };
  if (isGptAccount(entry)) return { status: "is-gpt" };
  if (on) entry.gpt = true;
  else delete entry.gpt;
  writeJsonAtomic(p.config, read.config);
  return { status: "ok", name: entry.name || `Account ${key}` };
}

// ── Renaming and removing ────────────────────────────────────

function renameAccount({ home, key, name }) {
  const p = paths(home);
  const read = readConfig(p.config);
  if (read.status !== "ok") return { status: read.status === "missing" ? "no-account" : read.status, error: read.error };

  const entry = read.config.accounts[String(key)];
  if (!entry || typeof entry !== "object") return { status: "no-account" };

  const previous = entry.name;
  entry.name = name;
  writeJsonAtomic(p.config, read.config);
  return { status: "ok", previous };
}

// Takes the account off the list and nothing more. Its folder holds its
// settings and session bookkeeping, and on macOS its login stays in the
// Keychain until `ccc logout` clears it, so deleting either is left to the user.
function removeAccount({ home, key }) {
  const p = paths(home);
  const read = readConfig(p.config);
  if (read.status !== "ok") return { status: read.status === "missing" ? "no-account" : read.status, error: read.error };

  const entry = read.config.accounts[String(key)];
  if (!entry) return { status: "no-account" };

  delete read.config.accounts[String(key)];
  writeJsonAtomic(p.config, read.config);
  const dirName = entry && typeof entry === "object" && entry.configDir ? entry.configDir : null;
  return { status: "ok", name: entry.name || null, dir: dirName ? path.join(p.profiles, dirName) : null };
}

// ── Repair ───────────────────────────────────────────────────

// Check one account and fix what can be fixed without asking: its folder, the
// shared session history link and the statusline. What only the user can do —
// signing in, or putting a different Claude account in a slot that duplicates
// another — is reported along with the command that does it.
//
// `earlier` is the states of the accounts listed before this one, so a slot
// signed into the same Claude account as an earlier slot can be pointed out.
//
// Returns findings of { level: "ok" | "fixed" | "todo", text }.
function repairAccount(key, entry, { home, platform, earlier = [] } = {}) {
  const p = paths(home);
  const findings = [];
  const note = (level, text) => findings.push({ level, text });
  const configDir = entry && typeof entry === "object" && entry.configDir ? entry.configDir : null;
  const dir = configDir ? path.join(p.profiles, configDir) : p.claude;

  if (configDir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      note("fixed", "created its folder");
    }
    const shared = ensureSharedProjects(dir, p.claude, platform);
    if (shared.status === "linked") note("fixed", "linked the shared session history");
    else if (shared.status === "already-linked") note("ok", "shares the session history");
    else if (shared.status === "exists") note("todo", "keeps a projects folder of its own, so /resume cannot see the other accounts' sessions");
    else note("todo", `could not link the shared session history${shared.error ? `: ${shared.error.message}` : ""}`);
  }

  const statusLine = ensureStatusLine(path.join(dir, "settings.json"), p.profiles, platform);
  if (statusLine.status === "current") note("ok", "statusline is set up");
  else if (statusLine.status === "custom") note("ok", "uses a statusline of its own");
  else if (statusLine.status === "repointed") note("fixed", "pointed its statusline back at statusline.js");
  else if (statusLine.status === "created" || statusLine.status === "added") note("fixed", "added the statusline");
  else note("todo", "settings.json does not parse, so it was left alone — fix it by hand");

  if (isGptAccount(entry)) {
    const chatgpt = require("./chatgpt.cjs").status({ home });
    if (!chatgpt.signedIn) note("todo", "ChatGPT is not signed in — run: ccc gpt login");
    else if (!chatgpt.planUsage) note("todo", "ccc may not use the ChatGPT plan — run ccc gpt login and allow it");
    else note("ok", `signed in with ChatGPT${chatgpt.email ? ` as ${chatgpt.email}` : ""} · ${chatgpt.planLabel}`);
    return { findings, state: { key: String(key), provider: "chatgpt", signedIn: chatgpt.signedIn, accountUuid: null } };
  }

  // /model can save a GPT model as the account's default. ccc then adds the GPT
  // models whenever it starts the account, but plain `claude` cannot run it —
  // which matters for the default profile, the one `claude` itself opens.
  const model = savedModel(path.join(dir, "settings.json"));
  if (model && require("./chatgpt.cjs").isGptModelId(model, gptModels(home))) {
    if (configDir) note("ok", `starts on ${model}, so ccc adds the GPT models when it starts it`);
    else note("todo", `starts on ${model}, which plain \`claude\` cannot run — start it with ccc ${key}, or pick a Claude model in /model`);
  }

  const state = accountState(configDir, { home, platform });
  if (!state.signedIn) {
    note("todo", `not signed in — run: ccc login ${key}`);
  } else {
    note("ok", state.email ? `signed in as ${state.email}` : "signed in");
    const twin = state.accountUuid && earlier.find((o) => o.signedIn && o.accountUuid === state.accountUuid);
    if (twin) note("todo", `same Claude account as [${twin.key}], so it shares those limits — to use another, run: ccc login ${key}`);
  }

  return { findings, state: { ...state, key: String(key) } };
}

// ── What `ccc help` prints ───────────────────────────────────

const HELP = `ccc — Claude Code Companion

  ccc                      pick an account: who it is signed in as, and its live usage
  ccc <n> [claude args]    start Claude Code with account n, e.g.  ccc 2 -c
  ccc list                 show every account and its live usage, then exit
  ccc add [name]           add an account
  ccc login <n>            sign account n in again, or into a different Claude account
  ccc logout <n>           sign account n out
  ccc rename <n> <name>    rename account n
  ccc remove <n>           take account n off the list (its folder is kept)
  ccc repair [n]           check account n, or every account, and fix what it can
  ccc help                 show this

  Also: relogin = login, ls = list, rm = remove.

Account launches bypass tool approvals by default (--dangerously-skip-permissions).
Use only in trusted projects. An explicit --permission-mode is honored instead.

GPT models, on your ChatGPT plan:

  ccc gpt login            sign in with ChatGPT; adds an account that runs
                           Claude Code on the GPT models
  ccc <n> --gpt            start account n with the GPT models added to /model
  ccc gpt on <n>           always add them to account n (ccc gpt off <n> stops)
  ccc gpt sync <n>         copy account n's plugins and public MCP setup into
                           the ChatGPT profile, preserving existing choices
  ccc gpt status           show the ChatGPT sign-in and its models
  ccc gpt logout           sign ChatGPT out

Claude usage comes live from Claude Code. ChatGPT usage is Codex's allowance,
shown only for a matching account email; it is not ccc's connected-app cap.
Set CCC_NO_USAGE=1 to skip lookups and open the picker instantly.
GPT requests use your ChatGPT plan; manage ccc's cap and optional credit spending
at https://chatgpt.com/settings/usage

Accounts are listed in ~/.claude-profiles/config.json.`;

// ── CLI ──────────────────────────────────────────────────────
//
// Exit codes: 0 success, 1 usage error, 2 refused because user data would be at
// risk (an unreadable or malformed config.json / settings.json).

const USAGE = `usage: profiles.cjs <command> [args]

  next-account-number              print the next free account slot
  resolve-account <slot>           print __DEFAULT__ or the profile directory
  add-account <slot>               create a profile (name from CC_ACCOUNT_NAME)
  apply-statusline <settings.json> merge the statusLine key into a settings file
  ensure-statusline <settings.json> add the statusLine key unless one is set
  ensure-shared-projects <dir>     link <dir>/projects at ~/.claude/projects
  ensure-link <link> <target>      link <link> at <target>, never replacing
  statusline-command               print the configured statusLine command
  rename-account <slot>            rename a slot (name from CC_ACCOUNT_NAME)
  remove-account <slot>            take a slot off the list, keeping its files
  repair [slot]                    check one slot or all of them, fixing what it can
  launch-mode <slot> [--gpt]       print how to start a slot: claude, mixed or gpt
  set-gpt <slot> on|off            always add the GPT models to a slot, or stop
  ensure-gpt-account               print the ChatGPT account's slot, adding one
  sync-gpt <source-slot>            merge plugins and public MCP setup into GPT
  help                             print the help ccc shows for \`ccc help\``;

function fail(message) {
  process.stderr.write(`  ${message}\n`);
  return 2;
}

function usage() {
  process.stderr.write(USAGE + "\n");
  return 1;
}

function main(argv) {
  const [command, ...rest] = argv;
  const p = paths();

  switch (command) {
    case "next-account-number": {
      const read = readConfig(p.config);
      if (read.status !== "ok" && read.status !== "missing") {
        return fail(`Cannot read ${p.config}: ${read.error.message}`);
      }
      process.stdout.write(String(nextAccountNumber(read.config)));
      return 0;
    }

    case "resolve-account": {
      if (!rest[0]) return usage();
      const read = readConfig(p.config);
      if (read.status !== "ok" && read.status !== "missing") {
        return fail(`Cannot read ${p.config}: ${read.error.message}`);
      }
      const resolved = resolveAccount(read.config, rest[0], p.profiles);
      process.stdout.write(resolved.kind === "default" ? "__DEFAULT__" : resolved.dir);
      return 0;
    }

    case "add-account": {
      const key = rest[0];
      const name = process.env.CC_ACCOUNT_NAME;
      if (!key || !name) return usage();
      const result = addAccount({ home: p.home, key, name });
      if (result.status !== "ok") {
        return fail(`Refusing to rewrite ${p.config}: ${result.error.message}`);
      }
      if (result.settings.status === "unreadable" || result.settings.status === "invalid") {
        return fail(`Created ${result.dir} but left settings.json alone: ${result.settings.error.message}`);
      }
      process.stdout.write(result.dir);
      return 0;
    }

    case "apply-statusline": {
      if (!rest[0]) return usage();
      const result = applyStatusLine(rest[0], p.profiles);
      if (result.status === "unreadable" || result.status === "invalid") {
        return fail(`Leaving ${rest[0]} alone: ${result.error.message}`);
      }
      return 0;
    }

    case "ensure-statusline": {
      if (!rest[0]) return usage();
      // Runs on every launch, and a profile without a statusline still works,
      // so this never fails the caller — it just reports what happened.
      process.stdout.write(ensureStatusLine(rest[0], p.profiles).status);
      return 0;
    }

    case "ensure-shared-projects": {
      if (!rest[0]) return usage();
      const result = ensureSharedProjects(rest[0], p.claude);
      // A profile without the shared link still works, so this never fails the
      // caller — it just reports what happened.
      process.stdout.write(result.status);
      return 0;
    }

    case "ensure-link": {
      if (!rest[0] || !rest[1]) return usage();
      // Sharing an item is best-effort: a profile without it still works, so
      // report what happened and let the caller decide what to print.
      process.stdout.write(ensureLink(rest[0], rest[1]).status);
      return 0;
    }

    case "statusline-command":
      process.stdout.write(statusLineCommand(p.profiles));
      return 0;

    case "rename-account": {
      const key = rest[0];
      const name = process.env.CC_ACCOUNT_NAME;
      if (!key || !name) return usage();
      const result = renameAccount({ home: p.home, key, name });
      if (result.status === "no-account") return noAccount(key);
      if (result.status !== "ok") return fail(`Refusing to rewrite ${p.config}: ${result.error.message}`);
      process.stdout.write(`  Account ${key} is now "${name}".\n`);
      return 0;
    }

    case "remove-account": {
      const key = rest[0];
      if (!key) return usage();
      const read = readConfig(p.config);
      const entry = read.status === "ok" ? read.config.accounts[String(key)] : null;
      const before = entry && typeof entry === "object" ? accountState(entry.configDir || null, { home: p.home }) : null;

      const result = removeAccount({ home: p.home, key });
      if (result.status === "no-account") return noAccount(key);
      if (result.status !== "ok") return fail(`Refusing to rewrite ${p.config}: ${result.error.message}`);

      const lines = [`  Removed account ${key}${result.name ? ` (${result.name})` : ""} from the list.`];
      if (result.dir) lines.push(`  Its folder is still at ${result.dir}; delete it yourself if you no longer need it.`);
      if (before && before.signedIn) lines.push(`  It is still signed in. To sign it out as well, run: ccc logout ${key}`);
      process.stdout.write(lines.join("\n") + "\n");
      return 0;
    }

    case "repair":
      return repairCommand(p, rest[0]);

    case "launch-mode": {
      if (!rest[0]) return usage();
      const read = readConfig(p.config);
      if (read.status !== "ok" && read.status !== "missing") {
        return fail(`Cannot read ${p.config}: ${read.error.message}`);
      }
      const config = read.status === "missing" ? defaultConfig() : read.config;
      process.stdout.write(launchMode(config, rest[0], { home: p.home, wantGpt: rest.includes("--gpt") }).mode);
      return 0;
    }

    case "set-gpt": {
      const [key, onOff] = rest;
      if (!key || (onOff !== "on" && onOff !== "off")) return usage();
      const result = setGpt({ home: p.home, key, on: onOff === "on" });
      if (result.status === "no-account") return noAccount(key);
      if (result.status === "is-gpt") {
        process.stderr.write(`  Account ${key} is the ChatGPT account; it always runs on the GPT models.\n`);
        return 1;
      }
      if (result.status !== "ok") return fail(`Refusing to rewrite ${p.config}: ${result.error.message}`);
      process.stdout.write(
        onOff === "on"
          ? `  Account ${key} (${result.name}) now starts with the GPT models in /model.\n`
          : `  Account ${key} (${result.name}) no longer adds the GPT models; ccc ${key} --gpt still does for one launch.\n`
      );
      return 0;
    }

    case "sync-gpt": {
      if (!/^\d+$/.test(rest[0] || "") || rest.length !== 1) return usage();
      const result = syncGptWorkflow({ home: p.home, sourceKey: rest[0] });
      if (result.status === "bad-source") return fail("Choose a configured Claude account as the source. ccc list shows the numbers.");
      if (result.status === "no-gpt") return fail("Add the ChatGPT profile first with: ccc gpt login");
      if (result.status !== "ok") return fail(result.error ? result.error.message : "Could not read the account configuration");
      process.stdout.write(`  ChatGPT account ${result.key}: added ${result.plugins.length} plugins, ${result.servers.length} public MCP configurations, ${result.linked.length} customizations.\n`);
      process.stdout.write("  Existing choices, credentials, permissions and user hooks were left alone.\n");
      if (result.servers.length) process.stdout.write("  Remote MCP servers may need their own sign-in through /mcp.\n");
      for (const item of result.skipped) process.stdout.write(`  Skipped ${item}\n`);
      process.stdout.write(`  Restart ccc ${result.key} to load the changes.\n`);
      return 0;
    }

    case "ensure-gpt-account": {
      const result = ensureGptAccount({ home: p.home, name: process.env.CC_ACCOUNT_NAME || "ChatGPT" });
      if (result.status !== "ok") return fail(`Refusing to rewrite ${p.config}: ${result.error.message}`);
      process.stdout.write(result.key);
      return 0;
    }

    case "help":
      process.stdout.write(HELP + "\n");
      return 0;

    default:
      return usage();
  }
}

function noAccount(key) {
  process.stderr.write(`  There is no account ${key}. ccc list shows the numbers.\n`);
  return 1;
}

// `ccc repair [slot]`. Exits 0 when nothing is left for the user to do, 1 when
// something is — the lines marked ! — and 2 when config.json cannot be read.
function repairCommand(p, slot) {
  const read = readConfig(p.config);
  if (read.status !== "ok" && read.status !== "missing") {
    return fail(`Cannot read ${p.config}: ${read.error.message}`);
  }
  const config = read.status === "missing" ? defaultConfig() : read.config;
  const keys = Object.keys(config.accounts);
  if (slot !== undefined && !keys.includes(String(slot))) return noAccount(slot);

  const tty = process.stdout.isTTY;
  const paint = (code, text) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
  const MARK = { ok: paint("32", "✓"), fixed: paint("36", "+"), todo: paint("33", "!") };
  const out = (line = "") => process.stdout.write(line + "\n");

  const earlier = [];
  const counts = { ok: 0, fixed: 0, todo: 0 };
  for (const key of keys) {
    const entry = config.accounts[key];
    if (slot !== undefined && key !== String(slot)) {
      // Not being repaired, but still needed to spot a duplicate login.
      const configDir = entry && typeof entry === "object" ? entry.configDir || null : null;
      earlier.push({ ...accountState(configDir, { home: p.home }), key });
      continue;
    }

    const name = entry && typeof entry === "object" && entry.name ? entry.name : `Account ${key}`;
    const { findings, state } = repairAccount(key, entry, { home: p.home, earlier });
    earlier.push(state);

    out();
    out(`  [${key}] ${name}`);
    for (const finding of findings) {
      counts[finding.level]++;
      out(`      ${MARK[finding.level]} ${finding.text}`);
    }
  }

  if (!fs.existsSync(p.statusline)) {
    counts.todo++;
    out();
    out(`  ${MARK.todo} ${p.statusline} is missing, so no account shows a statusline — re-run the installer`);
  }

  out();
  if (counts.fixed) out(`  Fixed ${counts.fixed} thing${counts.fixed === 1 ? "" : "s"}.`);
  if (counts.todo) out(`  ${counts.todo} thing${counts.todo === 1 ? " needs" : "s need"} you: the lines marked !`);
  if (!counts.fixed && !counts.todo) out("  Everything is in order.");
  return counts.todo ? 1 : 0;
}

module.exports = {
  KEYCHAIN_SERVICE,
  DEFAULT_ACCOUNTS,
  paths,
  readJsonFile,
  readConfig,
  defaultConfig,
  writeJsonAtomic,
  nextAccountNumber,
  resolveAccount,
  accountNameFor,
  quoteForShell,
  statusLineCommand,
  applyStatusLine,
  statusLineScript,
  ensureStatusLine,
  ensureLink,
  ensureSharedProjects,
  keychainService,
  inKeychain,
  accountState,
  addAccount,
  isGptAccount,
  ensureGptAccount,
  syncGptWorkflow,
  savedModel,
  launchMode,
  gptModels,
  setGpt,
  renameAccount,
  removeAccount,
  repairAccount,
  HELP,
  main,
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
