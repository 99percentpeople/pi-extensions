# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- PTY-backed background tasks via `bg_start pty=true`
- `/bg-attach` full-screen terminal attachment with `Ctrl+]` detach
- Headless terminal snapshots for `bg_logs` on PTY tasks
- Initial project structure
- background-tasks extension for running long commands in the background
- pwsh-adapter extension for PowerShell 7 support on Windows
- midnight theme
- git-workflow skill
- code-review prompt template

### Changed
- Split background-tasks and pwsh-adapter into independently published npm packages
- Made pwsh-adapter a no-op outside Windows

## [1.0.0] - 2026-06-07

### Added
- Initial release
- Core extensions: background-tasks, pwsh-adapter
- Safety extensions: permission-gate
- UI extensions: status-line, session-name
- Theme: midnight
- Skill: git-workflow
- Prompt: code-review
