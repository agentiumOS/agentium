import { beforeEach, describe, expect, it, vi } from "vitest";
import { SensorToolkit } from "../../toolkits/sensor.js";

const mockBus = {
  scanSync: vi.fn().mockReturnValue([0x76, 0x77, 0x3c]),
  readByteSync: vi.fn().mockReturnValue(0x60),
  readWordSync: vi.fn().mockReturnValue(0),
  readI2cBlockSync: vi.fn().mockImplementation((_addr: number, _cmd: number, length: number, buffer: Buffer) => {
    buffer.fill(0x20);
    return length;
  }),
  writeByteSync: vi.fn(),
  closeSync: vi.fn(),
};

vi.mock("i2c-bus", () => ({
  openSync: vi.fn().mockReturnValue(mockBus),
}));

describe("SensorToolkit", () => {
  const toolkit = new SensorToolkit({ busNumber: 1 });
  const tools = toolkit.getTools();
  const ctx = {} as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBus.scanSync.mockReturnValue([0x76, 0x77, 0x3c]);
  });

  it("has toolkit name 'sensor'", () => {
    expect(toolkit.name).toBe("sensor");
  });

  it("returns five tools", () => {
    expect(tools).toHaveLength(5);
    expect(tools.map((t) => t.name)).toEqual([
      "sensor_list",
      "sensor_read_temperature",
      "sensor_read_humidity",
      "sensor_read_pressure",
      "sensor_read_all",
    ]);
  });

  describe("sensor_list", () => {
    const tool = tools[0];

    it("scans I2C bus and returns device list", async () => {
      const result = await tool.execute({}, ctx);
      const data = JSON.parse(result as string);

      expect(data.bus).toBe(1);
      expect(data.count).toBe(3);
      expect(data.devices[0].address).toBe("0x76");
    });
  });

  describe("sensor_read_temperature", () => {
    const tool = tools[1];

    it("reads temperature from BME280", async () => {
      const result = await tool.execute({}, ctx);
      const data = JSON.parse(result as string);

      expect(data).toHaveProperty("temperature_c");
      expect(data.sensor).toBe("BME280");
      expect(typeof data.temperature_c).toBe("number");
    });
  });

  describe("sensor_read_all", () => {
    const tool = tools[4];

    it("reads all measurements", async () => {
      const result = await tool.execute({}, ctx);
      const data = JSON.parse(result as string);

      expect(data).toHaveProperty("temperature_c");
      expect(data).toHaveProperty("humidity_percent");
      expect(data).toHaveProperty("pressure_hpa");
      expect(data).toHaveProperty("timestamp");
    });
  });
});
