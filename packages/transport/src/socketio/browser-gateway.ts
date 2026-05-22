import type { EventBus } from "@agentium/core";

/**
 * Minimal interface for a BrowserAgent — avoids a hard dependency on @agentium/browser.
 * Any object that matches this shape (e.g. a real BrowserAgent) works.
 */
interface BrowserAgentLike {
  name: string;
  eventBus: EventBus;
  run(
    task: string,
    opts?: { startUrl?: string; apiKey?: string; sessionId?: string },
  ): Promise<{
    result: string;
    success: boolean;
    finalUrl: string;
    durationMs: number;
    videoPath?: string;
    steps: Array<{
      index: number;
      action: unknown;
      screenshot: Buffer;
      pageUrl: string;
      pageTitle: string;
      dom?: string;
    }>;
  }>;
}

export interface BrowserGatewayOptions {
  /** Named BrowserAgent instances. Clients select one via agentName. */
  agents: Record<string, BrowserAgentLike>;
  /** Socket.IO server instance */
  io: any;
  /** Socket.IO namespace. Default: "/agentium-browser" */
  namespace?: string;
  /** Optional auth middleware applied to the namespace */
  authMiddleware?: (socket: any, next: (err?: Error) => void) => void;
  /**
   * Stream screenshots to the client in real-time.
   * Default: true. Disable for bandwidth-constrained clients.
   */
  streamScreenshots?: boolean;
}

/**
 * Create a Socket.IO gateway that streams BrowserAgent execution in real-time.
 *
 * ## Client → Server events
 * - `browser.start` — kick off a browser task
 * - `browser.stop`  — cancel a running task
 *
 * ## Server → Client events
 * - `browser.started`    — task accepted
 * - `browser.screenshot` — live screenshot (base64 PNG)
 * - `browser.action`     — action about to execute
 * - `browser.step`       — full step with screenshot + DOM
 * - `browser.done`       — task finished (result, success, duration, video)
 * - `browser.error`      — error occurred
 * - `browser.stopped`    — task was cancelled
 */
export function createBrowserGateway(opts: BrowserGatewayOptions): void {
  const ns = opts.io.of(opts.namespace ?? "/agentium-browser");
  const streamScreenshots = opts.streamScreenshots ?? true;

  if (opts.authMiddleware) {
    ns.use(opts.authMiddleware);
  }

  const activeRuns = new Map<string, AbortController>();

  ns.on("connection", (socket: any) => {
    socket.on(
      "browser.start",
      async (data: { agentName: string; task: string; startUrl?: string; apiKey?: string; sessionId?: string }) => {
        const agent = opts.agents[data.agentName];
        if (!agent) {
          socket.emit("browser.error", {
            error: `Browser agent "${data.agentName}" not found`,
          });
          return;
        }

        if (activeRuns.has(socket.id)) {
          socket.emit("browser.error", {
            error: "A browser task is already running for this connection",
          });
          return;
        }

        const abort = new AbortController();
        activeRuns.set(socket.id, abort);

        const onScreenshot = (ev: { data: Buffer }) => {
          if (streamScreenshots && !abort.signal.aborted) {
            socket.emit("browser.screenshot", {
              data: ev.data.toString("base64"),
              mimeType: "image/png",
            });
          }
        };

        const onAction = (ev: { action: unknown }) => {
          if (!abort.signal.aborted) {
            socket.emit("browser.action", { action: ev.action });
          }
        };

        const onStep = (ev: { index: number; action: unknown; pageUrl: string; screenshot: Buffer }) => {
          if (!abort.signal.aborted) {
            socket.emit("browser.step", {
              index: ev.index,
              action: ev.action,
              pageUrl: ev.pageUrl,
              screenshot: streamScreenshots ? ev.screenshot.toString("base64") : undefined,
            });
          }
        };

        const onError = (ev: { error: Error }) => {
          if (!abort.signal.aborted) {
            socket.emit("browser.error", { error: ev.error.message });
          }
        };

        agent.eventBus.on("browser.screenshot", onScreenshot);
        agent.eventBus.on("browser.action", onAction);
        agent.eventBus.on("browser.step", onStep);
        agent.eventBus.on("browser.error", onError);

        const cleanup = () => {
          agent.eventBus.off("browser.screenshot", onScreenshot);
          agent.eventBus.off("browser.action", onAction);
          agent.eventBus.off("browser.step", onStep);
          agent.eventBus.off("browser.error", onError);
          activeRuns.delete(socket.id);
        };

        socket.emit("browser.started", {
          agentName: data.agentName,
          task: data.task,
        });

        try {
          const result = await agent.run(data.task, {
            startUrl: data.startUrl,
            apiKey: data.apiKey ?? socket.handshake?.auth?.apiKey,
            sessionId: data.sessionId,
          });

          cleanup();

          if (!abort.signal.aborted) {
            socket.emit("browser.done", {
              result: result.result,
              success: result.success,
              finalUrl: result.finalUrl,
              durationMs: result.durationMs,
              totalSteps: result.steps.length,
              videoPath: result.videoPath,
            });
          }
        } catch (error: any) {
          cleanup();
          if (!abort.signal.aborted) {
            socket.emit("browser.error", { error: error.message });
          }
        }
      },
    );

    socket.on("browser.stop", () => {
      const abort = activeRuns.get(socket.id);
      if (abort) {
        abort.abort();
        activeRuns.delete(socket.id);
        socket.emit("browser.stopped");
      }
    });

    socket.on("disconnect", () => {
      const abort = activeRuns.get(socket.id);
      if (abort) {
        abort.abort();
        activeRuns.delete(socket.id);
      }
    });
  });
}
