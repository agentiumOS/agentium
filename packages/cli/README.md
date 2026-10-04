# @agentium/cli

Command-line tool for scaffolding and managing Agentium projects.

## Install

```bash
npm install -g @agentium/cli
```

Or run on demand without installing:

```bash
npx @agentium/cli init my-app
```

## Commands

### `agentium init <name>`

Scaffold a new Agentium project. Aliases: `new`, `create`.

```bash
agentium init my-app --template basic
agentium init voice-app --template voice
agentium init rag-app --template rag
agentium init browser-app --template browser
```

Requires Node 22.18+ (22.x) or 24.11+ (24.x). Names must be lowercase npm names without scopes or paths. Existing destinations are refused before writing. Generated projects use the CLI release range, bounded optional SDK ranges, and include `typecheck` and setup instructions. Set `OPENAI_API_KEY` in your shell and `OPENAI_MODEL` for text/browser examples. Browser projects also need `npx playwright install chromium`.

Templates:

| Template | What you get |
|----------|--------------|
| `basic`  | One `Agent` request with resource cleanup |
| `rag`    | In-memory vector retrieval passed as evidence to an Agent |
| `voice`  | Configured `VoiceAgent` with an OpenAI Realtime provider; supply your own media transport |
| `browser`| `BrowserAgent` with Playwright |

### `agentium dev`

Run an Agentium app in dev mode with hot reload.

```bash
agentium dev --entry ./src/index.ts
```

### `agentium skills install <source>`

Install an npm/Git package using npm with install scripts disabled, or validate a local directory containing `SKILL.md` (or the file itself). Register the package tools or skill directory explicitly in your application or harness configuration. This command does not create a runtime manifest or attach skills automatically.

```bash
agentium skills install github:agentiumOS/skill-gmail
agentium skills install @some-org/skill-pagerduty
agentium skills install ./local-skill
```

### `agentium publish`

Convenience wrapper around `npm publish --access public` — useful inside an Agentium monorepo where you want one command to run from any package directory.

## Documentation

Full docs at [docs.agentium.in](https://docs.agentium.in)

## Community

Join the conversation on [Discord](https://discord.gg/T86SJshP).

## License

MIT
