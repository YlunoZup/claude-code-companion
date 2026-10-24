"use strict";

// usage.cjs — how much of an account's 5-hour and weekly limits is left, live.
//
// The numbers come from Claude Code itself: a print-mode session that sends one
// get_usage control request — the data the /usage dialog shows — and exits. It
// sends no prompt, so it makes no model call and uses nothing up. Claude Code
// reads the profile's credentials and refreshes an expired token under its own
// locks, so this module never sees a token. Reading one here and calling the
// usage endpoint directly would be quicker, but a token refreshed here would
// race any Claude Code session running on the same account, and a lost race can
// sign that account out.
//
// The session runs with hooks off, no MCP servers and nothing saved to disk, so
// it does nothing beyond answering the request.

const { spawn } = require("child_process");
const os = require("os");

const REQUEST_ID = "ccc-usage";

const CLAUDE_ARGS = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--no-session-persistence",
  "--strict-mcp-config",
  "--settings",
  JSON.stringify({ disableAllHooks: true }),
];

// Claude Code takes a second or two to start; a cold start after an update
// can take several.
const DEFAULT_TIMEOUT_MS = 20000;

// ── Parsing the answer ───────────────────────────────────────

// One window as the usage endpoint reports it — { utilization: percent used,
// resets_at: ISO time, or null while no window is open } — as
// { used, left, resetsAt (epoch ms or null) }.
function toWindow(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.utilization !== "number") return null;
  const used = Math.min(100, Math.max(0, raw.utilization));
  const resetsAt = raw.resets_at ? Date.parse(raw.resets_at) : NaN;
  return { used, left: 100 - used, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null };
}

// The get_usage answer as
//   { status: "ok", subscriptionType, fiveHour, weekly }  either window may be null
//   { status: "unavailable", subscriptionType }  no plan limits apply: an API
//                                                key, Bedrock, Vertex, or a
//                                                login without the profile scope
//   { status: "error", error }
function parseUsage(answer) {
  if (!answer || typeof answer !== "object") return { status: "error", error: "no usage in the answer" };
  const subscriptionType = answer.subscription_type || null;
  if (!answer.rate_limits_available || !answer.rate_limits) return { status: "unavailable", subscriptionType };
  return {
    status: "ok",
    subscriptionType,
    fiveHour: toWindow(answer.rate_limits.five_hour),
    weekly: toWindow(answer.rate_limits.seven_day),
  };
}

// ── Talking to Claude Code ───────────────────────────────────

// Quote one argument the way a Windows program's C runtime splits them:
// backslashes are literal except before a quote, so those, and any run at the
// end, are doubled.
function quoteWindowsArg(arg) {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
}

// npm installs claude on Windows as a .cmd shim, which only cmd.exe can run,
// and Node will not hand arguments to cmd.exe quoted. So build the line here.
// Nothing in CLAUDE_ARGS contains a character cmd.exe treats specially outside
// quotes (& | < > ^ %), which is what makes this safe.
function spawnClaude(command, args, options, platform) {
  if ((platform || process.platform) !== "win32") return spawn(command, args, options);
  const line = [command, ...args].map(quoteWindowsArg).join(" ");
  return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
    ...options,
    windowsVerbatimArguments: true,
  });
}

// On Windows cmd.exe stands between this process and claude, and killing it
// leaves claude running on its own; take the whole tree down instead.
function stop(child, platform) {
  if ((platform || process.platform) !== "win32") {
    child.kill();
    return;
  }
  if (!child.pid) return;
  spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
}

// Live usage for one profile: configDir is its CLAUDE_CONFIG_DIR, or null for
// the default ~/.claude profile. Never rejects; a failure comes back as
// { status: "error", error }.
function fetchUsage(configDir, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env, cwd = os.homedir(), claude = "claude", platform } = opts;

  return new Promise((resolve) => {
    const childEnv = { ...env };
    if (configDir) childEnv.CLAUDE_CONFIG_DIR = configDir;
    else delete childEnv.CLAUDE_CONFIG_DIR;

    let child;
    try {
      child = spawnClaude(claude, CLAUDE_ARGS, { env: childEnv, cwd, stdio: ["pipe", "pipe", "ignore"], windowsHide: true }, platform);
    } catch (err) {
      resolve({ status: "error", error: err.message });
      return;
    }

    let settled = false;
    let buffered = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ status: "error", error: "timed out" });
      stop(child, platform);
    }, timeoutMs);

    const onLine = (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const response = message && message.type === "control_response" ? message.response : null;
      if (!response || response.request_id !== REQUEST_ID) return;
      finish(
        response.subtype === "success"
          ? parseUsage(response.response)
          : { status: "error", error: String(response.error || "the usage request failed") }
      );
    };

    // Answer as soon as the response line arrives, rather than waiting for the
    // session to wind down.
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        onLine(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
      }
    });
    child.on("error", (err) => {
      finish({ status: "error", error: err.code === "ENOENT" ? "claude was not found" : err.message });
    });
    child.on("close", () => {
      if (buffered) onLine(buffered);
      finish({ status: "error", error: "Claude Code gave no answer" });
    });

    // An early exit closes the pipe under the write; the close handler reports it.
    child.stdin.on("error", () => {});
    child.stdin.end(
      JSON.stringify({ type: "control_request", request_id: REQUEST_ID, request: { subtype: "get_usage", skip_behaviors: true } }) + "\n"
    );
  });
}

// ── Formatting ───────────────────────────────────────────────

// "in 42m", "in 4h 2m", "in 2d 6h", from now until resetsAt (epoch ms).
function formatResetIn(resetsAt, now = Date.now()) {
  if (resetsAt === null || resetsAt === undefined) return "";
  const minutes = Math.ceil((resetsAt - now) / 60000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

module.exports = {
  CLAUDE_ARGS,
  REQUEST_ID,
  toWindow,
  parseUsage,
  quoteWindowsArg,
  fetchUsage,
  formatResetIn,
};
