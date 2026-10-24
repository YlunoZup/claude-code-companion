# claude-multi-account

Multi-account switching and an account-aware statusline for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Switch between Claude accounts with one command, see which Claude account each one is signed into, and how much of its 5-hour and weekly limits is left — live. With a ChatGPT plan, the GPT models run in Claude Code too, picked in `/model` like any other.

## Statusline

The statusline appears at the bottom of every Claude Code session and shows which account you are in, what the session is doing, and how much of the account's limits is left:

```
 Account 1 (Personal)  Opus 4.1   main  ~/code/claude-multi-account   ctx 74k/200k (37%)  5h 77% left · week 40% left
```

| Segment | What it shows |
|---------|---------------|
| **Account** | The active account's name from `config.json`, or the signed-in identity for a profile that has no entry |
| **Model** | The model the session is using |
| **Git** | The current branch; hidden outside a repository and on a detached HEAD |
| **Directory** | The working directory: `~` for home, and only the last two components of anything deeper |
| **Context** | Context window usage: green below 50%, amber below 80%, red from there |
| **Limits** | How much of the account's 5-hour and weekly limits is left — the figures the picker shows, which Claude Code passes in. Under a fifth left, it also says when that window resets. Absent for an API key, and until the session's first response. On a [GPT model](#gpt-models) it says `Using ChatGPT plan` instead |

Each segment is white text on its own colour block, so the account is readable at a glance — no need to check config or environment variables. The statusline is a single Node script with no dependencies, so there is nothing else to install.

## Account Picker

Run `ccc` to get the interactive picker. Every account shows who it is signed in as, its plan, and how much of its 5-hour and weekly limits is left right now:

```

  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
  ┃                                                          ┃
  ┃   ◆  Claude Code                                         ┃
  ┃      Account Switcher                                    ┃
  ┃                                                          ┃
  ┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
  ┃                                                          ┃
  ┃   [1]  ●  Personal                                       ┃
  ┃         me@example.com  ·  Claude Pro                    ┃
  ┃         5h    █████░░░░░  45% left · resets in 3h 48m    ┃
  ┃         week  █████████░  86% left · resets in 4d 22h    ┃
  ┃                                                          ┃
  ┃   [2]  ●  Work                                           ┃
  ┃         work@example.com  ·  Claude Max 20x              ┃
  ┃         5h    ██████████ 100% left                       ┃
  ┃         week  ░░░░░░░░░░   0% left · resets in 2d 21h    ┃
  ┃                                                          ┃
  ┃   [3]  ●  Client  same login as [1]                      ┃
  ┃         me@example.com  ·  Claude Pro                    ┃
  ┃         5h    █████░░░░░  45% left · resets in 3h 48m    ┃
  ┃         week  █████████░  86% left · resets in 4d 22h    ┃
  ┃                                                          ┃
  ┃   [4]  ○  Spare                                          ┃
  ┃         not logged in  ·  ccc login 4                    ┃
  ┃                                                          ┃
  ┃   [5]  ●  ChatGPT                                        ┃
  ┃         me@example.com  ·  ChatGPT                       ┃
  ┃         GPT models in Claude Code, on your ChatGPT plan  ┃
  ┃         usage: chatgpt.com/settings/usage                ┃
  ┃                                                          ┃
  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

  Select account [1/2/3/4/5, r to refresh, q to quit]:
```

- **Usage** is the share of each limit still *left*: green at half or more, amber under half, red under a fifth. The 5-hour window has no reset time until something starts it.
- **same login as [n]** means two slots are signed into one Claude account, so they share its limits. `ccc login <slot>` puts a different Claude account in the slot.
- **ChatGPT** is the account `ccc gpt login` adds: Claude Code on the [GPT models](#gpt-models). A Claude account set to always offer them as well is marked **+ GPT models**.
- Press a number to launch that account, **r** to fetch the usage again, **q** to quit. `ccc list` prints the same overview without the prompt.

## GPT Models

With a ChatGPT plan, Claude Code can run on the GPT models too. It is still all Claude Code — its screen, tools, slash commands, `CLAUDE.md`, MCP servers and hooks — with a GPT model answering instead of Claude, on your ChatGPT plan's usage. The Codex app and CLI are not involved.

```bash
ccc gpt login     # sign in with ChatGPT, once; adds an account for the GPT models
ccc 6             # that account: Claude Code on GPT only (its number is printed at sign-in)
ccc 2 --gpt       # any Claude account, with the GPT models added to /model
ccc gpt on 2      # ...on every launch of account 2 (ccc gpt off 2 stops)
ccc gpt status    # who is signed in, and which models the plan gives
ccc gpt models    # the models, refreshed from OpenAI
ccc gpt logout    # sign ChatGPT out and revoke ccc's access
```

In `/model` the GPT models appear as rows marked **ChatGPT plan**. On a Claude account they come after the Claude models, and switching back and forth works within one conversation — switch between turns, not while a tool call is running. The effort control works on them too: Claude Code's effort becomes the GPT model's reasoning effort. Claude Code's default is High, while OpenAI's own defaults for these models are lower, so Medium or Low saves plan usage.

On the ChatGPT account, Claude Code's own background requests (session titles and the like) go to the plan's smallest model, and the header reads `API Usage Billing` — Claude Code's name for any login that is not a Claude one; nothing is billed to an API.

### How it works

`ccc gpt login` is OpenAI's [Sign in with ChatGPT plan usage](https://developers.openai.com/siwc/token-sharing-open-source), which OpenAI opened to open-source tools and personal projects that run locally. You approve `claude-multi-account` once in the browser; its requests then count against your ChatGPT plan, and you can cap or cut off its share at [chatgpt.com/settings/usage](https://chatgpt.com/settings/usage). The sign-in is ccc's own, kept in `~/.claude-profiles/chatgpt/auth.json` (readable by you alone). It never touches the Codex app's `~/.codex/auth.json`: OpenAI replaces the refresh token on every use, so two programs sharing one login would sign each other out.

A launch with the GPT models starts `router.cjs`, which listens on `127.0.0.1` for as long as that Claude Code runs and is the address Claude Code sends its requests to (`ANTHROPIC_BASE_URL`). By the model each request names:

- **a Claude model** goes on to `api.anthropic.com` byte for byte, with the account's own login — Claude Code's header, which the router passes on and never stores. The rate-limit headers come back the same way, so the picker's and the statusline's figures still work.
- **a GPT model** is translated to OpenAI's Responses API and back. A GPT model's reasoning rides along in the conversation, so it keeps its train of thought from one turn to the next. Tools Claude Code loads on demand (ToolSearch) become callable as they load, as Anthropic's servers would make them, and a web search runs on OpenAI's.

The GPT rows reach `/model` through a `modelPicker` setting passed with `--settings`. Each "behaves as" `claude-sonnet-5`, a model Claude Code knows, which gives it the effort control. A per-model auto-compact window then gives each GPT model its own context window — the one OpenAI states and Codex uses: 500K for GPT-6.1-Sol, 272K for the others — so Claude Code compacts the conversation before the model would run out of room, and the statusline measures against that window. A per-session key keeps any other program on the machine from spending your plan through the router. `~/.claude-profiles/chatgpt/router.log` records each GPT request's model, status and token counts, and never a prompt or a token.

### Limits

- **Usage figures.** OpenAI does not report how much of the plan is left on this route, so the picker and statusline cannot show it; [chatgpt.com/settings/usage](https://chatgpt.com/settings/usage) does. When the plan or ccc's share runs out, Claude Code says so with that link.
- **Web search** runs on OpenAI's search when a GPT model asks Claude Code's WebSearch tool, so it counts against your ChatGPT plan too. Anthropic's other server-side tools, such as code execution, run on Anthropic's servers, so a GPT model goes without them.
- **A GPT model saved as the default.** `/model` can save a GPT model as an account's default. `ccc` then adds the GPT models whenever it starts that account, but a plain `claude` cannot run it — which matters only for the default profile, the one `claude` itself opens. `ccc repair` points it out.
- **Not an Anthropic feature.** Claude Code supports other endpoints through `ANTHROPIC_BASE_URL`, but Anthropic does not support running it on non-Claude models. The GPT models were trained on Codex's tools rather than Claude Code's, so expect the odd rough edge.

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

`ccc` detects a logged-in account with `security find-generic-password -s "<service>"` and deliberately **no** `-w` flag. An attribute-only lookup confirms the entry exists without reading the secret, so macOS never shows a Keychain permission prompt and the check costs about 10 ms.

On **Linux and Windows**, and on older Claude Code builds, credentials are still a `.credentials.json` file inside the config directory. The picker checks that path too, so both storage models work.

The account email and plan shown in the picker come from each profile's `.claude.json` under the `oauthAccount` key, which is plain JSON and needs no Keychain access. Note that the default profile's copy lives at `~/.claude.json` in your home directory, while every other profile keeps its own inside the config directory.

### Live usage

The usage figures come from Claude Code itself — the numbers its `/usage` screen shows. For each signed-in account, `ccc` starts `claude -p` in that account's profile and sends it a single `get_usage` control request: no prompt, so no model call and no usage of its own; hooks off, no MCP servers, nothing saved. Every account is asked at once, which takes a second or two.

`ccc` never reads your login token. Claude Code reads the credentials and, when the token has expired, refreshes it under its own locks. A refresh from outside could race a Claude Code session running on the same account and sign it out. It is also why an account you have not used for a day still shows live numbers.

Set `CCC_NO_USAGE=1` to leave usage out and open the picker instantly.

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

# Pass any Claude Code flags after the account number
ccc 2 --dangerously-skip-permissions
ccc 1 -c    # continue mode
ccc 3 -r "fix the bug in auth.ts"

# Every account, who it is signed in as, and its live usage
ccc list

# GPT models on your ChatGPT plan (see "GPT Models" above)
ccc gpt login              # sign in with ChatGPT; adds an account for them
ccc 2 --gpt                # account 2 with the GPT models added to /model

# Manage accounts
ccc add My Work            # add an account (prompts for a name if you leave it out)
ccc login 3                # sign slot 3 in again, or into a different Claude account
ccc logout 3               # sign slot 3 out
ccc rename 3 Client Work    # rename slot 3
ccc remove 3               # take slot 3 off the list (its folder is kept)
ccc repair                 # check every account and fix what can be fixed
ccc help                   # all of the above
```

`ccc login` and `ccc logout` run Claude Code's own `claude auth login` and `claude auth logout` in that account's profile; anything after the number goes along, so `ccc login 3 --email you@example.com` pre-fills the sign-in page. `relogin` is another name for `login`.

`ccc repair`, or `ccc repair 3` for one account, recreates a missing profile folder, relinks the shared session history and puts back a missing statusline. What only you can do — signing an account in, or giving a slot that duplicates another its own Claude account — it lists with the command that does it, and it exits non-zero while anything is left. It never rewrites a `settings.json` it cannot parse, or replaces a real `projects` folder.

## First-Time Setup for New Accounts

After installing, sign each additional account in:

```bash
ccc login 2    # signs Account 2 in
ccc login 3    # signs Account 3 in (if configured)
```

This runs Claude Code's own sign-in in that account's profile, which opens the browser. `ccc 2` works too: Claude Code asks you to sign in the first time it starts there. After that, the picker shows who the account is signed in as, and its usage.

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

Then run `ccc login N` to sign the new account in. The picker will show it immediately.

`ccc add` is not the only way in: logging into a new slot with `ccc N` works too. `ccc` checks each profile's `settings.json` on every launch and adds the statusline when it is missing, so a profile created that way still gets one. A `statusLine` that runs something else is left alone.

## How the Statusline Works

The statusline is a Node.js script (`statusline.js`) that Claude Code runs as an external command, piping it a JSON description of the session. On each refresh it:

1. **Resolves the account** — reads `CLAUDE_CONFIG_DIR` to tell which profile is active, then looks its name up in `config.json`, falling back to the identity Claude Code recorded for that profile
2. **Reads the session** — the model, working directory, context window usage and plan limits come straight from the JSON Claude Code pipes in, so showing the limits costs no extra request
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
│   ├── usage.cjs               # Live usage, asked of Claude Code
│   ├── chatgpt.cjs             # Sign in with ChatGPT, and the GPT model list
│   ├── router.cjs              # Local router: Claude requests to Anthropic, GPT ones to OpenAI
│   ├── translate.cjs           # Anthropic Messages API <-> OpenAI Responses API
│   └── statusline.js           # Statusline (account, model, branch, directory, context)
├── test/                       # Test suite (node --test, no dependencies)
├── .github/workflows/ci.yml    # Cross-platform CI
└── config.example.json         # Example account configuration
```

## Uninstall

```bash
ccc gpt logout               # if you signed in with ChatGPT: revokes ccc's access
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
exactly the state every test starts from. The stub `claude` answers usage requests with canned figures too, so no test ever starts the real Claude Code. The GPT tests play OpenAI with stand-ins on `127.0.0.1` — the sign-in, signed ID tokens, rotating refresh tokens, the Responses stream — so none of them reaches OpenAI either.

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
