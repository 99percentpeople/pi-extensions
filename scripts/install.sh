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
    echo "  ./scripts/install.sh              # Install to current project"
    echo "  ./scripts/install.sh --global     # Install globally"
    echo "  ./scripts/install.sh --test       # Test extensions"
    echo "  ./scripts/install.sh --help       # Show this help"
    echo ""
    echo "Examples:"
    echo "  ./scripts/install.sh --global     # Install globally for all projects"
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
    echo "Installing Pi extensions globally..."
    
    # Check if pi is installed
    if ! command -v pi &> /dev/null; then
        echo "Error: Pi is not installed or not in PATH"
        echo "Please install Pi first: https://github.com/badlogic/pi-mono"
        exit 1
    fi
    
    pi_version=$(pi --version 2>&1)
    echo "Found Pi: $pi_version"
    
    # Install globally
    echo "Installing to global Pi directory..."
    pi install "$ROOT_DIR"
    
    echo ""
    echo "Installation complete!"
    echo "Restart Pi to load the extensions."
}

install_local() {
    echo "Installing Pi extensions to current project..."
    
    # Check if we're in a project directory
    if [ ! -d ".pi" ]; then
        echo "Creating .pi directory..."
        mkdir -p ".pi"
    fi
    
    # Install to current project
    echo "Installing to project..."
    pi install -l "$ROOT_DIR"
    
    echo ""
    echo "Installation complete!"
    echo "Restart Pi to load the extensions."
}

# Parse arguments
case "${1:-}" in
    --global|-g)
        install_global
        ;;
    --test|-t)
        test_extensions
        ;;
    --help|-h)
        show_help
        ;;
    "")
        install_local
        ;;
    *)
        echo "Unknown option: $1"
        show_help
        exit 1
        ;;
esac
