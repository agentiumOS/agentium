import { toolkitCatalog } from "@agentium/core";
import { BleToolkit } from "./toolkits/ble.js";
import { CameraToolkit } from "./toolkits/camera.js";
import { GpioToolkit } from "./toolkits/gpio.js";
import { SensorToolkit } from "./toolkits/sensor.js";
import { ServoToolkit } from "./toolkits/servo.js";
import { SystemToolkit } from "./toolkits/system.js";

/**
 * Register all edge/IoT toolkits in the global ToolkitCatalog.
 * Call this once at startup so they appear in the Admin UI.
 *
 * @example
 * ```ts
 * import { registerEdgeToolkits } from "@agentium/edge";
 * registerEdgeToolkits();
 * ```
 */
export function registerEdgeToolkits(): void {
  if (toolkitCatalog.has("system")) return; // already registered

  toolkitCatalog.register({
    id: "system",
    name: "System",
    description: "System info — CPU temp, memory, disk, network (zero dependencies)",
    category: "iot",
    requiresCredentials: false,
    configFields: [
      {
        name: "includeProcessDetails",
        label: "Include Process Details",
        type: "boolean",
        default: false,
        hint: "Include per-process info in process list (can be slow)",
      },
    ],
    factory: (c: Record<string, unknown>) => new SystemToolkit(c as any),
  });

  toolkitCatalog.register({
    id: "gpio",
    name: "GPIO",
    description: "Control Raspberry Pi GPIO pins — read, write, watch, PWM",
    category: "iot",
    requiresCredentials: false,
    configFields: [
      {
        name: "chipNumber",
        label: "GPIO Chip",
        type: "number",
        default: 0,
        hint: "Use 4 for Pi 5, 0 for Pi 4 and earlier",
      },
      {
        name: "allowedPins",
        label: "Allowed Pins",
        type: "string",
        hint: "Comma-separated pin numbers (empty = all allowed)",
      },
      {
        name: "maxPwmFrequency",
        label: "Max PWM Frequency (Hz)",
        type: "number",
        default: 1000,
      },
    ],
    factory: (c: Record<string, unknown>) => new GpioToolkit(c as any),
  });

  toolkitCatalog.register({
    id: "camera",
    name: "Camera",
    description: "Raspberry Pi camera capture/record via libcamera-still and libcamera-vid",
    category: "iot",
    requiresCredentials: false,
    configFields: [
      { name: "width", label: "Width", type: "number", default: 1280 },
      { name: "height", label: "Height", type: "number", default: 720 },
      {
        name: "rotation",
        label: "Rotation",
        type: "select",
        options: ["0", "90", "180", "270"],
        default: "0",
      },
      { name: "outputDir", label: "Output Directory", type: "string", default: "/tmp/agentium-camera" },
      { name: "format", label: "Format", type: "select", options: ["jpg", "png"], default: "jpg" },
    ],
    factory: (c: Record<string, unknown>) => new CameraToolkit(c as any),
  });

  toolkitCatalog.register({
    id: "sensor",
    name: "I2C Sensors",
    description: "Read I2C sensors (BME280, BMP180, DHT22) — temperature, humidity, pressure",
    category: "iot",
    requiresCredentials: false,
    configFields: [
      { name: "busNumber", label: "I2C Bus Number", type: "number", default: 1 },
      {
        name: "bme280Address",
        label: "BME280 Address",
        type: "number",
        default: 0x76,
        hint: "Hex address, default 0x76",
      },
    ],
    factory: (c: Record<string, unknown>) => new SensorToolkit(c as any),
  });

  toolkitCatalog.register({
    id: "ble",
    name: "Bluetooth BLE",
    description: "Bluetooth Low Energy — scan, connect, read/write characteristics, subscribe to notifications",
    category: "iot",
    requiresCredentials: false,
    configFields: [
      { name: "scanTimeout", label: "Scan Timeout (ms)", type: "number", default: 5000 },
      {
        name: "serviceUuidFilter",
        label: "Service UUID Filter",
        type: "string",
        hint: "Comma-separated service UUIDs to filter scans",
      },
    ],
    factory: (c: Record<string, unknown>) => new BleToolkit(c as any),
  });

  toolkitCatalog.register({
    id: "servo",
    name: "Servo",
    description: "Control hobby servos via GPIO PWM — set angle, sweep",
    category: "iot",
    requiresCredentials: false,
    configFields: [
      { name: "pin", label: "GPIO Pin", type: "number", required: true, hint: "Signal pin for the servo" },
      { name: "chipNumber", label: "GPIO Chip", type: "number", default: 0, hint: "Use 4 for Pi 5" },
      { name: "minPulseUs", label: "Min Pulse (µs)", type: "number", default: 500 },
      { name: "maxPulseUs", label: "Max Pulse (µs)", type: "number", default: 2500 },
      { name: "frequency", label: "PWM Frequency (Hz)", type: "number", default: 50 },
    ],
    factory: (c: Record<string, unknown>) => new ServoToolkit(c as any),
  });
}
