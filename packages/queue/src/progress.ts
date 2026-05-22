import type { EventBus } from "@agentium/core";

export function bridgeEventBusToJob(eventBus: EventBus, job: any, runId: string): () => void {
  let progressCount = 0;

  const onChunk = (evt: { runId: string; chunk: string }) => {
    if (evt.runId !== runId) return;
    progressCount++;
    job.updateProgress(progressCount).catch(() => {});
  };

  const onToolCall = (evt: { runId: string; toolName: string }) => {
    if (evt.runId !== runId) return;
    job.log(`Tool call: ${evt.toolName}`).catch(() => {});
  };

  eventBus.on("run.stream.chunk", onChunk);
  eventBus.on("tool.call", onToolCall);

  return () => {
    eventBus.off("run.stream.chunk", onChunk);
    eventBus.off("tool.call", onToolCall);
  };
}
