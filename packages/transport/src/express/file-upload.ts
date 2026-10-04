import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

const MIME_TO_PART_TYPE: Record<string, "image" | "audio" | "file"> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/jpg": "image",
  "image/gif": "image",
  "image/webp": "image",
  "audio/mpeg": "audio",
  "audio/mp3": "audio",
  "audio/wav": "audio",
  "audio/ogg": "audio",
  "audio/webm": "audio",
  "audio/flac": "audio",
  "audio/aac": "audio",
  "audio/mp4": "audio",
};

function getPartType(mimeType: string): "image" | "audio" | "file" {
  return MIME_TO_PART_TYPE[mimeType] ?? "file";
}

export interface FileUploadOptions {
  maxFileSize?: number;
  maxFiles?: number;
  maxFields?: number;
  maxFieldSize?: number;
  allowedMimeTypes?: string[];
}

export function createFileUploadMiddleware(opts: FileUploadOptions = {}) {
  const limits = {
    fileSize: opts.maxFileSize ?? 50 * 1024 * 1024,
    files: opts.maxFiles ?? 10,
    fields: opts.maxFields ?? 32,
    fieldSize: opts.maxFieldSize ?? 64 * 1024,
  };
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid upload limit");
  let multer: any;
  try {
    multer = _require("multer");
  } catch {
    throw new Error("multer is required for file uploads. Install it: npm install multer");
  }

  const storage = multer.memoryStorage();
  const upload = multer({
    storage,
    limits: { ...limits, parts: limits.files + limits.fields },
    fileFilter: opts.allowedMimeTypes
      ? (_req: any, file: any, cb: any) => {
          if (opts.allowedMimeTypes!.includes(file.mimetype)) {
            cb(null, true);
          } else {
            cb(new Error(`File type ${file.mimetype} is not allowed`));
          }
        }
      : undefined,
  });

  const middleware = upload.array("files", limits.files);
  return (req: any, res: any, next: (error?: unknown) => void) => {
    middleware(req, res, (error: unknown) => {
      if (error) {
        // Multer removes storage-owned copies; also release request-visible memory references.
        for (const file of req.files ?? []) delete file.buffer;
        req.files = [];
      }
      next(error);
    });
  };
}

export function filesToContentParts(files: any[]): any[] {
  return files.map((file) => {
    const base64 = file.buffer.toString("base64");
    const partType = getPartType(file.mimetype);

    return {
      type: partType,
      data: base64,
      mimeType: file.mimetype,
      ...(partType === "file"
        ? { fileName: (file.originalname ?? "attachment").replace(/.*[/\\]/, "").replace(/[^a-zA-Z0-9._-]/g, "_") }
        : {}),
    };
  });
}

export function buildMultiModalInput(body: any, files?: any[]): string | any[] {
  const textInput = body?.input;
  if (!files || files.length === 0) {
    return textInput;
  }

  const parts: any[] = [];
  if (textInput) {
    parts.push({ type: "text", text: textInput });
  }
  parts.push(...filesToContentParts(files));
  return parts;
}
