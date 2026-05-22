import { describe, expect, it } from "vitest";
import { CalculatorToolkit } from "../../toolkits/calculator.js";

describe("CalculatorToolkit", () => {
  const toolkit = new CalculatorToolkit();
  const tools = toolkit.getTools();
  const calculate = tools[0];
  const ctx = {} as any;

  it("returns one tool named calculate", () => {
    expect(tools).toHaveLength(1);
    expect(calculate.name).toBe("calculate");
  });

  it("evaluates basic arithmetic", async () => {
    const result = await calculate.execute({ expression: "2 + 3 * 4" }, ctx);
    expect(result).toBe("14");
  });

  it("evaluates parenthesized expressions", async () => {
    const result = await calculate.execute({ expression: "(2 + 3) * 4" }, ctx);
    expect(result).toBe("20");
  });

  it("evaluates math functions", async () => {
    const result = await calculate.execute({ expression: "sqrt(144)" }, ctx);
    expect(result).toBe("12");
  });

  it("uses PI constant", async () => {
    const result = await calculate.execute({ expression: "PI" }, ctx);
    expect(Number.parseFloat(result as string)).toBeCloseTo(Math.PI);
  });

  it("evaluates pow", async () => {
    const result = await calculate.execute({ expression: "pow(2, 10)" }, ctx);
    expect(result).toBe("1024");
  });

  it("rejects unknown identifiers", async () => {
    const result = await calculate.execute({ expression: "process.exit()" }, ctx);
    expect(result).toContain("Error");
  });

  it("respects precision config", async () => {
    const tk = new CalculatorToolkit({ precision: 3 });
    const tool = tk.getTools()[0];
    const result = await tool.execute({ expression: "1/3" }, ctx);
    expect(result).toBe("0.333");
  });

  it("handles division by zero", async () => {
    const result = await calculate.execute({ expression: "1/0" }, ctx);
    expect(result).toContain("Error");
  });
});
