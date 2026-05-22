import { createRequire } from "node:module";
import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

const _require = createRequire(import.meta.url);

export interface ImageGenerationConfig {
  /** OpenAI API key. Falls back to OPENAI_API_KEY env var. */
  apiKey?: string;
  /** Default model (default: "dall-e-3"). */
  model?: string;
  /** Default image size (default: "1024x1024"). */
  size?: "256x256" | "512x512" | "1024x1024" | "1792x1024" | "1024x1792";
  /** Default quality (default: "standard"). */
  quality?: "standard" | "hd";
}

/**
 * Image Generation Toolkit — generate and edit images via OpenAI DALL-E API.
 *
 * Reuses the `openai` peer dependency (already present in the project).
 *
 * @example
 * ```ts
 * const imgGen = new ImageGenerationToolkit({ apiKey: process.env.OPENAI_API_KEY });
 * const agent = new Agent({ tools: [...imgGen.getTools()] });
 * ```
 */
export class ImageGenerationToolkit extends Toolkit {
  readonly name = "image_generation";
  private apiKey: string;
  private model: string;
  private size: string;
  private quality: string;
  private openaiClient: any;

  constructor(config: ImageGenerationConfig = {}) {
    super();
    this.apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.model = config.model ?? "dall-e-3";
    this.size = config.size ?? "1024x1024";
    this.quality = config.quality ?? "standard";
    if (!this.apiKey) throw new Error("OpenAI API key is required. Set apiKey or OPENAI_API_KEY env var.");
  }

  private getOpenAI(): any {
    if (this.openaiClient) return this.openaiClient;
    const OpenAI = _require("openai");
    this.openaiClient = new OpenAI({ apiKey: this.apiKey });
    return this.openaiClient;
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "image_generate",
        description: "Generate an image from a text prompt using DALL-E.",
        parameters: z.object({
          prompt: z.string().describe("Text description of the image to generate"),
          size: z
            .enum(["256x256", "512x512", "1024x1024", "1792x1024", "1024x1792"])
            .optional()
            .describe("Image size (default 1024x1024)"),
          quality: z.enum(["standard", "hd"]).optional().describe("Quality (default standard, hd for DALL-E 3)"),
          n: z.number().optional().describe("Number of images to generate (default 1)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const openai = this.getOpenAI();
            const response = await openai.images.generate({
              model: this.model,
              prompt: args.prompt as string,
              n: (args.n as number) ?? 1,
              size: (args.size as string) ?? this.size,
              quality: (args.quality as string) ?? this.quality,
              response_format: "url",
            });
            const images = response.data.map((img: any, i: number) => ({
              index: i,
              url: img.url,
              revisedPrompt: img.revised_prompt,
            }));
            return JSON.stringify(images, null, 2);
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "image_edit",
        description:
          "Edit an image with a text prompt (inpainting). Provide the original image URL and a prompt describing the edit.",
        parameters: z.object({
          imageUrl: z.string().describe("URL of the original image"),
          prompt: z.string().describe("Description of the edit to apply"),
          size: z.enum(["256x256", "512x512", "1024x1024"]).optional().describe("Output size (default 1024x1024)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const openai = this.getOpenAI();
            const imageRes = await fetch(args.imageUrl as string);
            if (!imageRes.ok) throw new Error(`Failed to fetch image: ${imageRes.status}`);
            const imageBuffer = Buffer.from(await imageRes.arrayBuffer());
            const imageFile = new File([imageBuffer], "image.png", { type: "image/png" });

            const response = await openai.images.edit({
              image: imageFile,
              prompt: args.prompt as string,
              n: 1,
              size: (args.size as string) ?? "1024x1024",
            });
            const images = response.data.map((img: any, i: number) => ({
              index: i,
              url: img.url,
            }));
            return JSON.stringify(images, null, 2);
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
    ];
  }
}
