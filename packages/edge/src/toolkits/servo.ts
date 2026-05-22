import type { ToolDef } from "@agentium/core";
import { Toolkit } from "@agentium/core";
import { z } from "zod";

export interface ServoConfig {
  /** GPIO pin number for the servo signal. */
  pin: number;
  /** GPIO chip number (default 0, use 4 for Pi 5). */
  chipNumber?: number;
  /** Minimum pulse width in microseconds (default 500). */
  minPulseUs?: number;
  /** Maximum pulse width in microseconds (default 2500). */
  maxPulseUs?: number;
  /** PWM frequency in Hz (default 50 — standard for servos). */
  frequency?: number;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function angleToPulseUs(angle: number, minUs: number, maxUs: number): number {
  return minUs + (angle / 180) * (maxUs - minUs);
}

/**
 * ServoToolkit — control hobby servos via GPIO PWM on Raspberry Pi.
 * Requires `node-libgpiod` as an optional peer dependency.
 */
export class ServoToolkit extends Toolkit {
  readonly name = "servo";
  private pin: number;
  private chipNumber: number;
  private minPulseUs: number;
  private maxPulseUs: number;
  private frequency: number;

  constructor(config: ServoConfig) {
    super();
    this.pin = config.pin;
    this.chipNumber = config.chipNumber ?? 0;
    this.minPulseUs = config.minPulseUs ?? 500;
    this.maxPulseUs = config.maxPulseUs ?? 2500;
    this.frequency = config.frequency ?? 50;
  }

  private async pulseForDuration(angle: number, durationMs: number): Promise<void> {
    const gpiod = await loadGpiod();
    const chip = new (gpiod as any).Chip(this.chipNumber);
    const line = new (gpiod as any).Line(chip, this.pin);
    line.requestOutputMode();

    const periodUs = 1_000_000 / this.frequency;
    const pulseUs = angleToPulseUs(angle, this.minPulseUs, this.maxPulseUs);
    const periodMs = periodUs / 1000;
    const pulseMs = pulseUs / 1000;
    const start = Date.now();

    while (Date.now() - start < durationMs) {
      line.setValue(1);
      await sleep(pulseMs);
      line.setValue(0);
      await sleep(periodMs - pulseMs);
    }

    line.setValue(0);
    line.release();
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "servo_set_angle",
        description: "Move the servo to a specific angle (0-180 degrees). Holds position for a configurable duration.",
        parameters: z.object({
          angle: z.number().min(0).max(180).describe("Target angle in degrees (0-180)"),
          hold_ms: z.number().optional().describe("How long to hold position in ms (default 1000)"),
        }),
        execute: async (args) => {
          const angle = args.angle as number;
          const holdMs = (args.hold_ms as number) ?? 1000;

          try {
            await this.pulseForDuration(angle, holdMs);
            return JSON.stringify({
              pin: this.pin,
              angle,
              hold_ms: holdMs,
              pulse_us: angleToPulseUs(angle, this.minPulseUs, this.maxPulseUs),
              status: "ok",
            });
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "servo_sweep",
        description: "Sweep the servo between two angles. Useful for scanning or demonstration purposes.",
        parameters: z.object({
          from_angle: z.number().min(0).max(180).describe("Starting angle"),
          to_angle: z.number().min(0).max(180).describe("Ending angle"),
          step: z.number().min(1).max(90).optional().describe("Degrees per step (default 5)"),
          step_delay_ms: z.number().optional().describe("Delay between steps in ms (default 50)"),
        }),
        execute: async (args) => {
          const from = args.from_angle as number;
          const to = args.to_angle as number;
          const step = (args.step as number) ?? 5;
          const stepDelay = (args.step_delay_ms as number) ?? 50;

          try {
            const direction = from < to ? 1 : -1;
            let current = from;
            let steps = 0;

            while ((direction > 0 && current <= to) || (direction < 0 && current >= to)) {
              await this.pulseForDuration(current, stepDelay);
              current += step * direction;
              steps++;
            }

            // Ensure we hit the final angle
            if (current !== to + step * direction) {
              await this.pulseForDuration(to, stepDelay);
            }

            return JSON.stringify({
              pin: this.pin,
              from_angle: from,
              to_angle: to,
              steps,
              total_ms: steps * stepDelay,
              status: "ok",
            });
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
    ];
  }
}
