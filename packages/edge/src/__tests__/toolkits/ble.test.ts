import { beforeEach, describe, expect, it, vi } from "vitest";
import { BleToolkit } from "../../toolkits/ble.js";

const mockPeripheral = {
  id: "abc123",
  uuid: "abc123",
  address: "AA:BB:CC:DD:EE:FF",
  addressType: "random",
  rssi: -55,
  advertisement: {
    localName: "TestDevice",
    serviceUuids: ["180f"],
  },
  connect: vi.fn((cb: Function) => cb()),
  disconnect: vi.fn((cb?: Function) => cb?.()),
  discoverAllServicesAndCharacteristics: vi.fn((cb: Function) =>
    cb(
      null,
      [{ uuid: "180f" }],
      [
        {
          uuid: "2a19",
          properties: ["read", "notify"],
          read: vi.fn((cb: Function) => cb(null, Buffer.from([0x64]))),
          write: vi.fn((_data: Buffer, _wo: boolean, cb: Function) => cb()),
          subscribe: vi.fn((cb: Function) => cb()),
          unsubscribe: vi.fn((cb: Function) => cb()),
          on: vi.fn(),
        },
      ],
    ),
  ),
};

let discoverCallback: Function | null = null;
let _stateChangeCallback: Function | null = null;

const mockNoble = {
  state: "poweredOn",
  on: vi.fn((event: string, cb: Function) => {
    if (event === "discover") discoverCallback = cb;
    if (event === "stateChange") _stateChangeCallback = cb;
  }),
  startScanning: vi.fn(() => {
    if (discoverCallback) {
      setTimeout(() => discoverCallback!(mockPeripheral), 50);
    }
  }),
  stopScanning: vi.fn(),
};

vi.mock("@stoprocent/noble", () => ({
  default: mockNoble,
}));

describe("BleToolkit", () => {
  const toolkit = new BleToolkit({ scanTimeout: 500 });
  const tools = toolkit.getTools();
  const ctx = {} as any;

  beforeEach(() => {
    vi.clearAllMocks();
    discoverCallback = null;
    _stateChangeCallback = null;
  });

  it("has toolkit name 'ble'", () => {
    expect(toolkit.name).toBe("ble");
  });

  it("returns five tools", () => {
    expect(tools).toHaveLength(5);
    expect(tools.map((t) => t.name)).toEqual(["ble_scan", "ble_connect", "ble_read", "ble_write", "ble_notify"]);
  });

  describe("ble_scan", () => {
    const tool = tools[0];

    it("discovers nearby devices", async () => {
      const result = await tool.execute({ timeout_ms: 200 }, ctx);
      const data = JSON.parse(result as string);

      expect(data).toHaveProperty("devices");
      expect(data).toHaveProperty("count");
      expect(data.scan_ms).toBe(200);
    });
  });

  describe("ble_read", () => {
    const tool = tools[2];

    it("returns error when device not connected", async () => {
      const result = await tool.execute({ device_id: "unknown", characteristic_uuid: "2a19" }, ctx);
      const data = JSON.parse(result as string);
      expect(data.error).toContain("not connected");
    });
  });

  it("dispose disconnects peripherals", () => {
    toolkit.dispose();
  });
});
