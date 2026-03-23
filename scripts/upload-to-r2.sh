#!/bin/bash
# Wrapper for Typora Custom Command — loads nvm so `node` is available.
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."
node "$SCRIPT_DIR/upload-to-r2.js" "$@"
