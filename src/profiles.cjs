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
    if (fs.existsSync(script)) return { status: "current" };
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
  statusline-command               print the configured statusLine command`;

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

    default:
      return usage();
  }
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
  addAccount,
  main,
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
