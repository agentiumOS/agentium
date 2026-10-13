import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RootExecutionError } from "../../agent/root-execution.js";
import { RunContext } from "../../agent/run-context.js";
import { DurableConflictError, DurableRecoveryRequiredError } from "../../durable/types.js";
import { EventBus } from "../../events/event-bus.js";
import { ToolExecutor } from "../tool-executor.js";

describe("fatal durable tool boundaries", () => {
  for (const error of [
    new DurableConflictError(),
    new DurableRecoveryRequiredError(),
    new RootExecutionError("root_attempt_limit", "exhausted"),
  ]) {
    it(`propagates ${error.name} instead of presenting it as a model-visible tool error`, async () => {
      const executor = new ToolExecutor([
        {
          name: "effect",
          description: "effect",
          parameters: z.object({}),
          execute: async () => {
            throw error;
          },
        },
      ]);
      await expect(
        executor.executeAll(
          [{ id: "call", name: "effect", arguments: {} }],
          new RunContext({ sessionId: "session", eventBus: new EventBus() }),
        ),
      ).rejects.toBe(error);
    });
  }
});
