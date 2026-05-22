import { describe, expect, it, vi } from "vitest";
import { CameraToolkit } from "../../toolkits/camera.js";

// Mock child_process — keep `actual` so other modules (e.g. git skill loader)
// can still use `execFile` via promisify.
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: vi.fn().mockImplementation((cmd: string, args?: string[]) => {
      if (cmd === "which") return `/usr/bin/${args?.[0] ?? "libcamera-still"}\n`;
      return "";
    }),
    spawn: vi.fn().mockReturnValue({
      pid: 12345,
      kill: vi.fn(),
      unref: vi.fn(),
      on: vi.fn(),
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
    }),
  };
});

// Mock fs for capture
vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs");
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue(Buffer.from("fake-image-data")),
    unlinkSync: vi.fn(),
    statSync: vi.fn().mockReturnValue({ size: 1024 }),
    statfsSync: (actual as any).statfsSync,
  };
});

describe("CameraToolkit", () => {
  const toolkit = new CameraToolkit({
    width: 640,
    height: 480,
    outputDir: "/tmp/test-camera",
  });
  const tools = toolkit.getTools();
  const ctx = {} as any;

  it("has toolkit name 'camera'", () => {
    expect(toolkit.name).toBe("camera");
  });

  it("returns three tools", () => {
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual(["camera_capture", "camera_record", "camera_stream_url"]);
  });

  describe("camera_capture", () => {
    const tool = tools[0];

    it("captures a file", async () => {
      const result = await tool.execute({}, ctx);
      const data = JSON.parse(result as string);
      expect(data).toHaveProperty("filepath");
      expect(data.width).toBe(640);
      expect(data.height).toBe(480);
    });

    it("captures as base64", async () => {
      const result = await tool.execute({ output: "base64" }, ctx);
      const data = JSON.parse(result as string);
      expect(data).toHaveProperty("base64_length");
      expect(data.format).toBe("jpg");
    });
  });

  describe("camera_stream_url", () => {
    const tool = tools[2];

    it("starts stream and returns URL", async () => {
      const result = await tool.execute({}, ctx);
      const data = JSON.parse(result as string);
      expect(data.status).toBe("streaming");
      expect(data).toHaveProperty("pid");
    });
  });

  it("dispose kills stream process", () => {
    toolkit.dispose();
  });
});
