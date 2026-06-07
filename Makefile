# Pi Extensions Makefile
# Provides common development commands

.PHONY: help install lint test clean publish

# Default target
help:
	@echo "Pi Extensions Development Commands:"
	@echo ""
	@echo "  make install    - Install dependencies"
	@echo "  make lint       - Run type checking"
	@echo "  make test       - Test extensions"
	@echo "  make clean      - Clean build artifacts"
	@echo "  make publish    - Publish to npm"
	@echo "  make help       - Show this help"
	@echo ""
	@echo "Extension Commands:"
	@echo "  make test-ext EXT=<name>  - Test specific extension"
	@echo "  make list-ext             - List all extensions"
	@echo ""

# Install dependencies
install:
	npm install

# Type checking
lint:
	npm run lint

# Test extensions
test:
	@echo "Testing extensions..."
	@for ext in extensions/*/; do \
		if [ -f "$$ext/index.ts" ]; then \
			echo "Testing $$(basename $$ext)..."; \
			pi -e "$$ext/index.ts" --help > /dev/null 2>&1 && echo "  ✓ OK" || echo "  ✗ Failed"; \
		fi \
	done

# Test specific extension
test-ext:
	@if [ -z "$(EXT)" ]; then \
		echo "Usage: make test-ext EXT=<extension-name>"; \
		exit 1; \
	fi
	@if [ -f "extensions/$(EXT)/index.ts" ]; then \
		echo "Testing $(EXT)..."; \
		pi -e "extensions/$(EXT)/index.ts"; \
	else \
		echo "Extension '$(EXT)' not found"; \
		exit 1; \
	fi

# List all extensions
list-ext:
	@echo "Available extensions:"
	@for ext in extensions/*/; do \
		if [ -f "$$ext/index.ts" ]; then \
			echo "  - $$(basename $$ext)"; \
		fi \
	done

# Clean build artifacts
clean:
	rm -rf node_modules
	rm -rf dist
	rm -rf build
	rm -f *.tsbuildinfo

# Publish to npm
publish:
	npm publish

# Initialize git repository
init:
	git init
	git add .
	git commit -m "Initial commit: Pi extensions project"

# Show project structure
tree:
	@echo "Project structure:"
	@find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' | sort | sed 's|[^/]*/|  |g'

# Check for TypeScript errors
check:
	npm run check

# Format code (if prettier is installed)
format:
	npx prettier --write "**/*.{ts,js,json,md}"

# Lint code (if eslint is installed)
eslint:
	npx eslint "**/*.{ts,js}"
