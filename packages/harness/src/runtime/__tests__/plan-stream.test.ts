import { describe, expect, it } from "vitest";
import type { PlanCommitFrame } from "../graph-contracts.js";
import { decodePlanCommitFrames } from "../plan-stream.js";

const frame = { baseRevision: 0, plan: { schemaVersion: 1, revision: 1, nodes: [] } };
const limits = { maxFrameBytes: 1000, maxTotalBytes: 3000, maxFrames: 3 };
async function* chunks(values: string[]) {
  yield* values;
}
async function collect(values: string[], bounds = limits) {
  const result = [];
  for await (const next of decodePlanCommitFrames(chunks(values), bounds)) result.push(next);
  return result;
}
describe("bounded NDJSON commit frame decoding", () => {
  it("accepts every fragmentation boundary and CRLF without dispatching partial JSON", async () => {
    const encoded = `${JSON.stringify(frame)}\r\n`;
    for (let split = 0; split <= encoded.length; split++)
      expect(await collect([encoded.slice(0, split), encoded.slice(split)])).toEqual([frame]);
  });
  it("emits a valid prefix before a malformed frame in the same text chunk", async () => {
    const seen: PlanCommitFrame[] = [];
    await expect(
      (async () => {
        for await (const next of decodePlanCommitFrames(chunks([`${JSON.stringify(frame)}\n{bad}\n`]), limits))
          seen.push(next);
      })(),
    ).rejects.toThrow();
    expect(seen).toEqual([frame]);
  });
  it.each([
    JSON.stringify(frame),
    '{"baseRevision":0',
    "```json\n{}\n```\n",
    '{"baseRevision":0,"plan":{},"grant":"all"}\n',
  ])("rejects a truncated or non-protocol frame %s", async (text) => expect(collect([text])).rejects.toThrow());
  it("bounds UTF8 frame and cumulative bytes plus frame counts", async () => {
    const text = `${JSON.stringify(frame)}\n`;
    await expect(collect([text], { ...limits, maxFrameBytes: 8 })).rejects.toThrow();
    await expect(collect([text, text], { ...limits, maxTotalBytes: text.length + 1 })).rejects.toThrow();
    await expect(collect([text, text], { ...limits, maxFrames: 1 })).rejects.toThrow();
  });
  it("allows blank lines and trailing whitespace, and respects cancellation", async () => {
    expect(await collect([`\n ${JSON.stringify(frame)} \n  `])).toEqual([frame]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      (async () => {
        for await (const _ of decodePlanCommitFrames(
          chunks([`${JSON.stringify(frame)}\n`]),
          limits,
          controller.signal,
        )) {
          /* unused */
        }
      })(),
    ).rejects.toThrow();
  });
  it("interrupts a stalled source when the signal aborts without waiting for another fragment", async () => {
    const controller = new AbortController();
    const source: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<string>>(() => {}),
          return: async () => ({ done: true, value: undefined }),
        };
      },
    };
    const pending = (async () => {
      for await (const _ of decodePlanCommitFrames(source, limits, controller.signal)) {
        /* unused */
      }
    })();
    setTimeout(() => controller.abort(), 1);
    await expect(pending).rejects.toThrow();
  });
});
