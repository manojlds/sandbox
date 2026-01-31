# Claude Developer Guide

Quick reference for working on the Pyodide Sandbox MCP Server.

## After Making Code Changes

### 1. Quick Validation (Run This First)
```bash
npm run validate
```
This runs: type-check + lint + format:check + build

If validation fails, fix issues with:
```bash
npm run lint:fix          # Auto-fix linting issues
npm run format            # Auto-format code
npm run type-check        # Check types (no auto-fix)
```

### 2. Run Tests
```bash
npm test                  # Run all unit tests
npm run test:watch        # Watch mode for development
npm run test:coverage     # Generate coverage report
```

### 3. Test Your Changes Manually
```bash
npm run dev               # Start server with hot reload
```

Then test with your MCP client (Cursor, etc).

## Before Committing

Run the full validation + tests:
```bash
npm run validate && npm test
```

If everything passes, you're ready to commit.

## Individual Commands Reference

### Type Checking
```bash
npm run type-check        # TypeScript type validation
```

### Linting
```bash
npm run lint              # Check for linting issues
npm run lint:fix          # Auto-fix linting issues
```

### Formatting
```bash
npm run format:check      # Check code formatting
npm run format            # Auto-format all files
```

### Building
```bash
npm run build             # Compile TypeScript to dist/
npm run clean             # Remove dist/ and temp files
```

### Testing
```bash
npm test                  # Run unit tests
npm run test:watch        # Run tests in watch mode
npm run test:coverage     # Run tests with coverage
npm run test:integration  # Run integration tests
npm run test:build        # Build + run integration tests
```

## Development Workflow

### Standard Workflow
1. Make your changes
2. `npm run validate` - Ensure code quality
3. `npm test` - Verify tests pass
4. `npm run dev` - Test manually (optional)
5. Commit your changes

### Quick Iteration (while developing)
1. Keep `npm run test:watch` running in one terminal
2. Keep `npm run dev` running in another terminal
3. Make changes and see immediate feedback

## Debugging

### Check TypeScript Compilation
```bash
npm run build
```
Errors here indicate type issues or syntax problems.

### Check Runtime Issues
```bash
npm run dev
```
Look at console output for runtime errors.

### Integration Testing
```bash
npm run test:integration
```
Tests the server with actual Pyodide integration.

## CI/CD Checklist

Before pushing to remote:
- [ ] `npm run validate` passes
- [ ] `npm test` passes
- [ ] Code builds successfully (`npm run build`)
- [ ] Manual testing completed (if applicable)

## Common Issues

### Lint errors?
```bash
npm run lint:fix && npm run format
```

### Type errors?
```bash
npm run type-check
# Read error messages carefully
# Fix types manually
```

### Tests failing?
```bash
npm run test:watch
# Watch mode shows which tests fail
# Fix tests or code, auto-reruns
```

### Build failing?
```bash
npm run clean && npm install && npm run build
```

## Quick Commands Summary

```bash
# The one command to rule them all
npm run validate && npm test

# After code changes (fast)
npm run type-check && npm test

# Before committing (complete)
npm run validate && npm test

# During development
npm run dev
npm run test:watch
```
