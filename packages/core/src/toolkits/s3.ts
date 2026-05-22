import { createRequire } from "node:module";
import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

const _require = createRequire(import.meta.url);

export interface S3Config {
  /** S3 bucket name. Falls back to S3_BUCKET env var. */
  bucket?: string;
  /** AWS region (default: us-east-1). Falls back to AWS_REGION env var. */
  region?: string;
  /** Custom endpoint URL for S3-compatible services (MinIO, R2, GCS). */
  endpoint?: string;
  /** Force path-style addressing (needed for MinIO). */
  forcePathStyle?: boolean;
  /** AWS Access Key ID. Falls back to AWS_ACCESS_KEY_ID env var. */
  accessKeyId?: string;
  /** AWS Secret Access Key. Falls back to AWS_SECRET_ACCESS_KEY env var. */
  secretAccessKey?: string;
}

/**
 * S3 Cloud Storage Toolkit — upload, download, list, delete, and presign URLs.
 *
 * Works with AWS S3, MinIO, Cloudflare R2, and any S3-compatible storage.
 * Requires the `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` peer dependencies.
 *
 * @example
 * ```ts
 * const s3 = new S3Toolkit({ bucket: "my-bucket", region: "us-east-1" });
 * const agent = new Agent({ tools: [...s3.getTools()] });
 * ```
 */
export class S3Toolkit extends Toolkit {
  readonly name = "s3";
  private bucket: string;
  private region: string;
  private endpoint?: string;
  private forcePathStyle: boolean;
  private accessKeyId?: string;
  private secretAccessKey?: string;
  private client: any;

  constructor(config: S3Config = {}) {
    super();
    this.bucket = config.bucket ?? process.env.S3_BUCKET ?? "";
    this.region = config.region ?? process.env.AWS_REGION ?? "us-east-1";
    this.endpoint = config.endpoint;
    this.forcePathStyle = config.forcePathStyle ?? false;
    this.accessKeyId = config.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID;
    this.secretAccessKey = config.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY;
  }

  private getClient(): any {
    if (this.client) return this.client;
    const { S3Client } = _require("@aws-sdk/client-s3");
    const opts: any = { region: this.region };
    if (this.endpoint) opts.endpoint = this.endpoint;
    if (this.forcePathStyle) opts.forcePathStyle = true;
    if (this.accessKeyId && this.secretAccessKey) {
      opts.credentials = { accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey };
    }
    this.client = new S3Client(opts);
    return this.client;
  }

  private resolveBucket(args: Record<string, unknown>): string {
    return (
      (args.bucket as string) ||
      this.bucket ||
      (() => {
        throw new Error("bucket is required");
      })()
    );
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "s3_upload",
        description: "Upload content to an S3 bucket.",
        parameters: z.object({
          key: z.string().describe("Object key (path in bucket)"),
          body: z.string().describe("Content to upload (text or base64)"),
          contentType: z.string().optional().describe("MIME type (default: application/octet-stream)"),
          bucket: z.string().optional().describe("Bucket name (uses default if omitted)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const { PutObjectCommand } = _require("@aws-sdk/client-s3");
            const client = this.getClient();
            await client.send(
              new PutObjectCommand({
                Bucket: this.resolveBucket(args),
                Key: args.key as string,
                Body: args.body as string,
                ContentType: (args.contentType as string) ?? "application/octet-stream",
              }),
            );
            return JSON.stringify({ status: "uploaded", key: args.key });
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "s3_download",
        description: "Download an object from S3 and return its text content.",
        parameters: z.object({
          key: z.string().describe("Object key (path in bucket)"),
          bucket: z.string().optional().describe("Bucket name (uses default if omitted)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const { GetObjectCommand } = _require("@aws-sdk/client-s3");
            const client = this.getClient();
            const res = await client.send(
              new GetObjectCommand({
                Bucket: this.resolveBucket(args),
                Key: args.key as string,
              }),
            );
            const body = await res.Body?.transformToString();
            return body ?? "(empty)";
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "s3_list",
        description: "List objects in an S3 bucket.",
        parameters: z.object({
          prefix: z.string().optional().describe("Key prefix filter"),
          maxKeys: z.number().optional().describe("Max objects to return (default 50)"),
          bucket: z.string().optional().describe("Bucket name (uses default if omitted)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const { ListObjectsV2Command } = _require("@aws-sdk/client-s3");
            const client = this.getClient();
            const res = await client.send(
              new ListObjectsV2Command({
                Bucket: this.resolveBucket(args),
                Prefix: args.prefix as string,
                MaxKeys: (args.maxKeys as number) ?? 50,
              }),
            );
            const objects = (res.Contents ?? []).map((o: any) => ({
              key: o.Key,
              size: o.Size,
              lastModified: o.LastModified?.toISOString(),
            }));
            if (objects.length === 0) return "(no objects found)";
            return JSON.stringify(objects, null, 2);
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "s3_delete",
        description: "Delete an object from S3.",
        parameters: z.object({
          key: z.string().describe("Object key to delete"),
          bucket: z.string().optional().describe("Bucket name (uses default if omitted)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const { DeleteObjectCommand } = _require("@aws-sdk/client-s3");
            const client = this.getClient();
            await client.send(
              new DeleteObjectCommand({
                Bucket: this.resolveBucket(args),
                Key: args.key as string,
              }),
            );
            return JSON.stringify({ status: "deleted", key: args.key });
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "s3_presign_url",
        description: "Generate a pre-signed URL for temporary access to an S3 object.",
        parameters: z.object({
          key: z.string().describe("Object key"),
          expiresIn: z.number().optional().describe("URL expiration in seconds (default 3600)"),
          bucket: z.string().optional().describe("Bucket name (uses default if omitted)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const { GetObjectCommand } = _require("@aws-sdk/client-s3");
            const { getSignedUrl } = _require("@aws-sdk/s3-request-presigner");
            const client = this.getClient();
            const command = new GetObjectCommand({
              Bucket: this.resolveBucket(args),
              Key: args.key as string,
            });
            const url = await getSignedUrl(client, command, {
              expiresIn: (args.expiresIn as number) ?? 3600,
            });
            return url;
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
    ];
  }
}
