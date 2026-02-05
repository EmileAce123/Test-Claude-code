#!/bin/bash
set -euo pipefail

# Only run in remote (Claude Code on the web) environments
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Install dependencies
# Currently no dependencies to install. Add install commands here as the
# project grows, for example:
#   npm install
#   pip install -r requirements.txt

echo "Session start hook completed successfully"
