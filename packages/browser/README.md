# @agentium/browser

Browser automation agent for Agentium using Playwright.

## Custom tool execution boundary

Custom ToolDefs execute through the core ToolExecutor, including Zod validation, mandatory `executionPolicy`, and `approval`/`approvalManager` decisions. Explicit approval requirements fail closed without an approver. `run(task, { context })` accepts an inherited RunContext; `asTool()` forwards the parent context automatically, preserving identity, tenant, session, policy, and cancellation. Completing a nested browser run leaves unrelated parent approvals pending.

Standalone runs accept `sessionId`, `userId`, `tenantId`, `signal`, and `runMode`. Plan mode rejects browser execution before launch because native browser actions do not yet have a host-owned effect classifier. In execute mode, the custom-tool policy does **not** govern native click/type/navigation/evaluate actions. Configure the existing browser controls for those operations; this change does not claim native browser sandboxing.

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
console.log(result.result);
```

Jev can pick the next click from a closed per-step list (`planner: "jev"`). Do not set `model: jev()`.

```typescript
const agent = new BrowserAgent({
  name: "jev-browser",
  model: openai("gpt-4o-mini"),
  planner: "jev",
});
```

## Documentation

Full docs at [docs.agentium.in](https://docs.agentium.in)

## Community

Join the conversation on [Discord](https://discord.gg/T86SJshP).

## License

MIT

### DOM observation privacy

Element labels use explicit labels, ARIA text, placeholders and names; filled input, textarea and contenteditable values are excluded. This covers password, OTP and payment fields without relying on their input type. It does not redact arbitrary visible page text or screenshot pixels. Hosts should choose observation modes appropriate to the page and keep credentials behind the existing credential references.
