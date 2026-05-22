# @agentium/browser

Browser automation agent for Agentium using Playwright.

## Install

```bash
npm install @agentium/browser playwright
```

## Quick Start

```typescript
import { BrowserAgent } from "@agentium/browser";
import { openai } from "@agentium/core";

const agent = new BrowserAgent({
  name: "browser-bot",
  model: openai("gpt-4o"),
  instructions: "Navigate websites and extract information.",
});

const result = await agent.run("Go to example.com and get the page title");
console.log(result.text);
```

## Documentation

Full docs at [agentium.mintlify.dev](https://agentium.mintlify.dev)

## License

MIT
