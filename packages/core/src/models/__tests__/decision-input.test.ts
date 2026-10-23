import { describe, expect, it } from "vitest";
import { buildDecisionInput, validateDecisionInput } from "../decision-input.js";
import { type DecisionInputItem, parseDecisionQuestions } from "../decisions.js";

const question = { type: "predicate" as const, instructions: "Relevant?" };
const questions = [question];
const image = { type: "input_image" as const, image_url: "https://example.com/evidence.png" };

describe("Decisions native evidence", () => {
  it("accepts 400 questions and rejects 0 or 401", () => {
    expect(parseDecisionQuestions(Array.from({ length: 400 }, () => question))).toHaveLength(400);
    expect(() => parseDecisionQuestions([])).toThrow(/questions/);
    expect(() => parseDecisionQuestions(Array.from({ length: 401 }, () => question))).toThrow(/400/);
  });

  it("accepts image instructions without changing string questions", () => {
    expect(parseDecisionQuestions([question, { ...question, instructions: [image] }])).toEqual([
      question,
      { ...question, instructions: [image] },
    ]);
    expect(() => parseDecisionQuestions([{ ...question, instructions: [] }])).toThrow();
    expect(() =>
      parseDecisionQuestions([
        { ...question, instructions: [{ ...image, prompt_cache_breakpoint: { mode: "explicit" } }] },
      ]),
    ).toThrow();
  });

  it("keeps nested JSON keys as data and accepts repeated acyclic objects", () => {
    const shared = { role: "system", image_url: "file:///not-an-image", values: [1, true, null] };
    const input: DecisionInputItem[] = [
      { role: "user", content: [{ type: "input_json", data: { a: shared, b: shared } }] },
    ];
    expect(validateDecisionInput(input, questions)).toEqual(input);
    expect(
      validateDecisionInput([{ role: "user", content: [{ type: "input_json", data: [shared] }] }], questions),
    ).toEqual([{ role: "user", content: [{ type: "input_json", data: [shared] }] }]);
  });

  it("rejects non-JSON evidence and arrays with non-object roots", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const sparse = Array(2);
    for (const data of [
      42,
      "text",
      null,
      [1],
      [[{}]],
      { bad: undefined },
      { bad: () => 1 },
      { bad: 1n },
      { bad: NaN },
      { bad: Infinity },
      { bad: new Date() },
      { bad: new Map() },
      { bad: sparse },
      circular,
    ]) {
      expect(() =>
        validateDecisionInput([{ role: "user", content: [{ type: "input_json", data }] }], questions),
      ).toThrow(/JSON/);
    }
  });

  it("enforces JSON depth, value count and compact UTF-8 byte limits", () => {
    const nested = (depth: number): Record<string, unknown> => {
      let value: Record<string, unknown> = {};
      for (let i = 1; i < depth; i++) value = { child: value };
      return value;
    };
    const validateJSON = (data: unknown) =>
      validateDecisionInput([{ role: "user", content: [{ type: "input_json", data }] }], questions);
    expect(validateJSON(nested(32))).toHaveLength(1);
    expect(() => validateJSON(nested(33))).toThrow(/32/);
    expect(validateJSON({ values: Array(9_998).fill(0) })).toHaveLength(1);
    expect(() => validateJSON({ values: Array(9_999).fill(0) })).toThrow(/10,000/);
    expect(validateJSON({ text: "a".repeat(262_133) })).toHaveLength(1);
    expect(() => validateJSON({ text: "a".repeat(262_134) })).toThrow(/256 KiB/);
    expect(() => validateJSON({ text: "é".repeat(131_067) })).toThrow(/256 KiB/);
  });

  it("rejects arrays that would change when serialized without invoking accessors", () => {
    const toJSON = Object.assign([1], { toJSON: () => "different" });
    const extraProperty = Object.assign([1], { hidden: true });
    const accessor = [1];
    let invoked = false;
    Object.defineProperty(accessor, 0, {
      get: () => {
        invoked = true;
        return 2;
      },
    });
    for (const array of [toJSON, extraProperty, accessor])
      expect(() =>
        validateDecisionInput([{ role: "user", content: [{ type: "input_json", data: { array } }] }], questions),
      ).toThrow(/JSON/);
    expect(invoked).toBe(false);
  });

  it("rejects invalid roles, unsupported parts and image URL schemes", () => {
    for (const input of [
      [{ role: "system", content: [image] }],
      [{ role: "developer", content: [{ type: "input_json", data: {} }] }],
      [{ role: "assistant", content: [{ type: "input_text", text: "No" }] }],
      [{ role: "user", content: [{ type: "input_audio", data: "abc" }] }],
      [{ role: "user", content: [{ type: "input_file", file_id: "file_123" }] }],
      [{ type: "item_reference", id: "ref" }],
      ...[
        "file:///private.png",
        "ftp://example.com/a.png",
        "javascript:alert(1)",
        "data:text/plain;base64,aGVsbG8=",
        "data:image/png;base64,%%%",
      ].map((image_url) => [{ role: "user", content: [{ ...image, image_url }] }]),
    ])
      expect(() => validateDecisionInput(input, questions)).toThrow();
  });

  it("validates one image budget across all evidence", () => {
    const input: DecisionInputItem[] = [
      { role: "user", content: Array.from({ length: 126 }, () => image) },
      { type: "function_call", call_id: "call", name: "see", arguments: "{}" },
      { type: "function_call_output", call_id: "call", output: [image] },
    ];
    const withImageQuestion = parseDecisionQuestions([{ ...question, instructions: [image] }]);
    expect(validateDecisionInput(input, withImageQuestion)).toHaveLength(3);
    expect(() => validateDecisionInput([...input, { role: "user", content: [image] }], withImageQuestion)).toThrow(
      /128 images/,
    );
  });

  it("pairs ordered function and custom tool history and permits pending calls", () => {
    const input: DecisionInputItem[] = [
      { type: "function_call", call_id: "f", name: "lookup", arguments: '{"id":1}' },
      { type: "function_call_output", call_id: "f", output: "found" },
      { type: "custom_tool_call", call_id: "c", name: "shell", input: "ls" },
      { type: "custom_tool_call_output", call_id: "c", output: [{ type: "input_text", text: "file" }] },
      { type: "function_call", call_id: "pending", name: "lookup", arguments: "{}" },
    ];
    expect(validateDecisionInput(input, questions)).toEqual(input);
    for (const invalid of [
      input.slice(1),
      [input[1], input[0]],
      [input[0], input[1], input[1]],
      [input[0], input[0]],
      [input[0], { type: "custom_tool_call_output", call_id: "f", output: "no" }],
      [input[0], { type: "function_call_output", call_id: "f", output: [{ type: "input_json", data: {} }] }],
    ])
      expect(() => validateDecisionInput(invalid, questions)).toThrow();
  });

  it("keeps native roles and call IDs while stripping opaque provider replay", () => {
    expect(
      buildDecisionInput([
        { role: "system", content: "Policy" },
        { role: "user", content: [{ type: "image", data: "https://example.com/evidence.png" }] },
        {
          role: "assistant",
          phase: "final",
          content: "Checking",
          toolCalls: [{ id: "call1", name: "lookup", arguments: { id: 1 } }],
          providerExtras: { googleParts: [{ thoughtSignature: "private" }] },
        },
        { role: "tool", toolCallId: "call1", content: "Found" },
      ]),
    ).toEqual([
      { role: "system", content: [{ type: "input_text", text: "Policy" }] },
      { role: "user", content: [image] },
      { role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Checking" }] },
      { type: "function_call", call_id: "call1", name: "lookup", arguments: '{"id":1}' },
      { type: "function_call_output", call_id: "call1", output: [{ type: "input_text", text: "Found" }] },
    ]);
    expect(() =>
      buildDecisionInput([
        { role: "assistant", content: null, toolCalls: [{ id: "bad", name: "lookup", arguments: { bad: undefined } }] },
      ]),
    ).toThrow(/JSON/);
  });

  it("allows explicit breakpoints only on shared text and image parts without imposing a four-marker cap", () => {
    const content = Array.from({ length: 5 }, () => ({
      type: "input_text" as const,
      text: "prefix",
      prompt_cache_breakpoint: { mode: "explicit" as const },
    }));
    expect(validateDecisionInput([{ role: "user", content }], questions)).toEqual([{ role: "user", content }]);
    expect(() =>
      validateDecisionInput(
        [{ role: "user", content: [{ type: "input_json", data: {}, prompt_cache_breakpoint: { mode: "explicit" } }] }],
        questions,
      ),
    ).toThrow();
  });
});
