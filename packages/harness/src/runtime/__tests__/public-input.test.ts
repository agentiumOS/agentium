import { describe, expect, it } from "vitest";
import { HarnessInputError, HarnessRuntime, parseRunInput, RUN_INPUT_LIMITS, validateRunInput } from "../../index.js";

describe("public input prevalidation", () => {
  it("uses UTF-8 JSON bytes and immutable public limits", () => {
    expect(Object.isFrozen(RUN_INPUT_LIMITS)).toBe(true);
    const limit = RUN_INPUT_LIMITS.maxNormalizedBytes;
    expect(validateRunInput("a".repeat(limit - 2))).toHaveLength(limit - 2);
    expect(() => validateRunInput("a".repeat(limit - 1))).toThrow(HarnessInputError);
    expect(() => validateRunInput("é".repeat(limit / 2))).toThrow(HarnessInputError);
    expect(parseRunInput(JSON.stringify([{ type: "text", text: "hi" }]))).toEqual([{ type: "text", text: "hi" }]);
    expect(() => parseRunInput(`${" ".repeat(limit)}"a"`)).toThrow(HarnessInputError);
  });
  it.each([null, 42, {}, [], [{ type: "text", text: "hi", unexpected: true }], [{ type: "image", data: 1 }]])(
    "rejects unsupported shape %j",
    (input) => {
      expect(() => validateRunInput(input)).toThrow(HarnessInputError);
      expect(() => parseRunInput(JSON.stringify(input))).toThrow(HarnessInputError);
    },
  );
  it("rejects malformed JSON and validates initial run input before invoking a driver", () => {
    expect(() => parseRunInput("{")).toThrow(HarnessInputError);
    const runtime = new HarnessRuntime({
      grants: { toolIds: [], modelRoles: [] },
      driver: {
        id: "input",
        version: 1,
        capabilities: { controls: [], controlledExecution: true, durable: false, policyCoverage: "local" },
        start: async () => {
          throw new Error("must not enter");
        },
      },
    });
    expect(() =>
      runtime.start("x".repeat(RUN_INPUT_LIMITS.maxNormalizedBytes), {
        identity: { tenantId: "t", userId: "u" },
        sessionId: "s",
      }),
    ).toThrow(HarnessInputError);
  });
});
