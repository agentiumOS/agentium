import { describe, expect, it, vi } from "vitest";
import { toolkitCatalog } from "../../toolkits/catalog.js";
import { JevToolkit } from "../../toolkits/jev.js";

const ctx = {} as any;

function mockSystemOne(answers: Record<string, unknown>) {
  return vi.fn(async () => ({ answers, model: "jev-1.13.0", usage: { input_tokens: 8, output_tokens: 0 } }));
}

describe("JevToolkit", () => {
  it("exposes choose, score, noul, and ask", () => {
    const tk = new JevToolkit();
    expect(tk.name).toBe("jev");
    expect(tk.getTools().map((t) => t.name)).toEqual(["jev_choose", "jev_score", "jev_noul", "jev_ask"]);
  });

  it("adds jev_evaluate when packs are configured", () => {
    const tk = new JevToolkit({
      packs: { moderation: { safe: { type: "noul", question: "Safe to send?" } } },
    });
    expect(tk.getTools().map((t) => t.name)).toContain("jev_evaluate");
  });

  it("jev_choose calls systemOne with a choice question", async () => {
    const tk = new JevToolkit();
    const systemOne = mockSystemOne({ choice: { type: "choice", choice: "billing", confidence: 0.9 } });
    tk.client = { systemOne };

    const choose = tk.getTools().find((t) => t.name === "jev_choose")!;
    const result = await choose.execute(
      { question: "What is this about?", options: ["billing", "tech"], state: "I was charged twice" },
      ctx,
    );

    expect(JSON.parse(result as string).choice.choice).toBe("billing");
    expect(systemOne).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "jev-latest",
        state: "I was charged twice",
        questions: { choice: expect.objectContaining({ type: "choice" }) },
      }),
    );
  });

  it("jev_score and jev_noul call systemOne", async () => {
    const tk = new JevToolkit({ model: "jev-1.13.0" });
    const systemOne = mockSystemOne({
      score: { type: "score", score: 1 },
      noul: { type: "noul", noul: 0.2 },
    });
    tk.client = { systemOne };

    const tools = Object.fromEntries(tk.getTools().map((t) => [t.name, t]));
    await tools.jev_score.execute({ question: "Severity?", levels: ["low", "high"], state: "meh" }, ctx);
    await tools.jev_noul.execute({ statement: "Is this urgent?", state: "meh" }, ctx);

    expect(systemOne).toHaveBeenCalledTimes(2);
    expect(systemOne.mock.calls[0][0].model).toBe("jev-1.13.0");
    expect(systemOne.mock.calls[0][0].questions.score).toEqual(expect.objectContaining({ type: "score" }));
    expect(systemOne.mock.calls[1][0].questions.noul).toEqual(expect.objectContaining({ type: "noul" }));
  });

  it("jev_ask batches JSON question specs", async () => {
    const tk = new JevToolkit();
    const systemOne = mockSystemOne({ urgent: { type: "noul", noul: 0.7 } });
    tk.client = { systemOne };

    const ask = tk.getTools().find((t) => t.name === "jev_ask")!;
    await ask.execute(
      {
        questions: JSON.stringify({
          urgent: { type: "noul", question: "Is this urgent?" },
          team: { type: "choice", question: "Which team?", options: ["billing", "tech"] },
        }),
        state: '{"ticket":"dup"}',
      },
      ctx,
    );

    const req = systemOne.mock.calls[0][0];
    expect(req.state).toEqual({ ticket: "dup" });
    expect(req.questions.urgent).toEqual(expect.objectContaining({ type: "noul" }));
    expect(req.questions.team).toEqual(expect.objectContaining({ type: "choice" }));
  });

  it("jev_evaluate runs a named pack", async () => {
    const tk = new JevToolkit({
      packs: {
        moderation: {
          safe: { type: "noul", question: "Is this safe to send?" },
        },
      },
    });
    const systemOne = mockSystemOne({ safe: { type: "noul", noul: 0.99 } });
    tk.client = { systemOne };

    const evaluate = tk.getTools().find((t) => t.name === "jev_evaluate")!;
    const result = await evaluate.execute({ pack: "moderation", state: "Thanks for your order" }, ctx);
    expect(JSON.parse(result as string).safe.noul).toBe(0.99);
    expect(await evaluate.execute({ pack: "nope", state: "x" }, ctx)).toContain("Unknown pack");
  });

  it("is registered in the toolkit catalog", () => {
    expect(toolkitCatalog.has("jev")).toBe(true);
    const meta = toolkitCatalog.get("jev");
    expect(meta?.name).toBe("Jev");
    expect(meta?.requiresCredentials).toBe(true);
    expect(meta?.configFields.some((f) => f.envVar === "TYPESAFE_API_KEY" && f.secret)).toBe(true);
  });
});
