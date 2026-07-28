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

info()  { echo -e "  ${CYAN}${BOLD}INFO${RESET}  $1"; }
ok()    { echo -e "  ${GREEN}${BOLD}  OK${RESET}  $1"; }
warn()  { echo -e "  ${YELLOW}${BOLD}WARN${RESET}  $1"; }
err()   { echo -e "  ${RED}${BOLD} ERR${RESET}  $1"; }

# ── Detect environment ───────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILES_DIR="$HOME/.claude-profiles"
ACCOUNT2_DIR="$PROFILES_DIR/account2"
CLAUDE_DIR="$HOME/.claude"
IS_WINDOWS=false

if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" ]]; then
    IS_WINDOWS=true
fi

echo ""
echo -e "  ${CYAN}${BOLD}claude-multi-account installer${RESET}"
echo -e "  ${DIM}────────────────────────────────${RESET}"
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

# ── Create directories ───────────────────────────────────────
info "Creating profile directories..."

mkdir -p "$PROFILES_DIR"
mkdir -p "$ACCOUNT2_DIR"
ok "Created $PROFILES_DIR"
ok "Created $ACCOUNT2_DIR"

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
    echo -e "    ${BOLD}npm install -g claude-powerline${RESET}"
    echo ""
else
    ok "claude-powerline found"
fi

# ── Configure statusline in settings.json ────────────────────
info "Configuring statusline in Claude Code settings..."

configure_statusline() {
    local settings_file="$1"
    node -e 'const fs = require("fs");
const p = process.argv[1];
let s = {};
try { s = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
const h = require("os").homedir().replace(/\\/g, "/");
s.statusLine = { type: "command", command: "node " + h + "/.claude-profiles/statusline.js" };
fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
' "$settings_file"
}

if [[ -f "$CLAUDE_DIR/settings.json" ]]; then
    configure_statusline "$CLAUDE_DIR/settings.json"
    ok "Configured statusline in settings.json"
fi

# Also configure for account2 — create settings.json if it doesn't exist
mkdir -p "$ACCOUNT2_DIR"
if [[ ! -f "$ACCOUNT2_DIR/settings.json" ]]; then
    echo '{}' > "$ACCOUNT2_DIR/settings.json"
fi
configure_statusline "$ACCOUNT2_DIR/settings.json"
ok "Configured statusline in account2/settings.json"

# ── Set up shared data (symlinks from account2 -> ~/.claude) ─
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

    # Skip if already linked
    if [[ -L "$dest" ]]; then
        continue
    fi

    # Remove existing file/dir at dest before linking
    if [[ -e "$dest" ]]; then
        rm -rf "$dest"
    fi

    if $IS_WINDOWS; then
        # Windows: use junctions for dirs, hard links for files
        if [[ -d "$src" ]]; then
            # Convert to Windows paths for cmd
            win_src=$(cygpath -w "$src" 2>/dev/null || echo "$src")
            win_dest=$(cygpath -w "$dest" 2>/dev/null || echo "$dest")
            cmd //c "mklink /J \"$win_dest\" \"$win_src\"" &>/dev/null && \
                ok "Junction: $item" || warn "Could not create junction for $item"
        else
            ln "$src" "$dest" 2>/dev/null && \
                ok "Linked: $item" || warn "Could not link $item"
        fi
    else
        ln -s "$src" "$dest" && \
            ok "Symlink: $item" || warn "Could not symlink $item"
    fi
done

# ── Install launcher script ──────────────────────────────────
info "Installing launcher script..."

# Determine install directory
BIN_DIR="$HOME/.local/bin"

if [[ -n "$1" ]]; then
    BIN_DIR="$1"
fi

mkdir -p "$BIN_DIR"

# The launcher is called "ccc", not "cc": on macOS and most Linux distros
# /usr/bin/cc is the system C compiler, and BIN_DIR is meant to sit early in
# PATH, so installing a "cc" here would shadow the compiler and break builds
# that shell out to it (make, node-gyp, and so on).
cp "$SCRIPT_DIR/bin/ccc" "$BIN_DIR/ccc"
chmod +x "$BIN_DIR/ccc"
ok "Installed ccc -> $BIN_DIR/ccc"

# On Windows (Git Bash), also install the .bat launcher
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
    echo -e "  Add it to your shell profile:"
    echo ""
    echo -e "    ${BOLD}export PATH=\"$BIN_DIR:\$PATH\"${RESET}"
    echo ""
    echo -e "  Add this line to your ${DIM}~/.bashrc${RESET}, ${DIM}~/.zshrc${RESET}, or ${DIM}~/.profile${RESET}"
fi

# ── Done ──────────────────────────────────────────────────────
echo ""
echo -e "  ${GREEN}${BOLD}Installation complete!${RESET}"
echo ""
echo -e "  ${BOLD}Usage:${RESET}"
echo -e "    ${CYAN}ccc${RESET}          Open account picker"
echo -e "    ${CYAN}ccc 1${RESET}        Launch with Account 1 (default)"
echo -e "    ${CYAN}ccc 2${RESET}        Launch with Account 2"
echo -e "    ${CYAN}ccc 2 -c${RESET}     Launch Account 2 in continue mode"
echo ""
echo -e "  ${BOLD}Statusline:${RESET}"
echo -e "    Configured automatically. Your Claude Code sessions"
echo -e "    will show the account badge and powerline segments."
echo ""
echo -e "  ${BOLD}First-time setup for Account 2:${RESET}"
echo -e "    Run ${CYAN}ccc 2${RESET} and log in when prompted."
echo ""
