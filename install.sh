#!/bin/bash
# claude-multi-account installer
# Works on macOS, Linux, and Windows (Git Bash / MSYS2)

set -e

# ── Colors ────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

# printf '%s', not echo -e, so a path containing a backslash is reported as it
# is rather than being read as an escape sequence.
info() { printf '  %b%bINFO%b  %s\n' "$CYAN" "$BOLD" "$RESET" "$1"; }
ok()   { printf '  %b%b  OK%b  %s\n' "$GREEN" "$BOLD" "$RESET" "$1"; }
warn() { printf '  %b%bWARN%b  %s\n' "$YELLOW" "$BOLD" "$RESET" "$1"; }
err()  { printf '  %b%b ERR%b  %s\n' "$RED" "$BOLD" "$RESET" "$1"; }

# ── Detect environment ───────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILES_DIR="$HOME/.claude-profiles"
ACCOUNT2_DIR="$PROFILES_DIR/account2"
CLAUDE_DIR="$HOME/.claude"
PROFILES_LIB="$PROFILES_DIR/profiles.cjs"
IS_WINDOWS=false

if [[ "${OSTYPE-}" == "msys" || "${OSTYPE-}" == "cygwin" || "${OSTYPE-}" == "win32" ]]; then
    IS_WINDOWS=true
fi

echo ""
printf '  %b%bclaude-multi-account installer%b\n' "$CYAN" "$BOLD" "$RESET"
printf '  %b────────────────────────────────%b\n' "$DIM" "$RESET"
echo ""

# ── Check prerequisites ──────────────────────────────────────
if ! command -v node &>/dev/null; then
    err "Node.js is required but not found. Install it from https://nodejs.org"
    exit 1
fi
ok "Node.js found: $(node --version)"

if ! command -v claude &>/dev/null; then
    warn "Claude Code CLI not found in PATH. Make sure it's installed."
else
    ok "Claude Code CLI found"
fi

# ── Resolve the install destination before touching anything ──
# Doing this first means an unwritable or bogus destination stops the run
# before settings.json has been rewritten and links have been created.
BIN_DIR="$HOME/.local/bin"
if [[ -n "${1-}" ]]; then
    BIN_DIR="$1"
fi

if ! mkdir -p "$BIN_DIR" 2>/dev/null; then
    err "Cannot create the install directory: $BIN_DIR"
    exit 1
fi
# Normalise, so the PATH check below compares like with like and a relative
# argument is not re-resolved against whatever directory the user runs ccc from.
BIN_DIR="$(cd "$BIN_DIR" && pwd)"
if [[ ! -w "$BIN_DIR" ]]; then
    err "The install directory is not writable: $BIN_DIR"
    exit 1
fi

# ── Create directories ───────────────────────────────────────
info "Creating profile directories..."

mkdir -p "$PROFILES_DIR"
mkdir -p "$ACCOUNT2_DIR"
ok "Created $PROFILES_DIR"
ok "Created $ACCOUNT2_DIR"

# ── Install the shared profile library ───────────────────────
# Every launcher and installer routes its config.json and settings.json work
# through this file, so it has to land before anything calls into it.
info "Installing profile library..."
cp "$SCRIPT_DIR/src/profiles.cjs" "$PROFILES_LIB"
ok "Installed profiles.cjs -> $PROFILES_LIB"

# statusline.js is CommonJS with a .js extension. Without this marker an
# unrelated ~/package.json declaring {"type": "module"} would make Node parse it
# as ESM and the statusline would die on every refresh.
printf '{\n  "type": "commonjs"\n}\n' > "$PROFILES_DIR/package.json"

# ── Copy picker.mjs ──────────────────────────────────────────
info "Installing picker..."
cp "$SCRIPT_DIR/src/picker.mjs" "$PROFILES_DIR/picker.mjs"
ok "Installed picker.mjs -> $PROFILES_DIR/picker.mjs"

# ── Copy config (if not exists) ──────────────────────────────
if [[ ! -f "$PROFILES_DIR/config.json" ]]; then
    cp "$SCRIPT_DIR/config.example.json" "$PROFILES_DIR/config.json"
    ok "Created config.json from template"
else
    ok "config.json already exists, skipping"
fi

# ── Install statusline ──────────────────────────────────────
info "Installing statusline..."
cp "$SCRIPT_DIR/src/statusline.js" "$PROFILES_DIR/statusline.js"
ok "Installed statusline.js -> $PROFILES_DIR/statusline.js"

if [[ ! -f "$PROFILES_DIR/claude-powerline.json" ]]; then
    cp "$SCRIPT_DIR/config/claude-powerline.json" "$PROFILES_DIR/claude-powerline.json"
    ok "Installed claude-powerline.json"
else
    ok "claude-powerline.json already exists, skipping"
fi

# Check for claude-powerline
if ! command -v claude-powerline &>/dev/null; then
    warn "claude-powerline not found. Install it for statusline segments:"
    printf '    %bnpm install -g claude-powerline%b\n\n' "$BOLD" "$RESET"
else
    ok "claude-powerline found"
fi

# ── Configure statusline in settings.json ────────────────────
# profiles.cjs merges the statusLine key and leaves every other key alone. It
# refuses outright if the file exists but cannot be parsed, rather than
# replacing a user's theme, permissions and hooks with a one-key object.
info "Configuring statusline in Claude Code settings..."

configure_statusline() {
    local settings_file="$1"
    local label="$2"
    mkdir -p "$(dirname "$settings_file")"
    if node "$PROFILES_LIB" apply-statusline "$settings_file"; then
        ok "Configured statusline in $label"
    else
        warn "Left $label alone — it exists but could not be parsed as JSON"
    fi
}

configure_statusline "$CLAUDE_DIR/settings.json" "settings.json"
configure_statusline "$ACCOUNT2_DIR/settings.json" "account2/settings.json"

# ── Set up shared data (account2 -> ~/.claude) ───────────────
info "Setting up shared data for Account 2..."

# Files/dirs to share between accounts
SHARE_ITEMS=("projects" "todos" "statsig" ".statsig")

for item in "${SHARE_ITEMS[@]}"; do
    src="$CLAUDE_DIR/$item"
    dest="$ACCOUNT2_DIR/$item"

    # Skip if source doesn't exist
    if [[ ! -e "$src" ]]; then
        continue
    fi

    # profiles.cjs picks the right primitive per platform — a junction on
    # Windows (no administrator rights needed, and no silent deep copy from Git
    # Bash's `ln -s`), a symlink everywhere else — and never replaces whatever
    # is already at the destination.
    result="$(node "$PROFILES_LIB" ensure-link "$dest" "$src")"
    case "$result" in
        linked)
            ok "Shared: $item"
            ;;
        already-linked)
            ok "Shared: $item (already linked)"
            ;;
        exists)
            # A real directory here holds that account's session transcripts.
            # Deleting it to make room for a link would destroy them.
            warn "$item already exists in account2 — leaving it as it is"
            ;;
        *)
            warn "Could not share $item"
            ;;
    esac
done

# ── Install launcher script ──────────────────────────────────
info "Installing launcher script..."

# The launcher is called "ccc", not "cc": on macOS and most Linux distros
# /usr/bin/cc is the system C compiler, and BIN_DIR is meant to sit early in
# PATH, so installing a "cc" here would shadow the compiler and break builds
# that shell out to it (make, node-gyp, and so on).
cp "$SCRIPT_DIR/bin/ccc" "$BIN_DIR/ccc"
chmod +x "$BIN_DIR/ccc"
ok "Installed ccc -> $BIN_DIR/ccc"

# On Windows (Git Bash), also install the .bat launcher so the same install
# works from a CMD prompt.
if $IS_WINDOWS; then
    cp "$SCRIPT_DIR/bin/ccc.bat" "$BIN_DIR/ccc.bat"
    ok "Installed ccc.bat -> $BIN_DIR/ccc.bat"
fi

# Clean up the shadowing launcher left by earlier versions of this installer.
if [[ -f "$BIN_DIR/cc" ]] && grep -q "Claude Code Account Switcher" "$BIN_DIR/cc" 2>/dev/null; then
    rm -f "$BIN_DIR/cc" "$BIN_DIR/cc.bat"
    ok "Removed the old 'cc' launcher (it shadowed the system C compiler)"
fi

# ── Check if BIN_DIR is in PATH ──────────────────────────────
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
    echo ""
    warn "$BIN_DIR is not in your PATH."
    echo ""
    echo "  Add it to your shell profile:"
    echo ""
    # shellcheck disable=SC2016  # $PATH stays literal: this is a line to paste
    printf '    %bexport PATH="%s:$PATH"%b\n' "$BOLD" "$BIN_DIR" "$RESET"
    echo ""
    printf '  Add this line to your %b~/.bashrc%b, %b~/.zshrc%b, or %b~/.profile%b\n' \
        "$DIM" "$RESET" "$DIM" "$RESET" "$DIM" "$RESET"
fi

# ── Done ──────────────────────────────────────────────────────
echo ""
printf '  %b%bInstallation complete!%b\n\n' "$GREEN" "$BOLD" "$RESET"
printf '  %bUsage:%b\n' "$BOLD" "$RESET"
printf '    %bccc%b          Open account picker\n' "$CYAN" "$RESET"
printf '    %bccc 1%b        Launch with Account 1 (default)\n' "$CYAN" "$RESET"
printf '    %bccc 2%b        Launch with Account 2\n' "$CYAN" "$RESET"
printf '    %bccc 2 -c%b     Launch Account 2 in continue mode\n' "$CYAN" "$RESET"
echo ""
printf '  %bStatusline:%b\n' "$BOLD" "$RESET"
echo "    Configured automatically. Your Claude Code sessions"
echo "    will show the account badge and powerline segments."
echo ""
printf '  %bFirst-time setup for Account 2:%b\n' "$BOLD" "$RESET"
printf '    Run %bccc 2%b and log in when prompted.\n' "$CYAN" "$RESET"
echo ""
