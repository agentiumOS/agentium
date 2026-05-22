import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLine = {
  requestOutputMode: vi.fn(),
  setValue: vi.fn(),
  release: vi.fn(),
};

vi.mock("node-libgpiod", () => {
  return {
    Chip: class MockChip {},
    Line: class MockLine {
      requestOutputMode() {
        mockLine.requestOutputMode();
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

import { ServoToolkit } from "../../toolkits/servo.js";

describe("ServoToolkit", () => {
  const toolkit = new ServoToolkit({ pin: 18, chipNumber: 0 });
  const tools = toolkit.getTools();
  const ctx = {} as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has toolkit name 'servo'", () => {
    expect(toolkit.name).toBe("servo");
  });

  it("returns two tools", () => {
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toEqual(["servo_set_angle", "servo_sweep"]);
  });

  describe("servo_set_angle", () => {
    const tool = tools[0];

    it("sets angle and returns status", async () => {
      const result = await tool.execute({ angle: 90, hold_ms: 30 }, ctx);
      const data = JSON.parse(result as string);

      expect(data.status).toBe("ok");
      expect(data.pin).toBe(18);
      expect(data.angle).toBe(90);
      expect(data).toHaveProperty("pulse_us");
      expect(mockLine.requestOutputMode).toHaveBeenCalled();
      expect(mockLine.setValue).toHaveBeenCalled();
      expect(mockLine.release).toHaveBeenCalled();
    });
  });

  describe("servo_sweep", () => {
    const tool = tools[1];

    it("sweeps between angles", async () => {
      const result = await tool.execute({ from_angle: 0, to_angle: 20, step: 10, step_delay_ms: 10 }, ctx);
      const data = JSON.parse(result as string);

      expect(data.status).toBe("ok");
      expect(data.pin).toBe(18);
      expect(data.from_angle).toBe(0);
      expect(data.to_angle).toBe(20);
      expect(data.steps).toBeGreaterThan(0);
    });
  });
});
