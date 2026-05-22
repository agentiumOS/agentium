import type { ToolDef } from "@agentium/core";
import { Toolkit } from "@agentium/core";
import { z } from "zod";

export interface BleConfig {
  /** Default scan timeout in ms (default 5000). */
  scanTimeout?: number;
  /** Filter scans to only these service UUIDs. */
  serviceUuidFilter?: string[];
}

interface NoblePeripheral {
  id: string;
  uuid: string;
  address: string;
  addressType: string;
  rssi: number;
  advertisement: {
    localName?: string;
    serviceUuids?: string[];
    manufacturerData?: Buffer;
  };
  connect(callback: (err?: Error) => void): void;
  disconnect(callback?: (err?: Error) => void): void;
  discoverAllServicesAndCharacteristics(
    callback: (err: Error | null, services: any[], characteristics: NobleCharacteristic[]) => void,
  ): void;
}

interface NobleCharacteristic {
  uuid: string;
  properties: string[];
  read(callback: (err: Error | null, data: Buffer) => void): void;
  write(data: Buffer, withoutResponse: boolean, callback: (err?: Error) => void): void;
  subscribe(callback: (err?: Error) => void): void;
  unsubscribe(callback: (err?: Error) => void): void;
  on(event: string, callback: (...args: any[]) => void): void;
}

interface Noble {
  on(event: string, callback: (...args: any[]) => void): void;
  startScanning(serviceUuids?: string[], allowDuplicates?: boolean): void;
  stopScanning(): void;
  state: string;
}

let nobleModule: Noble | null = null;

async function loadNoble(): Promise<Noble> {
  if (nobleModule) return nobleModule;
  try {
    const mod = await import("@stoprocent/noble");
    nobleModule = (mod.default ?? mod) as Noble;
    return nobleModule;
  } catch {
    throw new Error("@stoprocent/noble is not installed. Install it with: npm install @stoprocent/noble");
  }
}

/**
 * BleToolkit — Bluetooth Low Energy scanning and communication.
 * Requires `@stoprocent/noble` as an optional peer dependency.
 * Compatible with Raspberry Pi 5 and Pi 4.
 */
export class BleToolkit extends Toolkit {
  readonly name = "ble";
  private scanTimeout: number;
  private serviceFilter: string[];
  private connectedPeripherals: Map<string, NoblePeripheral> = new Map();

  constructor(config: BleConfig = {}) {
    super();
    this.scanTimeout = config.scanTimeout ?? 5000;
    this.serviceFilter = config.serviceUuidFilter ?? [];
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "ble_scan",
        description:
          "Scan for nearby Bluetooth Low Energy devices. Returns a list of discovered peripherals with name, address, RSSI, and services.",
        parameters: z.object({
          timeout_ms: z.number().optional().describe("Scan duration in ms (default 5000)"),
          service_uuids: z.array(z.string()).optional().describe("Filter by service UUIDs"),
        }),
        execute: async (args) => {
          const timeout = (args.timeout_ms as number) ?? this.scanTimeout;
          const uuids = (args.service_uuids as string[]) ?? this.serviceFilter;
          const noble = await loadNoble();

          return new Promise<string>((resolve) => {
            const devices: Array<{
              id: string;
              name: string | null;
              address: string;
              rssi: number;
              services: string[];
            }> = [];
            const seen = new Set<string>();

            const onDiscover = (peripheral: NoblePeripheral) => {
              if (seen.has(peripheral.id)) return;
              seen.add(peripheral.id);
              devices.push({
                id: peripheral.id,
                name: peripheral.advertisement.localName ?? null,
                address: peripheral.address,
                rssi: peripheral.rssi,
                services: peripheral.advertisement.serviceUuids ?? [],
              });
            };

            noble.on("discover", onDiscover);

            if (noble.state === "poweredOn") {
              noble.startScanning(uuids.length > 0 ? uuids : undefined, false);
            } else {
              noble.on("stateChange", (state: string) => {
                if (state === "poweredOn") {
                  noble.startScanning(uuids.length > 0 ? uuids : undefined, false);
                }
              });
            }

            setTimeout(() => {
              noble.stopScanning();
              resolve(JSON.stringify({ devices, count: devices.length, scan_ms: timeout }));
            }, timeout);
          });
        },
      },
      {
        name: "ble_connect",
        description: "Connect to a BLE peripheral by its ID (from ble_scan). Discovers services and characteristics.",
        parameters: z.object({
          device_id: z.string().describe("Peripheral ID from ble_scan"),
        }),
        execute: async (args) => {
          const deviceId = args.device_id as string;
          const noble = await loadNoble();

          return new Promise<string>((resolve) => {
            let targetPeripheral: NoblePeripheral | null = null;

            const onDiscover = (peripheral: NoblePeripheral) => {
              if (peripheral.id === deviceId) {
                noble.stopScanning();
                targetPeripheral = peripheral;

                peripheral.connect((err) => {
                  if (err) {
                    resolve(JSON.stringify({ error: `Connection failed: ${err.message}` }));
                    return;
                  }

                  peripheral.discoverAllServicesAndCharacteristics((_err, services, characteristics) => {
                    if (_err) {
                      resolve(JSON.stringify({ error: `Discovery failed: ${_err.message}` }));
                      return;
                    }
                    this.connectedPeripherals.set(deviceId, peripheral);
                    resolve(
                      JSON.stringify({
                        device_id: deviceId,
                        status: "connected",
                        services: services.map((s: any) => s.uuid),
                        characteristics: characteristics.map((c: any) => ({
                          uuid: c.uuid,
                          properties: c.properties,
                        })),
                      }),
                    );
                  });
                });
              }
            };

            noble.on("discover", onDiscover);
            noble.startScanning([], false);

            setTimeout(() => {
              if (!targetPeripheral) {
                noble.stopScanning();
                resolve(JSON.stringify({ error: `Device ${deviceId} not found` }));
              }
            }, 10000);
          });
        },
      },
      {
        name: "ble_read",
        description: "Read a characteristic value from a connected BLE device.",
        parameters: z.object({
          device_id: z.string().describe("Connected peripheral ID"),
          characteristic_uuid: z.string().describe("Characteristic UUID to read"),
        }),
        execute: async (args) => {
          const deviceId = args.device_id as string;
          const charUuid = args.characteristic_uuid as string;
          const peripheral = this.connectedPeripherals.get(deviceId);

          if (!peripheral) {
            return JSON.stringify({ error: `Device ${deviceId} is not connected. Use ble_connect first.` });
          }

          return new Promise<string>((resolve) => {
            peripheral.discoverAllServicesAndCharacteristics((_err, _services, characteristics) => {
              const char = characteristics.find((c) => c.uuid === charUuid);
              if (!char) {
                resolve(JSON.stringify({ error: `Characteristic ${charUuid} not found` }));
                return;
              }
              char.read((err, data) => {
                if (err) {
                  resolve(JSON.stringify({ error: err.message }));
                  return;
                }
                resolve(
                  JSON.stringify({
                    device_id: deviceId,
                    characteristic: charUuid,
                    value_hex: data.toString("hex"),
                    value_utf8: data.toString("utf-8"),
                    value_bytes: Array.from(data),
                  }),
                );
              });
            });
          });
        },
      },
      {
        name: "ble_write",
        description: "Write data to a characteristic on a connected BLE device.",
        parameters: z.object({
          device_id: z.string().describe("Connected peripheral ID"),
          characteristic_uuid: z.string().describe("Characteristic UUID to write"),
          value_hex: z.string().describe("Hex-encoded value to write (e.g. 'ff01')"),
          without_response: z.boolean().optional().describe("Write without response (default false)"),
        }),
        execute: async (args) => {
          const deviceId = args.device_id as string;
          const charUuid = args.characteristic_uuid as string;
          const valueHex = args.value_hex as string;
          const withoutResponse = (args.without_response as boolean) ?? false;
          const peripheral = this.connectedPeripherals.get(deviceId);

          if (!peripheral) {
            return JSON.stringify({ error: `Device ${deviceId} is not connected` });
          }

          const data = Buffer.from(valueHex, "hex");

          return new Promise<string>((resolve) => {
            peripheral.discoverAllServicesAndCharacteristics((_err, _services, characteristics) => {
              const char = characteristics.find((c) => c.uuid === charUuid);
              if (!char) {
                resolve(JSON.stringify({ error: `Characteristic ${charUuid} not found` }));
                return;
              }
              char.write(data, withoutResponse, (err) => {
                if (err) {
                  resolve(JSON.stringify({ error: err.message }));
                  return;
                }
                resolve(
                  JSON.stringify({
                    device_id: deviceId,
                    characteristic: charUuid,
                    bytes_written: data.length,
                    status: "ok",
                  }),
                );
              });
            });
          });
        },
      },
      {
        name: "ble_notify",
        description:
          "Subscribe to notifications on a BLE characteristic. Collects notifications for a specified duration.",
        parameters: z.object({
          device_id: z.string().describe("Connected peripheral ID"),
          characteristic_uuid: z.string().describe("Characteristic UUID"),
          duration_ms: z.number().optional().describe("How long to listen for notifications (default 5000)"),
        }),
        execute: async (args) => {
          const deviceId = args.device_id as string;
          const charUuid = args.characteristic_uuid as string;
          const duration = (args.duration_ms as number) ?? 5000;
          const peripheral = this.connectedPeripherals.get(deviceId);

          if (!peripheral) {
            return JSON.stringify({ error: `Device ${deviceId} is not connected` });
          }

          return new Promise<string>((resolve) => {
            const notifications: Array<{ time: number; value_hex: string }> = [];
            const start = Date.now();

            peripheral.discoverAllServicesAndCharacteristics((_err, _services, characteristics) => {
              const char = characteristics.find((c) => c.uuid === charUuid);
              if (!char) {
                resolve(JSON.stringify({ error: `Characteristic ${charUuid} not found` }));
                return;
              }

              char.on("data", (data: Buffer) => {
                notifications.push({
                  time: Date.now() - start,
                  value_hex: data.toString("hex"),
                });
              });

              char.subscribe((err) => {
                if (err) {
                  resolve(JSON.stringify({ error: err.message }));
                  return;
                }

                setTimeout(() => {
                  char.unsubscribe(() => {});
                  resolve(
                    JSON.stringify({
                      device_id: deviceId,
                      characteristic: charUuid,
                      notifications,
                      count: notifications.length,
                      duration_ms: duration,
                    }),
                  );
                }, duration);
              });
            });
          });
        },
      },
    ];
  }

  dispose(): void {
    for (const [id, peripheral] of this.connectedPeripherals) {
      try {
        peripheral.disconnect();
      } catch {
        /* ignore */
      }
      this.connectedPeripherals.delete(id);
    }
  }
}
