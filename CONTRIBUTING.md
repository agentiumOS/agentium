# Contributing to Agentium

Thanks for your interest in contributing to Agentium! This guide covers everything you need to get started.

## Prerequisites

- **Node.js** >= 20
- **npm** >= 10

## Getting Started

```bash
# Clone the repo
git clone https://github.com/agentiumOS/agentium.git
cd agentium

# Install dependencies
npm install --legacy-peer-deps

# Build all packages
npm run build

# Run tests
npm test
```

## Monorepo Structure

```
packages/
  core/          @agentium/core           Agents, Models, Tools, Memory, Events, Voice
  transport/     @agentium/transport      Express + Socket.IO gateways
  queue/         @agentium/queue          BullMQ background jobs
  browser/       @agentium/browser        Vision-based browser automation
  eval/          @agentium/eval           Agent output evaluation framework
  observability/ @agentium/observability  Tracing, metrics, structured logging
  admin/         @agentium/admin          Admin CRUD API
  edge/          @agentium/edge           IoT toolkits and edge runtime
benchmarks/      Benchmark suites
scripts/         Release and utility scripts
```

Examples and docs are maintained in separate repositories under the `agentiumOS` org.

## Development Workflow

### Building

```bash
npm run build              # Build all packages
npm run build:core         # Build only @agentium/core
npm run build:transport    # Build only @agentium/transport
npm run build:queue        # Build only @agentium/queue
npm run build:browser      # Build only @agentium/browser
```

Each package uses [tsup](https://tsup.egoist.dev/) for bundling (ESM output + type declarations).

### Testing

We use [Vitest](https://vitest.dev/) for unit testing. Tests live next to the source files they test in `__tests__/` directories.

```bash
npm test                   # Run all tests once
npm run test:watch         # Run in watch mode
```

To run tests for a specific package:

```bash
npx vitest run packages/core
npx vitest run packages/browser
```

When adding new features, please include tests. All LLM-dependent tests should use mocks/stubs — no real API calls.

### Linting & Formatting

We use [Biome](https://biomejs.dev/) for both linting and formatting.

```bash
npm run lint               # Check for lint and format issues
npm run lint:fix           # Auto-fix lint and format issues
npm run format             # Format all files
```

Configuration lives in `biome.json` at the root.

### Git Hooks

[Husky](https://typicode.github.io/husky/) is set up with:

- **pre-commit** — runs `lint-staged` to auto-fix formatting on staged files
- **pre-push** — runs the full test suite before pushing

These hooks install automatically via the `prepare` script when you run `npm install`.

## Making Changes

### Branch Naming

Use descriptive branch names:

- `feat/voice-session-persistence`
- `fix/sandbox-timeout-race`
- `docs/update-browser-agent`
- `refactor/tool-executor-cleanup`

### Commit Messages

Follow conventional commit style:

```
feat: add cookie persistence to BrowserAgent
fix: resolve sandbox worker path on Windows
docs: update voice agent quickstart
test: add approval manager timeout tests
refactor: simplify EventBus typed events
chore: bump vitest to v4
```

### Pull Request Process

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Ensure `npm test` and `npm run lint` pass
4. Write or update tests for your changes
5. Update documentation if you changed public APIs
6. Open a PR with a clear description of what and why

### Adding a New Package

1. Create `packages/<name>/` with `package.json`, `tsconfig.json`, `src/index.ts`
2. Add it to the root `package.json` workspaces array
3. Add it to `scripts/release.mjs` — update **both** the `PACKAGES` array and the `PEER_DEP_FILES` array so that version bumps and peer-dependency syncs include the new package
4. Add it to `.github/workflows/publish.yml` — add a publish step for the new `@agentium/<name>` scope so the CI pipeline publishes it alongside existing packages
5. Add a build script in the root `package.json`

### Adding New Tests

Test files should be placed at `packages/<pkg>/src/<module>/__tests__/<name>.test.ts`.

```typescript
import { describe, it, expect, vi } from "vitest";

describe("MyFeature", () => {
  it("does the thing", () => {
    expect(1 + 1).toBe(2);
  });
});
```

## CI/CD

| Workflow | Trigger | What it does |
|----------|---------|-------------|
| `ci.yml` | Push to `main`, PRs | Lint + format check, run tests, build |
| `publish.yml` | Push tag `v*` | Build, publish all packages to npm, create GitHub Release |

## Releasing

Maintainers can release by running:

```bash
npm run release -- patch   # 0.3.9 → 0.3.10
npm run release -- minor   # 0.3.9 → 0.4.0
npm run release -- major   # 0.3.9 → 1.0.0
```

This bumps versions across all packages, commits, tags, and pushes. GitHub Actions then publishes to npm and creates a GitHub Release automatically.

## Code Style

- TypeScript with ESM (`"type": "module"`)
- 2-space indentation, double quotes, trailing commas, semicolons (enforced by Biome)
- Avoid comments that just narrate what the code does
- Use `defineTool()` for creating tools, `z.object()` for parameter schemas
- Use factory functions for models: `openai()`, `google()`, `anthropic()`, etc.

## Getting Help

- Open an issue for bugs or feature requests
- Start a discussion for questions or ideas

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
