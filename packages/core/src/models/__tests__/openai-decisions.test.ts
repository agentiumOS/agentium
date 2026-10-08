import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Agent } from "../../agent/agent.js";
import { CostTracker } from "../../cost/cost-tracker.js";
import { type DecisionQuestion, parseDecisionQuestions, parseDecisionResponse } from "../decisions.js";
import { JevProvider } from "../providers/jev.js";
import { OpenAIDecisionsProvider } from "../providers/openai-decisions.js";
import { modelRegistry, openaiDecisions } from "../registry.js";
import type { ChatMessage, ModelConfig } from "../types.js";

const questions: DecisionQuestion[] = [
  { type: "predicate", name: "urgent", instructions: "Is this urgent?" },
  { type: "choice", name: "route", instructions: "Where?", choices: [{ value: "billing" }, { value: false }] },
  { type: "score", name: "severity", instructions: "How severe?", levels: [{ label: "low" }, { label: "high" }] },
  { type: "predicate", name: "restricted", instructions: "Restricted?" },
];
const answers = [
  { type: "predicate", name: "urgent", probability: 0.9 },
  {
    type: "choice",
    name: "route",
    choice: false,
    confidence: 0.7,
    probabilities: [
      { value: "billing", probability: 0.1 },
      { value: false, probability: 0.9 },
    ],
  },
  {
    type: "score",
    name: "severity",
    score: 0.75,
    confidence: 0.5,
    probabilities: [
      { value: 0, label: "low", probability: 0.25 },
      { value: 1, label: "high", probability: 0.75 },
    ],
  },
  { type: "refusal", name: "restricted" },
];
function result(selectedAnswers: unknown = answers) {
  return {
    model: "gpt-6-luna",
    answers: selectedAnswers,
    usage: {
      input_tokens: 1000,
      output_tokens: 0,
      total_tokens: 1000,
      input_tokens_details: { cached_tokens: 100, cache_write_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}
const input: ChatMessage[] = [{ role: "user", content: "Charged twice" }];
let baseURL: string;
let received: { body: unknown; authorization?: string; path?: string }[] = [];
let responseBody: unknown;
let respond: (req: IncomingMessage, res: ServerResponse) => void;
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  received.push({
    body: JSON.parse(Buffer.concat(chunks).toString()),
    authorization: req.headers.authorization,
    path: req.url,
  });
  respond(req, res);
});
function provider(defaultQuestions = questions) {
  return new OpenAIDecisionsProvider("gpt-6-luna", { apiKey: "fixture-key", baseURL, questions: defaultQuestions });
}

beforeAll(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  baseURL = `http://127.0.0.1:${address.port}/v1`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});
beforeEach(() => {
  received = [];
  responseBody = result();
  respond = (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(responseBody));
  };
});

describe("OpenAI Decisions actual SDK HTTP integration", () => {
  it("registers the factory without needing credentials", () => {
    expect(modelRegistry.has("openai-decisions")).toBe(true);
    expect(openaiDecisions().modelId).toBe("gpt-6-luna");
  });

  it("sends native questions and keeps boolean choices, fractional scores and mixed refusals", async () => {
    const response = await provider().generate(input);
    expect(received).toEqual([
      {
        path: "/v1/decisions",
        authorization: "Bearer fixture-key",
        body: {
          model: "gpt-6-luna",
          questions,
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: "[user]" },
                { type: "input_text", text: "Charged twice" },
              ],
            },
          ],
        },
      },
    ]);
    expect(response.decisions).toEqual(answers);
    expect(JSON.parse(String(response.message.content))).toEqual(answers);
    expect(response.raw).toEqual(result());
    expect(response.finishReason).toBe("stop");
    expect(response.usage).toMatchObject({
      promptTokens: 1000,
      completionTokens: 0,
      pricingKey: "openai-decisions/gpt-6-luna",
    });
  });

  it("replaces constructor questions and uses a per-request key without retaining it", async () => {
    const model = provider();
    responseBody = result([{ type: "predicate", name: null, probability: 0.2 }]);
    const replacement: DecisionQuestion[] = [{ type: "predicate", instructions: "New?" }];
    await model.generate(input, { questions: replacement, apiKey: "override" });
    responseBody = result();
    await model.generate(input);
    expect(received[0]).toMatchObject({ authorization: "Bearer override", body: { questions: replacement } });
    expect(received[1]).toMatchObject({ authorization: "Bearer fixture-key", body: { questions } });
  });

  it("preserves conversation roles as labeled evidence and includes inline images", async () => {
    await provider().generate([
      { role: "system", content: "Apply the ticket policy" },
      { role: "assistant", content: "Earlier answer" },
      { role: "user", content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] },
    ]);
    expect(received[0]?.body).toMatchObject({
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "[system]" },
            { type: "input_text", text: "Apply the ticket policy" },
          ],
        },
        {
          role: "user",
          content: [
            { type: "input_text", text: "[assistant]" },
            { type: "input_text", text: "Earlier answer" },
          ],
        },
        {
          role: "user",
          content: [
            { type: "input_text", text: "[user]" },
            { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
          ],
        },
      ],
    });
  });

  it("reports all-refused responses without inventing answers", async () => {
    responseBody = result(questions.map(({ name }) => ({ type: "refusal", name })));
    expect((await provider().generate(input)).finishReason).toBe("content_filter");
  });

  it("exposes decisions and endpoint-specific cost through Agent.run", async () => {
    const costTracker = new CostTracker();
    const agent = new Agent({ name: "decisions-run", model: provider(), costTracker, register: false });
    const output = await agent.run("Charged twice", { questions });
    expect(output.decisions).toEqual(answers);
    expect(output.usage.providerMetrics).toEqual(result().usage);
    expect(costTracker.getSummary().totalCost).toBeCloseTo(0.00009);
    expect(costTracker.getEntries()[0]?.modelId).toBe("gpt-6-luna");
  });

  it("streams one completed answer, preserves decisions in run.complete and tracks costs", async () => {
    const costTracker = new CostTracker();
    const agent = new Agent({ name: "decisions-stream", model: provider(), costTracker, register: false });
    const completed = vi.fn();
    agent.eventBus.on("run.complete", completed);
    const chunks = [];
    for await (const chunk of agent.stream("Charged twice", { questions })) chunks.push(chunk);
    expect(chunks.map((chunk) => chunk.type)).toEqual(["text", "finish"]);
    expect(chunks[1]).toMatchObject({ decisions: answers, usage: { pricingKey: "openai-decisions/gpt-6-luna" } });
    expect(completed).toHaveBeenCalledWith(
      expect.objectContaining({ output: expect.objectContaining({ decisions: answers }) }),
    );
    expect(costTracker.getSummary().totalCost).toBeCloseTo(0.00009);
  });

  it("bypasses semantic cache lookup and storage for decision agents", async () => {
    const agent = new Agent({ name: "cache-decision", model: provider(), register: false });
    const cache = { lookup: vi.fn(), store: vi.fn() };
    Reflect.set(agent, "semanticCache", cache);
    expect((await agent.run("Ticket")).decisions).toEqual(answers);
    for await (const _chunk of agent.stream("Ticket")) {
      /* consume */
    }
    expect(cache.lookup).not.toHaveBeenCalled();
    expect(cache.store).not.toHaveBeenCalled();
    expect(received).toHaveLength(2);
  });

  it("uses custom endpoint pricing without changing ordinary model costs", async () => {
    const costTracker = new CostTracker({
      pricing: { "openai-decisions/gpt-6-luna": { promptPer1k: 0.002, completionPer1k: 0, cachedPromptPer1k: 0 } },
    });
    await new Agent({ name: "custom-price", model: provider(), costTracker, register: false }).run("Ticket");
    expect(costTracker.getSummary().totalCost).toBeCloseTo(0.0018);
    costTracker.track({
      runId: "other",
      agentName: "chat",
      modelId: "gpt-6-luna",
      usage: { promptTokens: 1000, completionTokens: 0, totalTokens: 1000 },
    });
    expect(costTracker.getEntries()[1]?.cost).toBe(0);
  });

  it("forwards cancellation to the HTTP request", async () => {
    const controller = new AbortController();
    respond = () => controller.abort();
    await expect(provider().generate(input, { signal: controller.signal })).rejects.toThrow();
    expect(received).toHaveLength(1);
  });

  it("cancels before request dispatch", async () => {
    await expect(provider().generate(input, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(received).toHaveLength(0);
  });

  it("retains API error status and does not retry authentication failures", async () => {
    respond = (_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid key", type: "authentication_error" } }));
    };
    await expect(provider().generate(input)).rejects.toMatchObject({ status: 401 });
    expect(received).toHaveLength(1);
  });

  it("uses the Agent retry policy for rate limits", async () => {
    respond = (_req, res) => {
      if (received.length === 1) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Rate limit" } }));
      } else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result()));
      }
    };
    const output = await new Agent({
      name: "retry-decision",
      model: provider(),
      register: false,
      retry: { maxRetries: 1, initialDelayMs: 1 },
    }).run("Ticket");
    expect(output.decisions).toEqual(answers);
    expect(received).toHaveLength(2);
  });

  it.each([false, true])("rejects structuredOutput before dispatch (stream=%s)", async (stream) => {
    const agent = new Agent({
      name: "bad-schema",
      model: provider(),
      register: false,
      structuredOutput: z.object({ value: z.string() }),
    });
    const run = async () => {
      if (stream) {
        for await (const _chunk of agent.stream("Ticket")) {
          /* consume */
        }
      } else await agent.run("Ticket");
    };
    await expect(run()).rejects.toThrow(/structuredOutput/);
    expect(received).toHaveLength(0);
  });

  it.each<ModelConfig>([
    { questions: [] },
    { questions: { urgent: {} } },
    { temperature: 0 },
    { maxTokens: 10 },
    { reasoning: { enabled: true } },
  ])("rejects unsupported options %j before dispatch", async (options) => {
    await expect(provider().generate(input, options)).rejects.toThrow();
    expect(received).toHaveLength(0);
  });

  it("does not silently use defaults for an empty run question array", async () => {
    await expect(
      new Agent({ name: "empty-questions", model: provider(), register: false }).run("Ticket", { questions: [] }),
    ).rejects.toThrow(/questions/);
    expect(received).toHaveLength(0);
  });

  it("rejects tools and unsupported input before dispatch", async () => {
    await expect(
      provider().generate(input, { tools: [{ name: "refund", description: "Refund", parameters: {} }] }),
    ).rejects.toThrow(/tools/);
    for (const content of [
      [{ type: "image" as const, data: "https://example.com/image.png" }],
      [{ type: "audio" as const, data: "aGVsbG8=" }],
      [{ type: "file" as const, data: "aGVsbG8=", mimeType: "text/plain" }],
    ])
      await expect(provider().generate([{ role: "user", content }])).rejects.toThrow();
    await expect(provider().generate([{ role: "tool", content: "result" }])).rejects.toThrow(/tool/);
    expect(received).toHaveLength(0);
  });
});

describe("Decision boundary validation", () => {
  it("rejects duplicate names and choices while keeping boolean and string choices distinct", () => {
    expect(() => parseDecisionQuestions([questions[0], questions[0]])).toThrow(/Duplicate/);
    expect(() =>
      parseDecisionQuestions([{ type: "choice", instructions: "Pick", choices: [{ value: false }, { value: false }] }]),
    ).toThrow(/distinct/);
    expect(
      parseDecisionQuestions([
        { type: "choice", instructions: "Pick", choices: [{ value: false }, { value: "false" }] },
      ]),
    ).toHaveLength(1);
  });

  it.each([
    [],
    [{ ...answers[0], probability: 2 }, ...answers.slice(1)],
    [{ ...answers[0], name: "wrong" }, ...answers.slice(1)],
    [answers[0], { ...answers[1], choice: "unknown" }, ...answers.slice(2)],
    [...answers.slice(0, 2), { ...answers[2], score: 10 }, answers[3]],
    [
      ...answers.slice(0, 2),
      { ...answers[2], probabilities: [{ value: 0, label: "other", probability: 1 }] },
      answers[3],
    ],
  ])("rejects malformed or mismatched answers %#", (...invalid) => {
    expect(() => parseDecisionResponse(result(invalid), questions)).toThrow();
  });

  it("rejects OpenAI question arrays on the Jev provider", async () => {
    await expect(new JevProvider().generate(input, { questions })).rejects.toThrow(/named question map/);
  });
});
