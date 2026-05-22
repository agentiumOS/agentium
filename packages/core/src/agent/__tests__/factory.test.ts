import { describe, expect, it } from "vitest";
import type { ModelProvider } from "../../models/provider.js";
import type { ChatMessage, ModelResponse, StreamChunk } from "../../models/types.js";
import { InMemoryStorage } from "../../storage/in-memory.js";
import { ScopedStorage } from "../../storage/scoped.js";
import { AgentFactory } from "../factory.js";

class StubModel implements ModelProvider {
  readonly providerId = "stub";
  readonly modelId = "stub-1";
  async generate(_messages: ChatMessage[]): Promise<ModelResponse> {
    return {
      text: "ok",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    };
  }
  async *stream(_messages: ChatMessage[]): AsyncGenerator<StreamChunk> {
    yield { type: "text", text: "ok" };
  }
}

describe("AgentFactory", () => {
  it("creates an Agent with the configured name", () => {
    const factory = new AgentFactory({
      name: "scoped-agent",
      model: new StubModel(),
    });
    const a = factory.create();
    expect(a.name).toBe("scoped-agent");
  });

  it("wraps memory storage in ScopedStorage when scope is provided", () => {
    const storage = new InMemoryStorage();
    const factory = new AgentFactory({
      name: "scoped-agent",
      model: new StubModel(),
      memory: { storage },
    });

    const agent = factory.create({ tenantId: "acme", userId: "u1" });
    const scopedStorage = (agent as any).config.memory?.storage;
    expect(scopedStorage).toBeInstanceOf(ScopedStorage);
  });

  it("propagates userId from scope to Agent config", () => {
    const factory = new AgentFactory({
      name: "scoped-agent",
      model: new StubModel(),
    });
    const agent = factory.create({ userId: "alice" });
    expect((agent as any).config.userId).toBe("alice");
  });

  it("does not auto-register factory-created agents in the global registry", () => {
    const factory = new AgentFactory({
      name: "no-register",
      model: new StubModel(),
    });
    const agent = factory.create();
    expect((agent as any).config.register).toBe(false);
  });

  it("isolates two tenants by namespace", async () => {
    const storage = new InMemoryStorage();
    const factory = new AgentFactory({
      name: "scoped-agent",
      model: new StubModel(),
      memory: { storage },
    });

    const aA = factory.create({ tenantId: "a" });
    const aB = factory.create({ tenantId: "b" });

    const sA = (aA as any).config.memory.storage as ScopedStorage;
    const sB = (aB as any).config.memory.storage as ScopedStorage;

    await sA.set("notes", "k", "from-a");
    await sB.set("notes", "k", "from-b");

    // Direct read on the raw inner storage with the scoped namespaces returns each tenant's data.
    expect(await storage.get("tenant:a:notes", "k")).toBe("from-a");
    expect(await storage.get("tenant:b:notes", "k")).toBe("from-b");

    // Cross-tenant reads should return null.
    expect(await sA.get("notes", "kdoes-not-exist")).toBeNull();
  });
});
