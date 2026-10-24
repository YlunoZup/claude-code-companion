# claude-multi-account

Multi-account switching and an account-aware statusline for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Switch between Claude accounts with one command, and always see which one you are in.

## Statusline

The statusline appears at the bottom of every Claude Code session and shows which account you are in, next to what the session is doing:

```
 Account 1 (Personal)  Opus 4.1   main  ~/code/claude-multi-account   ctx 74k/200k (37%)
```

| Segment | What it shows |
|---------|---------------|
| **Account** | The active account's name from `config.json`, or the signed-in identity for a profile that has no entry |
| **Model** | The model the session is using |
| **Git** | The current branch; hidden outside a repository and on a detached HEAD |
| **Directory** | The working directory: `~` for home, and only the last two components of anything deeper |
| **Context** | Context window usage: green below 50%, amber below 80%, red from there |

Each segment is white text on its own colour block, so the account is readable at a glance — no need to check config or environment variables. The statusline is a single Node script with no dependencies, so there is nothing else to install.

## Account Picker

Run `ccc` to get the interactive picker:

```
  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
  ┃                                                  ┃
  ┃   ◆  Claude Code                                ┃
  ┃      Account Switcher                            ┃
  ┃                                                  ┃
  ┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
  ┃                                                  ┃
  ┃   [1]  ●  Account 1                             ┃
  ┃            Claude Max 20X                        ┃
  ┃                                                  ┃
  ┃   [2]  ●  Account 2                             ┃
  ┃            Claude Pro                            ┃
  ┃                                                  ┃
  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

  Select account [1/2]:
```

## How It Works

Claude Code uses the `CLAUDE_CONFIG_DIR` environment variable to determine where it reads credentials and config from. This tool manages multiple config directories (one per account) and sets the right env var before launching `claude`.

- **Account 1** uses the default `~/.claude` directory
- **Account 2+** use isolated directories under `~/.claude-profiles/`
- Shared data (projects, todos) is linked so all accounts see the same workspace
- `settings.json` is deliberately **not** shared: each account keeps its own, so each gets its own statusline
- Each account authenticates independently

The launcher is called `ccc`, not `cc`, because `/usr/bin/cc` is the system C compiler on macOS and most Linux distros. Installing a `cc` into a directory early in `PATH` would shadow it and break anything that shells out to the compiler.

### Where credentials live

On **macOS**, Claude Code stores OAuth credentials in the login Keychain rather than on disk, under these service names:

| Profile | Keychain service |
|---------|------------------|
| Default (`~/.claude`, no `CLAUDE_CONFIG_DIR`) | `Claude Code-credentials` |
| Any other profile | `Claude Code-credentials-<sha256(absolute config dir)[0:8]>` |

For example, `sha256("/Users/you/.claude-profiles/account2")[0:8]` is `04f595a6`, giving `Claude Code-credentials-04f595a6`.

The picker detects a logged-in account with `security find-generic-password -s "<service>"` and deliberately **no** `-w` flag. An attribute-only lookup confirms the entry exists without reading the secret, so macOS never shows a Keychain permission prompt and the check costs about 10 ms.

On **Linux and Windows**, and on older Claude Code builds, credentials are still a `.credentials.json` file inside the config directory. The picker checks that path too, so both storage models work.

The account email and plan shown in the picker come from each profile's `.claude.json` under the `oauthAccount` key, which is plain JSON and needs no Keychain access. Note that the default profile's copy lives at `~/.claude.json` in your home directory, while every other profile keeps its own inside the config directory.

## Prerequisites

- [Node.js](https://nodejs.org) (v18+)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and in your PATH
- [git](https://git-scm.com), optionally, for the branch segment

## Install

```bash
git clone https://github.com/YlunoZup/claude-multi-account.git
cd claude-multi-account
```

**macOS / Linux / Git Bash:**
```bash
bash install.sh
```

**Windows (CMD):**
```cmd
install.bat
```

> Under Git Bash, `install.sh` and `ccc` do not work from a home folder whose path contains an apostrophe (`C:\Users\O'Brien`): Git Bash hands such a path to Node without converting it to a Windows path, and Node cannot open it.

The installer will:
1. Create `~/.claude-profiles/` with the picker, statusline, and config files
2. Set up an `account2` directory with symlinks to shared data
3. Configure the statusline in Claude Code's `settings.json`
4. Install the `ccc` launcher to `~/.local/bin/`

### Custom install directory

Pass a directory to install the launcher elsewhere:

```bash
bash install.sh /usr/local/bin
```

## Usage

```bash
# Open the interactive account picker
ccc

# Launch directly with any account by number
ccc 1        # Account 1 (default ~/.claude)
ccc 2        # Account 2
ccc 3        # Account 3 (if configured)

# Add a new account
ccc add              # prompts for a name
ccc add My Work      # creates with name "My Work"

# Pass any Claude Code flags after the account number
ccc 2 --dangerously-skip-permissions
ccc 1 -c    # continue mode
ccc 3 -r "fix the bug in auth.ts"
```

## First-Time Setup for New Accounts

After installing, log in with each additional account:

```bash
ccc 2    # logs into Account 2
ccc 3    # logs into Account 3 (if configured)
```

Claude Code will detect there are no credentials and prompt you to authenticate. Log in with that account. After that, the picker will show the account as configured.

## Configuration

### Account config

Edit `~/.claude-profiles/config.json` to customize account names:

```json
{
  "accounts": {
    "1": { "name": "Account 1 (Personal)", "configDir": null },
    "2": { "name": "Account 2 (Work)", "configDir": "account2" }
  }
}
```

- `name` — Display name shown in the picker and the statusline
- `configDir` — Subdirectory under `~/.claude-profiles/` (`null` = default `~/.claude`)

### Statusline appearance

The segments sit flush against each other, which looks the same in any font. With a [Nerd Font](https://www.nerdfonts.com) or a Powerline-patched font you can have Powerline arrows between them instead: set `SEPARATOR` in `src/statusline.js` to `"\uE0B0"`, and `BRANCH_MARK` to `"\uE0A0 "` for a branch symbol, then re-run the installer.

### Adding more accounts

Use `ccc add` to add a new account in one step:

```bash
ccc add                  # prompts for a name
ccc add Client Project   # creates with name "Client Project"
```

This automatically:
- Finds the next account number
- Creates the profile directory (`~/.claude-profiles/accountN/`)
- Updates `config.json`
- Sets up `settings.json` with the statusline

Then run `ccc N` to log in with the new account. The picker will show it immediately.

`ccc add` is not the only way in: logging into a new slot with `ccc N` works too. `ccc` checks each profile's `settings.json` on every launch and adds the statusline when it is missing, so a profile created that way still gets one. A `statusLine` that runs something else is left alone.

## How the Statusline Works

The statusline is a Node.js script (`statusline.js`) that Claude Code runs as an external command, piping it a JSON description of the session. On each refresh it:

1. **Resolves the account** — reads `CLAUDE_CONFIG_DIR` to tell which profile is active, then looks its name up in `config.json`, falling back to the identity Claude Code recorded for that profile
2. **Reads the session** — the model, working directory and context window usage come straight from the JSON Claude Code pipes in
3. **Asks git for the branch** — `git rev-parse --abbrev-ref HEAD` in the working directory, given one second; set `CCC_GIT_TIMEOUT_MS` if a large repository or a network drive needs longer
4. **Prints one line** of coloured segments

If a segment is missing, run
`CCC_STATUSLINE_DEBUG=1 node ~/.claude-profiles/statusline.js < /dev/null` to see why.

## Shared Data

The installer creates symlinks so all accounts share:

| Item | Purpose |
|------|---------|
| `projects/` | Project-specific settings and memory |
| `todos/` | Todo lists |
| `statsig/`, `.statsig/` | Analytics/feature flags |

**Not shared** (per-account):
- Credentials — each account has its own login (Keychain entry on macOS, `.credentials.json` elsewhere)
- `.claude.json` — per-account identity and state
- `settings.json` — each account has its own settings (needed for individual statusline config)
- `history.jsonl`, `sessions/`, `shell-snapshots/` — per-account session bookkeeping

Because `projects/` is shared, `/resume` in one account lists sessions started under any other account, and the memory directory is common to all of them. `ccc` enforces this on every launch path, so a profile created by logging in for the first time gets the link too. An existing real `projects` directory is never replaced.

## Project Structure

```
claude-multi-account/
├── README.md
├── LICENSE
├── .gitignore
├── install.sh                  # Installer for macOS/Linux/Git Bash
├── install.bat                 # Installer for Windows CMD
├── bin/
│   ├── ccc                     # Bash launcher script
│   └── ccc.bat                 # Windows CMD launcher script
├── src/
│   ├── profiles.cjs            # Shared profile/config logic (also a small CLI)
│   ├── picker.mjs              # Interactive account picker UI
│   └── statusline.js           # Statusline (account, model, branch, directory, context)
├── test/                       # Test suite (node --test, no dependencies)
├── .github/workflows/ci.yml    # Cross-platform CI
└── config.example.json         # Example account configuration
```

## Uninstall

```bash
rm ~/.local/bin/ccc          # or wherever you installed it
rm ~/.local/bin/ccc.bat      # Windows only
rm -rf ~/.claude-profiles    # Removes all profiles and config
```

Remove the statusline by deleting the `statusLine` key from `~/.claude/settings.json`
**before** you delete `~/.claude-profiles`, or Claude Code will keep trying to run a
script that is no longer there.

On macOS, deleting `~/.claude-profiles` does **not** remove the accounts' logins:
those live in the login Keychain. Delete the `Claude Code-credentials-*` entries in
Keychain Access if you want them gone.

## Development

The test suite uses Node's built-in runner and has no dependencies:

```bash
npm test          # or: node --test
```

It runs the real `install.sh`, `bin/ccc`, `install.bat` and `bin/ccc.bat` against a
throwaway `HOME` with a stub `claude` on `PATH` that records `CLAUDE_CONFIG_DIR` and
its arguments instead of launching anything. **No test touches the macOS Keychain, a
real Claude account, or your actual `~/.claude`** — a profile with no credentials is
exactly the state every test starts from.

The Windows CMD suite (`test/windows.test.mjs`) skips on other platforms.

[CI](.github/workflows/ci.yml) runs on Ubuntu, macOS and Windows against Node 18, 22
and 24, plus a `shellcheck` and line-ending gate and a Git Bash installer job. Note
that a GitHub Windows runner is an administrator with UAC disabled, so a green
Windows job does not prove the tool degrades gracefully for a standard user with
Developer Mode off.

If you change anything the shell or batch scripts rely on, put the logic in
`src/profiles.cjs` rather than a `node -e` snippet. Paths and names reach it as
argv entries or environment values, so a home directory containing a space or a
quote cannot change what runs — and the logic stays testable.

## License

MIT
