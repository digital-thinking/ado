#!/bin/bash

# Exit on error
set -e

REPO_URL="https://github.com/digital-thinking/ado.git"
IS_TEMP=0

echo "IxADO Linux Installer"
echo "====================="

# Check for Git (Requirement)
if ! command -v git &> /dev/null; then
    echo "❌ Git is not installed. Please install Git first."
    exit 1
fi

# Check for Bun
if ! command -v bun &> /dev/null; then
    echo "❌ Bun is not installed."
    echo "Attempting to install Bun..."
    curl -fsSL https://bun.sh/install | bash

    # Add to path for this session
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
else
    echo "✅ Bun is already installed."
fi

# Verify Bun is now available
if ! command -v bun &> /dev/null; then
    echo "❌ Failed to install or locate Bun. Please install Bun manually: https://bun.sh"
    exit 1
fi

# Check if we are in the project root (local install) or need to clone (remote install)
if [ ! -f "package.json" ] || ! grep -q "ixado" "package.json"; then
    echo "⬇️  Cloning IxADO repository to temporary directory..."
    TEMP_DIR=$(mktemp -d)
    git clone "$REPO_URL" "$TEMP_DIR"
    cd "$TEMP_DIR"
    IS_TEMP=1
else
    echo "✅ Detected local project root."
fi

echo "📦 Installing dependencies..."
bun install

echo "🔨 Building binary..."
# Build specifically for Linux (no .exe extension)
bun run build:linux

# Determine install location
INSTALL_DIR="$HOME/.local/bin"

# Check if user wants to install elsewhere (only works for local script execution with args)
if [ ! -z "$1" ]; then
    INSTALL_DIR="$1"
fi

echo "📂 Installing to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
cp dist/ixado "$INSTALL_DIR/ixado"
chmod +x "$INSTALL_DIR/ixado"

# Cleanup if we cloned
if [ "$IS_TEMP" -eq 1 ]; then
    echo "🧹 Cleaning up temporary files..."
    cd ..
    rm -rf "$TEMP_DIR"
fi

echo "✅ IxADO installed successfully!"
echo ""
echo "Please ensure $INSTALL_DIR is in your PATH."
echo "You can verify installation by running: ixado help"
