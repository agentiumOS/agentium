import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLine = {
  requestInputMode: vi.fn(),
  requestOutputMode: vi.fn(),
  getValue: vi.fn().mockReturnValue(1),
  setValue: vi.fn(),
  release: vi.fn(),
};

vi.mock("node-libgpiod", () => {
  return {
    Chip: class MockChip {},
    Line: class MockLine {
      requestInputMode() {
        mockLine.requestInputMode();
      }
      requestOutputMode() {
        mockLine.requestOutputMode();
      }
      getValue() {
        return mockLine.getValue();
      }
      setValue(v: number) {
        mockLine.setValue(v);
      }
      release() {
        mockLine.release();
      }
    },
  };
});

import { GpioToolkit } from "../../toolkits/gpio.js";

describe("GpioToolkit", () => {
  const toolkit = new GpioToolkit({ chipNumber: 0, allowedPins: [17, 27, 22] });
  const tools = toolkit.getTools();
  const ctx = {} as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLine.getValue.mockReturnValue(1);
  });

  it("has toolkit name 'gpio'", () => {
    expect(toolkit.name).toBe("gpio");
  });

  it("returns four tools", () => {
    expect(tools).toHaveLength(4);
    expect(tools.map((t) => t.name)).toEqual(["gpio_read", "gpio_write", "gpio_watch", "gpio_pwm"]);
  });

  describe("gpio_read", () => {
    const tool = tools[0];

    it("reads pin value", async () => {
      const result = await tool.execute({ pin: 17 }, ctx);
      const data = JSON.parse(result as string);
      expect(data.pin).toBe(17);
      expect(data.value).toBe(1);
    });

    it("rejects disallowed pin", async () => {
      const result = await tool.execute({ pin: 99 }, ctx);
      const data = JSON.parse(result as string);
      expect(data.error).toContain("not in the allowlist");
    });
  });

  describe("gpio_write", () => {
    const tool = tools[1];

    it("sets pin HIGH", async () => {
      const result = await tool.execute({ pin: 27, value: 1 }, ctx);
      const data = JSON.parse(result as string);
      expect(data.status).toBe("ok");
      expect(data.pin).toBe(27);
      expect(data.value).toBe(1);
    });

    it("rejects disallowed pin", async () => {
      const result = await tool.execute({ pin: 99, value: 0 }, ctx);
      const data = JSON.parse(result as string);
      expect(data.error).toContain("not in the allowlist");
    });
  });

  describe("gpio_watch", () => {
    const tool = tools[2];

    it("returns with timeout status", async () => {
      const result = await tool.execute({ pin: 22, edge: "rising", timeout_ms: 200 }, ctx);
      const data = JSON.parse(result as string);
      expect(data.pin).toBe(22);
      expect(data.edge).toBe("rising");
      expect(["timeout", "completed"]).toContain(data.status);
    });
  });

  it("dispose clears watchers", () => {
    toolkit.dispose();
  });
});

describe("GpioToolkit with no allowlist", () => {
  const toolkit = new GpioToolkit({ chipNumber: 4 });
  const tools = toolkit.getTools();
  const ctx = {} as any;

  it("allows any pin when allowlist is empty", async () => {
    const result = await tools[0].execute({ pin: 99 }, ctx);
    const data = JSON.parse(result as string);
    expect(data.pin).toBe(99);
    expect(data.value).toBe(1);
  });
});
