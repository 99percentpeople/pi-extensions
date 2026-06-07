# Tests

This directory contains tests for the Pi extensions.

## Running Tests

### Manual Testing

The easiest way to test extensions is to run them individually:

```bash
# Test a specific extension
pi -e ./extensions/background-tasks/index.ts

# Test multiple extensions
pi -e ./extensions/background-tasks/index.ts \
   -e ./extensions/permission-gate/index.ts
```

### Automated Testing

For automated testing, you can use the installation script:

```bash
# Windows
.\scripts\install.ps1 -Test

# Linux/macOS
./scripts/install.sh --test
```

## Test Cases

### background-tasks

1. Start a background task
2. Check task status
3. Read task logs
4. Send input to task
5. Stop a running task

### permission-gate

1. Try to run a dangerous command (e.g., `rm -rf /`)
2. Verify confirmation dialog appears
3. Confirm or deny the command
4. Check blocked commands history

### status-line

1. Start Pi with status-line extension
2. Verify status information is displayed
3. Change directories
4. Switch models
5. Verify status updates

### session-name

1. Start a new session
2. Send a message
3. Verify session is named
4. Use `/name` command
5. Clear session name

### weather

1. Ask for weather in a supported city
2. Verify weather information is displayed
3. Try an unsupported city
4. Use `/weather` command

## Writing Tests

When writing tests for extensions:

1. Test the main functionality
2. Test edge cases
3. Test error handling
4. Test user interactions
5. Test rendering (if applicable)

## Debugging

To debug extensions:

1. Use `console.log()` for logging
2. Check Pi's error output
3. Test with minimal extensions
4. Use `pi -e` for quick testing
