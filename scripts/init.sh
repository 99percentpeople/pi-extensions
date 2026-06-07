#!/bin/bash
# Pi Extensions Initialization Script
# This script helps initialize a new Pi extensions project

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

show_help() {
    echo "Pi Extensions Initialization Script"
    echo ""
    echo "Usage:"
    echo "  ./scripts/init.sh <project-name>"
    echo ""
    echo "Example:"
    echo "  ./scripts/init.sh my-pi-extensions"
}

if [ -z "$1" ]; then
    echo "Error: Project name is required"
    show_help
    exit 1
fi

if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
    show_help
    exit 0
fi

NAME="$1"
PROJECT_DIR="$(pwd)/$NAME"

echo "Initializing Pi extensions project: $NAME"

# Create project directory
if [ -d "$PROJECT_DIR" ]; then
    echo "Error: Directory '$NAME' already exists"
    exit 1
fi

mkdir -p "$PROJECT_DIR"
cd "$PROJECT_DIR"

# Copy template files
echo "Copying template files..."

# Copy essential files
files=(
    "package.json"
    "tsconfig.json"
    ".gitignore"
    "README.md"
    "AGENTS.md"
    "CHANGELOG.md"
    "CONTRIBUTING.md"
    "LICENSE"
)

for file in "${files[@]}"; do
    source="$ROOT_DIR/$file"
    if [ -f "$source" ]; then
        cp "$source" "$file"
        echo "  ✓ Copied $file"
    fi
done

# Copy directories
dirs=(
    "extensions"
    "themes"
    "skills"
    "prompts"
    "scripts"
    "examples"
    "tests"
)

for dir in "${dirs[@]}"; do
    source="$ROOT_DIR/$dir"
    if [ -d "$source" ]; then
        cp -r "$source" "$dir"
        echo "  ✓ Copied $dir/"
    fi
done

# Update package.json with project name
echo "Updating package.json..."
if command -v node &> /dev/null; then
    node -e "
        const fs = require('fs');
        const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
        pkg.name = '$NAME';
        fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
    "
    echo "  ✓ Updated package name to '$NAME'"
else
    echo "  ⚠ Node.js not found, please update package.json manually"
fi

# Initialize git repository
echo "Initializing git repository..."
git init
git add .
git commit -m "Initial commit: Pi extensions project"
echo "  ✓ Git repository initialized"

echo ""
echo "Project initialized successfully!"
echo ""
echo "Next steps:"
echo "  1. cd $NAME"
echo "  2. Edit package.json to update project details"
echo "  3. Create your extensions in extensions/"
echo "  4. Test with: pi -e ./extensions/your-extension/index.ts"
echo "  5. Push to GitHub and share with the community!"
