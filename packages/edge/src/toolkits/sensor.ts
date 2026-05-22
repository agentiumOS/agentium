import type { ToolDef } from "@agentium/core";
import { Toolkit } from "@agentium/core";
import { z } from "zod";

export interface SensorConfig {
  /** I2C bus number (default 1 — standard on all Pi models). */
  busNumber?: number;
  /** Override addresses for known sensor types. */
  addresses?: {
    bme280?: number;
    bmp180?: number;
  };
}

interface I2CBus {
  openSync(busNumber: number): I2CBusHandle;
}

interface I2CBusHandle {
  scanSync(): number[];
  readByteSync(addr: number, cmd: number): number;
  readWordSync(addr: number, cmd: number): number;
  readI2cBlockSync(addr: number, cmd: number, length: number, buffer: Buffer): number;
  writeByteSync(addr: number, cmd: number, byte: number): void;
  closeSync(): void;
}

let i2cModule: I2CBus | null = null;

async function loadI2C(): Promise<I2CBus> {
  if (i2cModule) return i2cModule;
  try {
    i2cModule = (await import("i2c-bus")) as unknown as I2CBus;
    return i2cModule;
  } catch {
    throw new Error("i2c-bus is not installed. Install it with: npm install i2c-bus");
  }
}

const BME280_ADDR = 0x76;
const _BME280_REG_CHIP_ID = 0xd0;
const BME280_REG_CTRL_MEAS = 0xf4;
const BME280_REG_CTRL_HUM = 0xf2;
const BME280_REG_DATA = 0xf7;
const BME280_REG_CALIB_T = 0x88;
const BME280_REG_CALIB_H = 0xa1;
const BME280_REG_CALIB_H2 = 0xe1;

function readBME280(bus: I2CBusHandle, addr: number): { temperature: number; humidity: number; pressure: number } {
  bus.writeByteSync(addr, BME280_REG_CTRL_HUM, 0x01); // oversampling x1
  bus.writeByteSync(addr, BME280_REG_CTRL_MEAS, 0x27); // temp x1, pressure x1, normal mode

  // Wait for measurement
  const buf = Buffer.alloc(26);
  bus.readI2cBlockSync(addr, BME280_REG_CALIB_T, 26, buf);

  const dig_T1 = buf.readUInt16LE(0);
  const dig_T2 = buf.readInt16LE(2);
  const dig_T3 = buf.readInt16LE(4);
  const dig_P1 = buf.readUInt16LE(6);
  const dig_P2 = buf.readInt16LE(8);
  const dig_P3 = buf.readInt16LE(10);
  const dig_P4 = buf.readInt16LE(12);
  const dig_P5 = buf.readInt16LE(14);
  const dig_P6 = buf.readInt16LE(16);
  const dig_P7 = buf.readInt16LE(18);
  const dig_P8 = buf.readInt16LE(20);
  const dig_P9 = buf.readInt16LE(22);

  const dig_H1 = bus.readByteSync(addr, BME280_REG_CALIB_H);
  const hBuf = Buffer.alloc(7);
  bus.readI2cBlockSync(addr, BME280_REG_CALIB_H2, 7, hBuf);
  const dig_H2 = hBuf.readInt16LE(0);
  const dig_H3 = hBuf[2];
  const dig_H4 = (hBuf[3] << 4) | (hBuf[4] & 0x0f);
  const dig_H5 = (hBuf[5] << 4) | (hBuf[4] >> 4);
  const dig_H6 = hBuf.readInt8(6);

  const dataBuf = Buffer.alloc(8);
  bus.readI2cBlockSync(addr, BME280_REG_DATA, 8, dataBuf);

  const adc_P = (dataBuf[0] << 12) | (dataBuf[1] << 4) | (dataBuf[2] >> 4);
  const adc_T = (dataBuf[3] << 12) | (dataBuf[4] << 4) | (dataBuf[5] >> 4);
  const adc_H = (dataBuf[6] << 8) | dataBuf[7];

  // Temperature compensation
  let var1 = (adc_T / 16384.0 - dig_T1 / 1024.0) * dig_T2;
  let var2 = (adc_T / 131072.0 - dig_T1 / 8192.0) ** 2 * dig_T3;
  const t_fine = var1 + var2;
  const temperature = Math.round((t_fine / 5120.0) * 100) / 100;

  // Pressure compensation
  var1 = t_fine / 2.0 - 64000.0;
  var2 = (var1 * var1 * dig_P6) / 32768.0;
  var2 = var2 + var1 * dig_P5 * 2.0;
  var2 = var2 / 4.0 + dig_P4 * 65536.0;
  var1 = ((dig_P3 * var1 * var1) / 524288.0 + dig_P2 * var1) / 524288.0;
  var1 = (1.0 + var1 / 32768.0) * dig_P1;
  let pressure = 0;
  if (var1 !== 0) {
    pressure = 1048576.0 - adc_P;
    pressure = ((pressure - var2 / 4096.0) * 6250.0) / var1;
    var1 = (dig_P9 * pressure * pressure) / 2147483648.0;
    var2 = (pressure * dig_P8) / 32768.0;
    pressure = Math.round((pressure + (var1 + var2 + dig_P7) / 16.0) * 100) / 10000; // hPa
  }

  // Humidity compensation
  let hum = t_fine - 76800.0;
  hum =
    (adc_H - (dig_H4 * 64.0 + (dig_H5 / 16384.0) * hum)) *
    ((dig_H2 / 65536.0) * (1.0 + (dig_H6 / 67108864.0) * hum * (1.0 + (dig_H3 / 67108864.0) * hum)));
  hum = hum * (1.0 - (dig_H1 * hum) / 524288.0);
  const humidity = Math.round(Math.max(0, Math.min(100, hum)) * 100) / 100;

  return { temperature, humidity, pressure };
}

/**
 * SensorToolkit — read I2C sensors (BME280, BMP180, DHT22) on Raspberry Pi.
 * Requires `i2c-bus` as an optional peer dependency.
 */
export class SensorToolkit extends Toolkit {
  readonly name = "sensor";
  private busNumber: number;
  private bme280Addr: number;

  constructor(config: SensorConfig = {}) {
    super();
    this.busNumber = config.busNumber ?? 1;
    this.bme280Addr = config.addresses?.bme280 ?? BME280_ADDR;
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "sensor_list",
        description: "Scan the I2C bus and list all detected device addresses.",
        parameters: z.object({}),
        execute: async () => {
          const i2c = await loadI2C();
          try {
            const bus = i2c.openSync(this.busNumber);
            const devices = bus.scanSync();
            bus.closeSync();
            return JSON.stringify({
              bus: this.busNumber,
              devices: devices.map((d: number) => ({
                address: `0x${d.toString(16).padStart(2, "0")}`,
                decimal: d,
              })),
              count: devices.length,
            });
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "sensor_read_temperature",
        description: "Read temperature from a BME280 sensor in Celsius.",
        parameters: z.object({
          address: z.number().optional().describe("I2C address override (default 0x76)"),
        }),
        execute: async (args) => {
          const addr = (args.address as number) ?? this.bme280Addr;
          const i2c = await loadI2C();
          try {
            const bus = i2c.openSync(this.busNumber);
            const { temperature } = readBME280(bus, addr);
            bus.closeSync();
            return JSON.stringify({ temperature_c: temperature, sensor: "BME280" });
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "sensor_read_humidity",
        description: "Read relative humidity from a BME280 sensor as a percentage.",
        parameters: z.object({
          address: z.number().optional().describe("I2C address override (default 0x76)"),
        }),
        execute: async (args) => {
          const addr = (args.address as number) ?? this.bme280Addr;
          const i2c = await loadI2C();
          try {
            const bus = i2c.openSync(this.busNumber);
            const { humidity } = readBME280(bus, addr);
            bus.closeSync();
            return JSON.stringify({ humidity_percent: humidity, sensor: "BME280" });
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "sensor_read_pressure",
        description: "Read barometric pressure from a BME280 sensor in hPa.",
        parameters: z.object({
          address: z.number().optional().describe("I2C address override (default 0x76)"),
        }),
        execute: async (args) => {
          const addr = (args.address as number) ?? this.bme280Addr;
          const i2c = await loadI2C();
          try {
            const bus = i2c.openSync(this.busNumber);
            const { pressure } = readBME280(bus, addr);
            bus.closeSync();
            return JSON.stringify({ pressure_hpa: pressure, sensor: "BME280" });
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "sensor_read_all",
        description: "Read all measurements (temperature, humidity, pressure) from a BME280 sensor.",
        parameters: z.object({
          address: z.number().optional().describe("I2C address override (default 0x76)"),
        }),
        execute: async (args) => {
          const addr = (args.address as number) ?? this.bme280Addr;
          const i2c = await loadI2C();
          try {
            const bus = i2c.openSync(this.busNumber);
            const data = readBME280(bus, addr);
            bus.closeSync();
            return JSON.stringify({
              temperature_c: data.temperature,
              humidity_percent: data.humidity,
              pressure_hpa: data.pressure,
              sensor: "BME280",
              timestamp: new Date().toISOString(),
            });
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
    ];
  }
}
