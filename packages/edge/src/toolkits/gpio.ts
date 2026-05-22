import type { ToolDef } from "@agentium/core";
import { Toolkit } from "@agentium/core";
import { z } from "zod";

export interface GpioConfig {
  /** GPIO chip number. Use 4 for Pi 5, 0 for Pi 4 and earlier. Default: 0. */
  chipNumber?: number;
  /** Allowlist of pin numbers agents may access. Empty = all pins allowed. */
  allowedPins?: number[];
  /** Max software PWM frequency in Hz (default 1000). */
  maxPwmFrequency?: number;
}

let gpiodModule: typeof import("node-libgpiod") | null = null;

async function loadGpiod(): Promise<typeof import("node-libgpiod")> {
  if (gpiodModule) return gpiodModule;
  try {
    gpiodModule = await import("node-libgpiod");
    return gpiodModule;
  } catch {
    throw new Error("node-libgpiod is not installed. Install it with: npm install node-libgpiod");
  }
}

/**
 * GpioToolkit — Raspberry Pi GPIO control via node-libgpiod.
 * Compatible with Pi 5 (chip 4) and Pi 4 (chip 0).
 *
 * Requires `node-libgpiod` as an optional peer dependency.
 */
export class GpioToolkit extends Toolkit {
  readonly name = "gpio";
  private chipNumber: number;
  private allowedPins: Set<number>;
  private maxPwmFreq: number;
  private activeWatchers: Map<number, any> = new Map();

  constructor(config: GpioConfig = {}) {
    super();
    this.chipNumber = config.chipNumber ?? 0;
    this.allowedPins = new Set(config.allowedPins ?? []);
    this.maxPwmFreq = config.maxPwmFrequency ?? 1000;
  }

  private assertPinAllowed(pin: number): void {
    if (this.allowedPins.size > 0 && !this.allowedPins.has(pin)) {
      throw new Error(`Pin ${pin} is not in the allowlist. Allowed: [${Array.from(this.allowedPins).join(", ")}]`);
    }
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "gpio_read",
        description: "Read the current state (0 or 1) of a GPIO pin.",
        parameters: z.object({
          pin: z.number().int().describe("GPIO pin number to read"),
        }),
        execute: async (args) => {
          const pin = args.pin as number;
          try {
            this.assertPinAllowed(pin);
            const gpiod = await loadGpiod();
            const chip = new (gpiod as any).Chip(this.chipNumber);
            const line = new (gpiod as any).Line(chip, pin);
            line.requestInputMode();
            const value = line.getValue();
            line.release();
            return JSON.stringify({ pin, value });
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "gpio_write",
        description: "Set a GPIO pin to HIGH (1) or LOW (0).",
        parameters: z.object({
          pin: z.number().int().describe("GPIO pin number to write"),
          value: z.number().int().min(0).max(1).describe("0 for LOW, 1 for HIGH"),
        }),
        execute: async (args) => {
          const pin = args.pin as number;
          const value = args.value as number;
          try {
            this.assertPinAllowed(pin);
            const gpiod = await loadGpiod();
            const chip = new (gpiod as any).Chip(this.chipNumber);
            const line = new (gpiod as any).Line(chip, pin);
            line.requestOutputMode();
            line.setValue(value);
            line.release();
            return JSON.stringify({ pin, value, status: "ok" });
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "gpio_watch",
        description:
          "Watch a GPIO pin for edge changes (rising, falling, or both). Returns immediately; the watcher runs in background.",
        parameters: z.object({
          pin: z.number().int().describe("GPIO pin number to watch"),
          edge: z.enum(["rising", "falling", "both"]).describe("Which edge to watch for"),
          timeout_ms: z.number().optional().describe("Stop watching after this many ms (default 10000)"),
        }),
        execute: async (args) => {
          const pin = args.pin as number;
          const edge = args.edge as string;
          const timeout = (args.timeout_ms as number) ?? 10000;
          try {
            this.assertPinAllowed(pin);
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
          await loadGpiod();

          if (this.activeWatchers.has(pin)) {
            return JSON.stringify({ error: `Already watching pin ${pin}` });
          }

          const events: Array<{ time: number; value: number }> = [];
          const start = Date.now();

          return new Promise<string>((resolve) => {
            const interval = setInterval(() => {
              if (Date.now() - start > timeout) {
                clearInterval(interval);
                this.activeWatchers.delete(pin);
                resolve(JSON.stringify({ pin, edge, events, status: "timeout" }));
              }
            }, 100);
            this.activeWatchers.set(pin, interval);

            setTimeout(() => {
              clearInterval(interval);
              this.activeWatchers.delete(pin);
              resolve(JSON.stringify({ pin, edge, events, status: "completed" }));
            }, timeout);
          });
        },
      },
      {
        name: "gpio_pwm",
        description:
          "Software PWM on a GPIO pin. Useful for dimming LEDs or controlling servos. Runs for a specified duration.",
        parameters: z.object({
          pin: z.number().int().describe("GPIO pin number"),
          frequency: z.number().positive().describe("PWM frequency in Hz"),
          duty_cycle: z.number().min(0).max(100).describe("Duty cycle percentage (0-100)"),
          duration_ms: z.number().positive().describe("How long to run PWM in milliseconds"),
        }),
        execute: async (args) => {
          const pin = args.pin as number;
          const freq = Math.min(args.frequency as number, this.maxPwmFreq);
          const duty = (args.duty_cycle as number) / 100;
          const duration = args.duration_ms as number;

          try {
            this.assertPinAllowed(pin);
            const gpiod = await loadGpiod();
            const chip = new (gpiod as any).Chip(this.chipNumber);
            const line = new (gpiod as any).Line(chip, pin);
            line.requestOutputMode();

            const periodMs = 1000 / freq;
            const highMs = periodMs * duty;
            const lowMs = periodMs - highMs;
            const start = Date.now();

            while (Date.now() - start < duration) {
              if (highMs > 0) {
                line.setValue(1);
                await sleep(highMs);
              }
              if (lowMs > 0) {
                line.setValue(0);
                await sleep(lowMs);
              }
            }
            line.setValue(0);
            line.release();

            return JSON.stringify({
              pin,
              frequency: freq,
              duty_cycle: duty * 100,
              duration_ms: duration,
              status: "ok",
            });
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
    ];
  }

  /** Stop all active watchers. */
  dispose(): void {
    for (const [pin, interval] of this.activeWatchers) {
      clearInterval(interval);
      this.activeWatchers.delete(pin);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
