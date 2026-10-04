import { createServer, type IncomingMessage, request } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { createFileUploadMiddleware } from "../express/file-upload.js";

const boundary = "agentium-test-boundary";
const field = (name: string, value: string) =>
  `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
const file = (data: string) =>
  `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="fixture.txt"\r\nContent-Type: text/plain\r\n\r\n${data}\r\n`;
const end = `--${boundary}--\r\n`;

async function fixture() {
  const app = express();
  const completed: { req: IncomingMessage & { files?: any[] }; error?: unknown }[] = [];
  const received: IncomingMessage[] = [];
  const upload = createFileUploadMiddleware({ maxFiles: 2, maxFileSize: 64, maxFields: 2, maxFieldSize: 32 });
  app.post("/upload", (req, res) => {
    received.push(req);
    upload(req, res, (error: unknown) => {
      completed.push({ req, error });
      if (!res.destroyed) res.status(error ? 400 : 200).json({ accepted: !error });
    });
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/upload`;
  return {
    url,
    completed,
    received,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("bounded multipart fixture cleanup", () => {
  it.each([
    file("x".repeat(65)) + end,
    field("a", "x".repeat(33)) + end,
    field("a", "1") + field("b", "2") + field("c", "3") + end,
    file("a") + file("b") + file("c") + end,
    `${file("ok")}--broken-boundary--\r\n`,
  ])("rejects malformed or over-limit upload without retained file buffers", async (body) => {
    const f = await fixture();
    try {
      const response = await fetch(f.url, {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        body,
      });
      expect(response.status).toBe(400);
      await response.text();
      expect(f.completed).toHaveLength(1);
      expect(f.completed[0].error).toBeDefined();
      expect(f.completed[0].req.files?.every((v) => v.buffer === undefined) ?? true).toBe(true);
      await new Promise((resolve) => setImmediate(resolve));
      expect(f.completed[0].req.listenerCount("data")).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("cleans a deliberately small aborted upload and continues serving a valid request", async () => {
    const f = await fixture();
    try {
      const req = request(f.url, {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      });
      req.on("error", () => {});
      req.write(file("small").slice(0, -2));
      await vi.waitFor(() => expect(f.received).toHaveLength(1));
      req.destroy();
      await vi.waitFor(() => expect(f.completed).toHaveLength(1));
      expect(f.completed[0].error).toBeDefined();
      expect(f.completed[0].req.destroyed).toBe(true);
      expect(f.completed[0].req.files?.every((v) => v.buffer === undefined) ?? true).toBe(true);
      await new Promise((resolve) => setImmediate(resolve));
      expect(f.completed[0].req.listenerCount("data")).toBe(0);
      const response = await fetch(f.url, {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        body: field("input", "hello") + file("fine") + end,
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(f.completed).toHaveLength(2);
      expect(f.completed[1].req.files?.[0].buffer.toString()).toBe("fine");
    } finally {
      await f.close();
    }
  });
});
