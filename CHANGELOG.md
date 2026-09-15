# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

### Fixed

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
- The statusline passes its config path to `claude-powerline` as an argument rather
  than through a shell string, so a `$` or a backtick in the home directory can no
  longer change what runs.
- The installer resolves and checks the install destination before it changes
  anything, so a bad argument no longer aborts halfway through.
- Documentation: the Keychain service example hash was wrong; "How It Works" claimed
  `settings.json` is shared when it deliberately is not; the uninstall steps did not
  mention that macOS Keychain entries survive `rm -rf ~/.claude-profiles`.

### Changed

- `ccc` now requires `node` on `PATH` for every operation, with a clear message when
  it is missing. Claude Code is itself a Node CLI, so a `ccc` that "worked" without
  node only ever exec'd a `claude` that immediately failed.
- Shared-data links are created by Node rather than `ln -s` / `mklink`. On Windows
  this means a junction, which needs no administrator rights and — unlike Git Bash's
  `ln -s` — does not silently deep-copy the tree.
