import { EventBus } from "../../events/event-bus.js";
import type { ExecutionServices } from "../execution-services.js";
import { RunContext } from "../run-context.js";
/** In-process host port fixture, deliberately independent of any harness runtime. */
export function executionFixture(overrides: Partial<ExecutionServices> = {}): ExecutionServices {
  const ctx = new RunContext({ sessionId: "host", eventBus: new EventBus(), signal: new AbortController().signal });
  return {
    ctx,
    signal: ctx.signal!,
    tools: [],
    history: [],
    executionPolicy: { decide: () => ({ action: "allow" }) },
    state: {},
    sessionKey: "host",
    model: (provider, messages, options) => provider.generate(messages, options),
    streamModel: (provider, messages, options) => provider.stream(messages, options),
    runOwned: (operation) => operation(),
    observeTool: async () => {},
    dispatchEffect: (_name, args, execute) => execute(args, ctx),
    dispatch: async () => {
      throw new Error("No fixture dispatcher configured");
    },
    recordConversation: () => {},
    ...overrides,
  };
}
