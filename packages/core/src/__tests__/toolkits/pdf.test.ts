import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
import { RunContext } from "../../agent/run-context.js";
import { EventBus } from "../../events/event-bus.js";
import { PdfToolkit } from "../../toolkits/pdf.js";

const { PDFParse } = createRequire(import.meta.url)("pdf-parse");
afterEach(() => vi.restoreAllMocks());
function fixturePdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...["First page has a longer synthetic text", "Second page"].map((text) => {
      const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
      return `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
    }),
    "<< /Title (Synthetic fixture) /Author (Agentium) >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 8 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf).toString("base64");
}
const ctx = () => new RunContext({ sessionId: "pdf-test", eventBus: new EventBus() });
it("extracts actual text, page boundaries and metadata with pdf-parse v2 and cleans up", async () => {
  const destroy = vi.spyOn(PDFParse.prototype, "destroy");
  const tools = new PdfToolkit().getTools();
  const source = fixturePdf();
  const text = await tools[0].execute({ source }, ctx());
  expect(text).toContain("First page has a longer synthetic text");
  const info = JSON.parse((await tools[1].execute({ source }, ctx())) as string);
  expect(info).toMatchObject({ pages: 2, title: "Synthetic fixture", author: "Agentium" });
  const pages = JSON.parse((await tools[2].execute({ source, pages: [2] }, ctx())) as string);
  expect(pages.pages).toEqual([{ page: 2, text: expect.stringContaining("Second page") }]);
  expect(pages.pages[0].text).not.toContain("First page");
  expect(destroy).toHaveBeenCalledTimes(3);
});
it("destroys parser resources on malformed PDFs and invalid page selection", async () => {
  const destroy = vi.spyOn(PDFParse.prototype, "destroy");
  const tools = new PdfToolkit().getTools();
  expect(
    JSON.parse((await tools[0].execute({ source: Buffer.from("not a PDF").toString("base64") }, ctx())) as string)
      .error,
  ).toBeDefined();
  expect(JSON.parse((await tools[2].execute({ source: fixturePdf(), pages: [99] }, ctx())) as string).error).toMatch(
    /page range/,
  );
  expect(destroy).toHaveBeenCalledTimes(2);
});
