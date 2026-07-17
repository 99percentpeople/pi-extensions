# Pi Extensions Makefile
# Provides common development commands

.PHONY: help install lint test check clean pack

# Default target
help:
	@echo "Pi Extensions Development Commands:"
	@echo ""
	@echo "  make install    - Install dependencies"
	@echo "  make lint       - Run type checking"
	@echo "  make test       - Run unit tests"
	@echo "  make check      - Run type checking and unit tests"
	@echo "  make clean      - Clean build artifacts"
	@echo "  make pack       - Validate all npm package tarballs"
	@echo "  make help       - Show this help"
	@echo ""

# Install dependencies
install:
	bun install

# Type checking
lint:
	bun run lint

# Run unit tests
test:
	bun run test

# Run all checks
check:
	bun run check

# Clean build artifacts
clean:
	rm -rf node_modules
	rm -rf dist
	rm -rf build
	rm -f *.tsbuildinfo

# Validate independently published packages
pack:
	bun run pack:check
