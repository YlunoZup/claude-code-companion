# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Renamed the project to **Claude Code Companion** across the picker, help,
  installers, package metadata and new ChatGPT registrations. `ccc`, existing
  profile paths, sign-ins and shared history are unchanged.

### Added

- **GPT models in Claude Code, on a ChatGPT plan.** `ccc gpt login` signs in
  with OpenAI's Sign in with ChatGPT plan usage — the route OpenAI opened to
  open-source tools and personal projects that run locally — and adds an account
  that runs Claude Code on the GPT models. `ccc <n> --gpt` adds them to any
  Claude account's `/model` for one launch, `ccc gpt on|off <n>` for every
  launch. `ccc gpt status`, `models` and `logout` round it off, and
  `ccc login|logout <n>` on the ChatGPT account go to ChatGPT.
  - A launch with the GPT models runs a router on `127.0.0.1` for as long as
    Claude Code runs. A Claude request goes on to Anthropic byte for byte with
    the account's own login; a GPT request is translated to OpenAI's Responses
    API and back, streaming, with tool calls, images, structured output and the
    model's reasoning carried from turn to turn. A per-session key keeps other
    programs on the machine from spending the plan through it.
  - The sign-in is ccc's own, in `~/.claude-profiles/chatgpt/auth.json`, never
    the Codex app's: OpenAI rotates refresh tokens, so sharing one would sign
    the app out. Refreshes are serialised across sessions; tokens are never
    printed or logged.
  - The GPT models reach `/model` as rows that behave as `claude-sonnet-5`,
    for the effort control, each with its own context window: the one OpenAI
    states and Codex uses — 500K for GPT-6.1-Sol, 272K for the others — set as
    a per-model auto-compact window. The statusline measures a GPT model's
    context against that window.
  - Tools Claude Code loads on demand through ToolSearch — WebFetch, WebSearch,
    MCP tools — become callable on a GPT model once loaded, as Anthropic's
    servers would make them, and Claude Code's WebSearch runs on OpenAI's own
    web search.
  - The picker shows the ChatGPT account. GPT sessions show Codex-reported
    limits when available, otherwise `Using ChatGPT plan`, never the Claude
    account's leftover limits. Only reported windows appear.
  - Usage lookup verifies Codex's ChatGPT email against ccc's sign-in before
    reading limits. Snapshots are bound to that login, refreshed after answers
    at most every two minutes, and labeled cached on failure or when older.
    Mismatches and signed-out Codex hide the figures. The display explicitly
    distinguishes Codex allowance from ccc's connected-app cap.
  - `ccc gpt sync <n>` merges locally installed plugins, public MCP setup and
    local customizations from Claude account n into the ChatGPT profile. It
    preserves target choices, credentials, permissions and user hooks; skips
    inline secrets and Claude-account-synced skills; and lists what still
    needs manual setup. Remote MCP sign-ins remain separate.
  - Auto mode works on GPT models: the router turns down Anthropic's
    server-side safety field as an unsupported beta, so Claude Code vets tool
    calls with its own classifier requests, which GPT answers. Requests that
    leave out `stream` get JSON, as from Anthropic, and stop sequences are
    honoured. A context overflow reported inside OpenAI's stream comes back
    as HTTP 400 "prompt is too long", so Claude Code compacts and retries.
  - An account whose saved default model is a GPT model starts with the GPT
    models by itself, and `ccc repair` flags one on the default profile, which
    plain `claude` cannot run.
- **Live usage in the picker.** Every signed-in account shows how much of its
  5-hour and weekly limits is left, and when each resets. The figures come from
  Claude Code itself: `ccc` starts `claude -p` in each profile with a single
  `get_usage` control request — no prompt, so no model call; hooks off; nothing
  saved — and asks every account at once. `ccc` never reads a token: Claude Code
  refreshes an expired one under its own locks, so even an account unused for a
  day shows live numbers. `r` in the picker asks again; `CCC_NO_USAGE=1` leaves
  usage out.
- The statusline shows how much of the account's 5-hour and weekly limits is
  left, from the rate limits Claude Code passes it, so at no extra request. A
  window with under a fifth left also says when it resets.
- The picker shows which Claude account each slot is signed into, and flags a
  slot signed into the same account as an earlier one (`same login as [n]`),
  since the two share its limits.
- New commands, in both launchers: `ccc help`, `ccc list` (the picker's overview,
  printed), `ccc login <n>` and `ccc logout <n>` (Claude Code's own
  `claude auth login` / `logout` in that profile; `relogin` is an alias),
  `ccc rename <n> <name>`, `ccc remove <n>` (off the list; the folder is kept),
  and `ccc repair [n]`, which fixes a missing folder, history link or statusline
  and lists, with the command to run, what only the user can do.
- Automated cross-platform validation. `npm test` runs a dependency-free suite on
  Node's built-in test runner that executes the real `install.sh`, `bin/ccc`,
  `install.bat` and `bin/ccc.bat` against a throwaway `HOME` with a stub `claude`
  on `PATH`. No test touches the macOS Keychain or a real Claude account.
- GitHub Actions CI across Ubuntu, macOS and Windows on Node 18, 22 and 24, plus a
  pinned `shellcheck` gate, a line-ending gate, and a Git Bash installer job that
  exercises `install.sh`'s Windows branch.
- `src/profiles.cjs`, the single place profile layout, `config.json` and
  `settings.json` rules live. The shell and batch scripts call it as a small CLI
  instead of embedding `node -e` snippets.
- `.gitattributes`, so a Git for Windows clone no longer produces a CRLF
  `install.sh` that dies on its first line.
- A `{"type": "commonjs"}` marker in `~/.claude-profiles/`, so an unrelated
  `~/package.json` declaring `{"type": "module"}` can no longer stop the statusline
  from loading.
- Both launchers wire the statusline on every launch. A profile created by logging
  in for the first time, rather than with `ccc add`, used to get no statusline at
  all, and one whose `statusLine` still pointed at a `.claude-profiles` script that
  no longer exists showed nothing. A `statusLine` that runs anything else is left
  alone, and so is a `settings.json` that does not parse.

### Fixed

- The ChatGPT picker and status identify Pro 100, Pro 200 and Pro 500 from
  OpenAI's `prolite`, `pro` and `promax` plan types, rather than a generic Pro
  label; Plus and Go keep their distinct names.
- GPT launch settings preserve per-model effort preferences, deduplicate picker
  rows, and cap context windows. Invalid `--settings` now fails closed instead
  of silently dropping the user's permission configuration.
- A client disconnect during ChatGPT token refresh no longer starts a model
  request after the client has left. Interrupted Claude upstream streams are
  handled without an unhandled response error. Local stop-sequence cancellation
  marks token totals incomplete in the router log.
- Codex usage queries are serialized across ccc processes, support Windows npm
  shims, and cannot restore an old snapshot after a new ChatGPT login.
- ChatGPT login/logout persistence shares the refresh lock, preventing a pending
  refresh from restoring a signed-out session or overwriting a newer login.
  A delayed logout preserves a newer saved sign-in.
- Workflow sync detects changed target files before writing rather than knowingly
  overwriting another session's settings.
- Test sandboxes strip inherited provider credentials and router environment
  variables, and default OpenAI endpoints to localhost stand-ins.

- **`install.sh` no longer deletes an existing profile directory.** Re-running the
  installer used to `rm -rf` a real `~/.claude-profiles/account2/projects` and
  replace it with a symlink, destroying that account's session transcripts. It now
  leaves anything already there alone and says so.
- **Generated statusline commands are quoted.** A home directory containing a space
  (`C:\Users\John Smith`) produced a `statusLine.command` that no shell could run.
- **`ccc add` and `ccc <n>` survive quotes in paths.** Paths were interpolated into
  JavaScript source inside `node -e`, so a home directory containing an apostrophe
  broke `ccc add` outright.
- **`ccc add` merges `settings.json` instead of replacing it.** It used to overwrite
  the file wholesale, discarding `theme`, `permissions` and `hooks`.
- **A malformed `config.json` is refused, not silently rewritten.** One syntax error
  used to reset the file to a single account and re-point slot 1 at a new profile.
  `config.json` is also now written atomically.
- **Windows: `ccc add` works at all.** `!isNaN(n)` inside a `node -e` snippet was
  consumed by `setlocal enabledelayedexpansion`, so the next-account probe returned
  nothing, fell back to slot 1, and overwrote the first account.
- **Windows: `CLAUDE_CONFIG_DIR` no longer leaks into the calling session.**
  `ccc.bat` ran `endlocal` before setting it, which both truncated the path on the
  fallback branch and left the variable set in the user's CMD window afterwards.
- **Windows: account 2 gets a statusline on first install.** `install.bat` checked
  for `account2\settings.json` twenty lines before creating it, so the configure step
  was always skipped on a fresh install while still printing `[ OK]`.
- **Windows: all arguments reach `claude`.** The quick-switch path forwarded only
  `%1`..`%9`.
- **Windows: `ccc add` with no name prompts for one.** The name was built from
  `%~2 %~3 %~4 %~5`, which with no arguments is three spaces — never empty, so the
  prompt never fired and the account was named `"   "`.
- **Windows: `ccc 1` honours `config.json`.** Slot 1 was hardcoded to the default
  profile before `config.json` was read, so the same config launched different
  accounts on different platforms.
- `install.bat` checks every `copy` and `mkdir`, rather than printing
  `Installation complete!` after a failed install.
- `install.bat` no longer suggests `setx PATH`, which collapses the machine and user
  `PATH` into one user variable and truncates it at 1024 characters.
- Missing dependencies fail loudly. A missing `node`, `picker.mjs` or `claude` used
  to leak a raw stack trace from `ccc` and still exit 0, so the caller saw success
  while nothing had launched.
- The installer resolves and checks the install destination before it changes
  anything, so a bad argument no longer aborts halfway through.
- Documentation: the Keychain service example hash was wrong; "How It Works" claimed
  `settings.json` is shared when it deliberately is not; the uninstall steps did not
  mention that macOS Keychain entries survive `rm -rf ~/.claude-profiles`.

### Changed

- The picker prints the chosen account's number, not its profile path, and the
  launchers resolve it themselves, so the ChatGPT account and a Claude account
  start the same way.
- `ccc add` now ends by pointing at `ccc login <n>` to sign the account in.
- Sign-in detection moved from `picker.mjs` into `profiles.cjs`, which the picker
  and `ccc repair` share. `CCC_NO_KEYCHAIN=1` skips the Keychain lookup; the test
  sandbox sets it, so no test can find a developer's real login.
- **The statusline is self-contained.** `statusline.js` renders the account, model,
  git branch, working directory and context window usage itself, with nothing
  beyond Node, instead of running `claude-powerline` on every refresh. Every
  account's segment is now the same purple; the name, not the colour, says which
  account is active. The directory is shortened to `~` and its last two
  components, and a path outside home is never shown under `~`. git is given one
  second to name the branch; `CCC_GIT_TIMEOUT_MS` changes that.
- `ccc` now requires `node` on `PATH` for every operation, with a clear message when
  it is missing. Claude Code is itself a Node CLI, so a `ccc` that "worked" without
  node only ever exec'd a `claude` that immediately failed.
- Shared-data links are created by Node rather than `ln -s` / `mklink`. On Windows
  this means a junction, which needs no administrator rights and — unlike Git Bash's
  `ln -s` — does not silently deep-copy the tree.

### Removed

- The claude-powerline integration, and with it `config/claude-powerline.json`, the
  shared `today.json` cache invalidation, and `CCC_POWERLINE_TIMEOUT_MS`. Neither
  installer copies that file or looks for `claude-powerline` any more. An existing
  `~/.claude-profiles/claude-powerline.json` is left where it is, unused.
