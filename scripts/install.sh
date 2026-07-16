#!/bin/bash
# Pi Extensions Installation Script
# This script helps install and test Pi extensions

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

show_help() {
    echo "Pi Extensions Installation Script"
    echo ""
    echo "Usage:"
    echo "  ./scripts/install.sh              # Install background-tasks to current project"
    echo "  ./scripts/install.sh --global     # Install background-tasks globally"
    echo "  ./scripts/install.sh --with-pwsh  # Also install the Windows pwsh adapter"
    echo "  ./scripts/install.sh --test       # Test extensions"
    echo "  ./scripts/install.sh --help       # Show this help"
    echo ""
    echo "Examples:"
    echo "  ./scripts/install.sh --global                    # Install background-tasks globally"
    echo "  ./scripts/install.sh --global --with-pwsh        # Install both packages globally"
    echo "  ./scripts/install.sh --test       # Test all extensions"
}

test_extensions() {
    echo "Testing Pi extensions..."
    
    for ext_dir in "$ROOT_DIR/extensions"/*/; do
        if [ -f "$ext_dir/index.ts" ]; then
            ext_name=$(basename "$ext_dir")
            echo -n "Testing $ext_name... "
            
            if pi -e "$ext_dir/index.ts" --help > /dev/null 2>&1; then
                echo "✓ loaded successfully"
            else
                echo "✗ failed to load"
            fi
        fi
    done
    
    echo ""
    echo "Test completed!"
}

install_global() {
    echo "Installing Pi extension packages globally..."
    
    # Check if pi is installed
    if ! command -v pi &> /dev/null; then
        echo "Error: Pi is not installed or not in PATH"
        echo "Please install Pi first: https://github.com/badlogic/pi-mono"
        exit 1
    fi
    
    pi_version=$(pi --version 2>&1)
    echo "Found Pi: $pi_version"
    
    echo "Installing background-tasks to global Pi directory..."
    pi install "$ROOT_DIR/extensions/background-tasks"
    if [ "$INSTALL_PWSH" = true ]; then
        echo "Installing pwsh-adapter..."
        pi install "$ROOT_DIR/extensions/pwsh-adapter"
    fi
    
    echo ""
    echo "Installation complete!"
    echo "Restart Pi to load the extensions."
}

install_local() {
    echo "Installing Pi extension packages to current project..."
    
    # Check if we're in a project directory
    if [ ! -d ".pi" ]; then
        echo "Creating .pi directory..."
        mkdir -p ".pi"
    fi
    
    echo "Installing background-tasks to project..."
    pi install -l "$ROOT_DIR/extensions/background-tasks"
    if [ "$INSTALL_PWSH" = true ]; then
        echo "Installing pwsh-adapter..."
        pi install -l "$ROOT_DIR/extensions/pwsh-adapter"
    fi
    
    echo ""
    echo "Installation complete!"
    echo "Restart Pi to load the extensions."
}

MODE="local"
INSTALL_PWSH=false
for arg in "$@"; do
    case "$arg" in
        --global|-g) MODE="global" ;;
        --test|-t) MODE="test" ;;
        --with-pwsh) INSTALL_PWSH=true ;;
        --help|-h) MODE="help" ;;
        *)
            echo "Unknown option: $arg"
            show_help
            exit 1
            ;;
    esac
done

case "$MODE" in
    global) install_global ;;
    test) test_extensions ;;
    help) show_help ;;
    local) install_local ;;
esac
