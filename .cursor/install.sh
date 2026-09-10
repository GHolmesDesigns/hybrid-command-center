#!/usr/bin/env bash
# Idempotent Cloud Agent setup for Hybrid Command Center.
# The project requires Node.js >= 24 (it uses the built-in node:sqlite module).
# The VM ships an older node on PATH via /exec-daemon, so we install Node 24 with
# nvm and make sure it is picked ahead of that on every future shell.
set -euo pipefail

NODE_MAJOR=24
export NVM_DIR="$HOME/.nvm"

# Install nvm if it is not already present.
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"

# Install and select Node 24.
nvm install "$NODE_MAJOR"
nvm alias default "$NODE_MAJOR"
nvm use "$NODE_MAJOR"

NODE_BIN_DIR="$(dirname "$(nvm which "$NODE_MAJOR")")"

# Ensure interactive/login shells (and tmux terminals) use Node 24 ahead of the
# node that /exec-daemon injects at the front of PATH.
if ! grep -q 'HCC Node 24' "$HOME/.bashrc" 2>/dev/null; then
  cat >> "$HOME/.bashrc" <<EOF

# HCC Node 24 (project requires Node >= 24; prepend before /exec-daemon's node)
export NVM_DIR="\$HOME/.nvm"
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
export PATH="$NODE_BIN_DIR:\$PATH"
EOF
fi

export PATH="$NODE_BIN_DIR:$PATH"
node --version
npm --version

cd "$(dirname "$0")/.."

# Local, non-secret env file. Drive/publishing stay unconfigured until secrets are added.
[ -f .env ] || cp .env.example .env

# Install dependencies from the lockfile.
npm ci

# Initialize the local SQLite database and load safe demo + Signal content.
npm run db:migrate
npm run db:seed
npm run signal:import

echo "Hybrid Command Center setup complete."
