// The one-line installer. Served at /install.sh with the origin baked in, so
// `curl -fsSL https://<host>/install.sh | sh` installs from, and reports to,
// that host. POSIX sh; no bashisms.

export function installScript(origin: string): string {
  return `#!/bin/sh
# nerfd installer. Source: ${origin}/install.sh
# What this does: downloads the nerfd CLI to ~/.nerfd/app, links
# ~/.local/bin/ms, hooks Claude Code and Codex if present, and turns on
# autonomous reporting of redacted session records to ${origin}.
# Nothing is uploaded except derived metrics. Turn off any time: nerfd share off
set -e

BASE="\${NERFD_URL:-${origin}}"
APP="\${NERFD_APP:-$HOME/.nerfd/app}"
BIN="\${NERFD_BIN:-$HOME/.local/bin}"
# Sharing is on by default. Opt out at install time with NERFD_SHARE=off,
# or:  curl -fsSL .../install.sh | sh -s -- --no-share
SHARE_FLAG="--share"
case "\${NERFD_SHARE:-on}" in off|0|no|false) SHARE_FLAG="--no-share" ;; esac
for arg in "$@"; do [ "$arg" = "--no-share" ] && SHARE_FLAG="--no-share"; done

say() { printf '%s\\n' "$*"; }
die() { printf 'nerfd: %s\\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar  >/dev/null 2>&1 || die "tar is required"
command -v node >/dev/null 2>&1 || die "node 22.13+ is required. install: https://nodejs.org or 'brew install node' or 'nvm install 24'"

NODE_V="$(node -p 'process.versions.node')"
NODE_MAJ="\${NODE_V%%.*}"
NODE_REST="\${NODE_V#*.}"
NODE_MIN="\${NODE_REST%%.*}"
if [ "$NODE_MAJ" -lt 22 ] || { [ "$NODE_MAJ" -eq 22 ] && [ "$NODE_MIN" -lt 13 ]; }; then
  die "node $NODE_V found; 22.13+ is required (runs TypeScript natively)"
fi

say "installing nerfd into $APP"
mkdir -p "$APP" "$BIN"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$BASE/dist/nerfd.tgz" -o "$TMP/nerfd.tgz" || die "download failed from $BASE/dist/nerfd.tgz"
rm -rf "$APP"
mkdir -p "$APP"
tar -xzf "$TMP/nerfd.tgz" -C "$APP"

cat > "$BIN/nerfd" <<EOF
#!/bin/sh
exec "$(command -v node)" "$APP/packages/cli/src/cli.ts" "\\$@"
EOF
chmod +x "$BIN/nerfd"; ln -sf "$BIN/nerfd" "$BIN/ms"

"$BIN/nerfd" init --server "$BASE" "$SHARE_FLAG"

say ""
say "importing the last 90 days your tools already wrote, so the scorecard is populated on day one"
"$BIN/nerfd" backfill --since 90d || say "backfill failed; run  nerfd backfill --since 90d  later"
"$BIN/nerfd" backfill --restamp >/dev/null 2>&1 || true

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) say ""; say "add to your shell profile:  export PATH=\\"$BIN:\\$PATH\\"" ;;
esac
say ""
say "done. board: $BASE   set your plan for value-per-month: nerfd plan claude claude-max-20x"
if [ "$SHARE_FLAG" = "--share" ]; then
  say "sharing is on. run  nerfd privacy  to see the exact record before the first one is sent, or  nerfd share off"
else
  say "sharing is off. nothing leaves this machine. run  nerfd share on  when you want to contribute."
fi
`;
}
