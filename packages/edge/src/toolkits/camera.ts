import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDef } from "@agentium/core";
import { Toolkit } from "@agentium/core";
import { z } from "zod";

export interface CameraConfig {
  /** Default image width (default 1280). */
  width?: number;
  /** Default image height (default 720). */
  height?: number;
  /** Image rotation in degrees: 0, 90, 180, 270 (default 0). */
  rotation?: number;
  /** Output directory for captured images/videos (default /tmp/agentium-camera). */
  outputDir?: string;
  /** Output format: "jpg" | "png" (default "jpg"). */
  format?: "jpg" | "png";
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function hasCommand(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { encoding: "utf-8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * CameraToolkit — capture photos and video using `libcamera-still` / `libcamera-vid`.
 * Most reliable approach for Raspberry Pi 5 and Pi Camera Module 3.
 * Falls back to `raspistill` / `raspivid` if libcamera is not available.
 */
export class CameraToolkit extends Toolkit {
  readonly name = "camera";
  private width: number;
  private height: number;
  private rotation: number;
  private outputDir: string;
  private format: "jpg" | "png";
  private streamProcess: ReturnType<typeof spawn> | null = null;

  constructor(config: CameraConfig = {}) {
    super();
    this.width = config.width ?? 1280;
    this.height = config.height ?? 720;
    this.rotation = config.rotation ?? 0;
    this.outputDir = config.outputDir ?? "/tmp/agentium-camera";
    this.format = config.format ?? "jpg";
  }

  private getCaptureCommand(): string {
    if (hasCommand("libcamera-still")) return "libcamera-still";
    if (hasCommand("raspistill")) return "raspistill";
    throw new Error("No camera capture command found. Install libcamera-apps or raspistill.");
  }

  private getVideoCommand(): string {
    if (hasCommand("libcamera-vid")) return "libcamera-vid";
    if (hasCommand("raspivid")) return "raspivid";
    throw new Error("No video capture command found. Install libcamera-apps or raspivid.");
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "camera_capture",
        description:
          "Capture a photo from the Raspberry Pi camera. Returns the file path of the saved image, or base64-encoded image data.",
        parameters: z.object({
          output: z.enum(["file", "base64"]).optional().describe("Return file path or base64 data (default 'file')"),
          width: z.number().optional().describe("Image width override"),
          height: z.number().optional().describe("Image height override"),
        }),
        execute: async (args) => {
          const output = (args.output as string) ?? "file";
          const w = (args.width as number) ?? this.width;
          const h = (args.height as number) ?? this.height;

          ensureDir(this.outputDir);
          const filename = `capture_${Date.now()}.${this.format}`;
          const filepath = path.join(this.outputDir, filename);

          try {
            const cmd = this.getCaptureCommand();
            const encoding = this.format === "png" ? "png" : "jpg";
            const cmdArgs = [
              `-o`,
              filepath,
              `--width`,
              String(w),
              `--height`,
              String(h),
              `--rotation`,
              String(this.rotation),
              `-e`,
              encoding,
              `-n`, // no preview
              `-t`,
              `1`, // minimal timeout
            ];

            execFileSync(cmd, cmdArgs, {
              timeout: 15000,
              stdio: "pipe",
            });

            if (output === "base64") {
              const data = fs.readFileSync(filepath);
              const b64 = data.toString("base64");
              fs.unlinkSync(filepath);
              return JSON.stringify({
                format: this.format,
                width: w,
                height: h,
                base64_length: b64.length,
                data: `${b64.slice(0, 200)}...[truncated for LLM context]`,
              });
            }

            return JSON.stringify({ filepath, width: w, height: h, format: this.format });
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "camera_record",
        description: "Record a short video clip from the Pi camera. Returns the file path of the saved video.",
        parameters: z.object({
          duration_ms: z.number().min(500).max(60000).describe("Recording duration in milliseconds (max 60 seconds)"),
          width: z.number().optional().describe("Video width override"),
          height: z.number().optional().describe("Video height override"),
        }),
        execute: async (args) => {
          const duration = args.duration_ms as number;
          const w = (args.width as number) ?? this.width;
          const h = (args.height as number) ?? this.height;

          ensureDir(this.outputDir);
          const filename = `video_${Date.now()}.h264`;
          const filepath = path.join(this.outputDir, filename);

          try {
            const cmd = this.getVideoCommand();
            const cmdArgs = [
              `-o`,
              filepath,
              `--width`,
              String(w),
              `--height`,
              String(h),
              `--rotation`,
              String(this.rotation),
              `-t`,
              String(duration),
              `-n`,
            ];

            execFileSync(cmd, cmdArgs, {
              timeout: duration + 10000,
              stdio: "pipe",
            });

            const stat = fs.statSync(filepath);
            return JSON.stringify({
              filepath,
              duration_ms: duration,
              size_bytes: stat.size,
              width: w,
              height: h,
            });
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "camera_stream_url",
        description:
          "Start an MJPEG stream from the camera on a local HTTP port. Returns the stream URL. Call again to stop the existing stream first.",
        parameters: z.object({
          port: z.number().optional().describe("HTTP port for the MJPEG stream (default 8090)"),
        }),
        execute: async (args) => {
          const port = (args.port as number) ?? 8090;

          if (this.streamProcess) {
            this.streamProcess.kill();
            this.streamProcess = null;
          }

          try {
            const cmd = this.getVideoCommand();
            const child = spawn(
              cmd,
              [
                `--width`,
                String(this.width),
                `--height`,
                String(this.height),
                `--rotation`,
                String(this.rotation),
                `-t`,
                `0`, // run indefinitely
                `-n`,
                `--inline`,
                `-o`,
                `tcp://0.0.0.0:${port}`,
              ],
              { stdio: "pipe" },
            );

            this.streamProcess = child;

            await new Promise((resolve) => setTimeout(resolve, 2000));

            const url = `http://localhost:${port}`;
            return JSON.stringify({ url, status: "streaming", pid: child.pid });
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
    ];
  }

  dispose(): void {
    if (this.streamProcess) {
      this.streamProcess.kill();
      this.streamProcess = null;
    }
  }
}
