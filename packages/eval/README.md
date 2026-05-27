# @agentium/eval

Evaluation framework for testing and scoring Agentium agent outputs.

## Install

```bash
npm install @agentium/eval
```

## Quick Start

```typescript
import { EvalSuite, contains, regexMatch } from "@agentium/eval";

const suite = new EvalSuite({
  name: "basic-tests",
  agent: myAgent,
  cases: [
    { input: "What is 2+2?", expected: "4" },
    { input: "Say hello", expected: "hello" },
  ],
  scorers: [contains(), regexMatch(/\d+/)],
});

const results = await suite.run();
```

## Documentation

Full docs at [docs.agentium.in](https://docs.agentium.in)

## Community

Join the conversation on [Discord](https://discord.gg/T86SJshP).

## License

MIT
