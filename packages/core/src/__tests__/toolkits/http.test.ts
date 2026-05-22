import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpToolkit } from "../../toolkits/http.js";

describe("HttpToolkit", () => {
  const ctx = {} as any;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns one tool named http_request", () => {
    const tk = new HttpToolkit();
    const tools = tk.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("http_request");
  });

  it("makes a GET request and formats response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ message: "hello" }),
    } as any);

    const tk = new HttpToolkit();
    const tool = tk.getTools()[0];
    const result = await tool.execute({ url: "https://api.example.com/test" }, ctx);

    expect(result).toContain("Status: 200 OK");
    expect(result).toContain('"message": "hello"');
  });

  it("prepends baseUrl to relative paths", async () => {
    let capturedUrl = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      capturedUrl = input.toString();
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({}),
        text: async () => "ok",
      } as any;
    });

    const tk = new HttpToolkit({ baseUrl: "https://api.example.com" });
    const tool = tk.getTools()[0];
    await tool.execute({ url: "/users" }, ctx);

    expect(capturedUrl).toBe("https://api.example.com/users");
  });

  it("truncates large responses", async () => {
    const bigBody = "x".repeat(1000);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({}),
      text: async () => bigBody,
    } as any);

    const tk = new HttpToolkit({ maxResponseSize: 50 });
    const tool = tk.getTools()[0];
    const result = await tool.execute({ url: "https://example.com" }, ctx);

    expect(result).toContain("truncated");
  });
});
