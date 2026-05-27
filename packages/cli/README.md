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

Templates:

| Template | What you get |
|----------|--------------|
| `basic`  | Minimal `Agent` + Express server |
| `rag`    | Knowledge base with hybrid search wired up |
| `voice`  | Voice agent with WebSocket gateway |
| `browser`| `BrowserAgent` with Playwright |

### `agentium dev`

Run an Agentium app in dev mode with hot reload.

```bash
agentium dev --entry ./src/index.ts
```

### `agentium skills install <source>`

Install a skill (pre-packaged tool bundle + instructions) from a git URL, npm package, or local path. Skills are persisted under `.agentium/skills/` and auto-attached the next time the agent starts.

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
