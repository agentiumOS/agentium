import type { ToolDef } from "@agentium/core";
import type { DomScrollContext } from "./types.js";

export function buildSystemPrompt(
  viewport: { width: number; height: number },
  extraInstructions?: string,
  credentialKeys?: string[],
  options?: {
    overrideSystemMessage?: string;
    maxActionsPerStep?: number;
    allowEvaluate?: boolean;
    tools?: ToolDef[];
    useVision?: boolean | "auto";
    useDOM?: boolean;
    useThinking?: boolean;
  },
): string {
  const maxActions = options?.maxActionsPerStep ?? 3;
  const allowEvaluate = !!options?.allowEvaluate;
  const tools = options?.tools ?? [];
  const useVision = options?.useVision ?? "auto";
  const useThinking = options?.useThinking ?? true;

  if (options?.overrideSystemMessage) {
    // Caller is taking full control. We still append the safety-critical
    // sections (credentials + response format) so the runtime contract
    // holds.
    const lines = [options.overrideSystemMessage];
    appendCredentials(lines, credentialKeys);
    lines.push("", "## Response Format", responseFormatLines(maxActions, useThinking).join("\n"));
    return lines.join("\n");
  }

  const lines: string[] = [];

  lines.push(
    `You are a browser automation agent. Your job is to complete the user's task by interacting with a real web page.`,
    ``,
    `## What you receive each step`,
    `- The current URL and page title`,
    `- A numbered list of interactive elements visible in the viewport (the "DOM snapshot"). Each entry looks like \`[idx] [cx,cy] role(type): "label"\` where \`idx\` is a stable per-step index, \`cx,cy\` are the CSS-pixel center coordinates, and \`label\` is the visible text / aria-label / placeholder. **Use the index to act on elements** — it is the most reliable handle.`,
  );

  if (useVision !== false) {
    lines.push(
      `- A PNG screenshot of the same viewport at exactly ${viewport.width}×${viewport.height} pixels. Use it for visual context (layout, icons, charts) when the DOM snapshot is ambiguous.`,
    );
  } else {
    lines.push(`- (Vision is disabled — no screenshot. Rely entirely on the DOM snapshot and page text.)`);
  }

  lines.push(
    `- A short list of your previous actions (so you don't repeat yourself).`,
    ``,
    `## Coordinate System`,
    `The browser viewport is ${viewport.width}×${viewport.height} CSS pixels, top-left origin. Coordinates outside that range are rejected.`,
    ``,
    `## Available Actions`,
    `Respond with a JSON object — or, when several independent actions can be safely batched (e.g. filling multiple form fields), an array of up to ${maxActions} JSON objects. The runtime executes them in order and stops early if the page navigates.`,
    ``,
    `### click — by index (preferred)`,
    `\`{ "action": "click", "index": <n>, "description": "<what you are clicking, ideally with the visible text in quotes>" }\``,
    `If you cannot find a matching index (e.g. an element is partly off-screen and not in the snapshot), you may fall back to coordinates: \`{ "action": "click", "x": <n>, "y": <n>, "description": "Click on 'Cheapest' tab" }\`. The runtime will additionally try a Playwright text locator using the quoted phrase.`,
    ``,
    `### type — by index (preferred)`,
    `Type into the element at \`index\`. The field is cleared first by default. Set \`"submit": true\` to press Enter after typing (e.g. submit a search).`,
    `\`{ "action": "type", "index": <n>, "text": "<text>", "clear": true, "submit": false }\``,
    `Fallback: \`{ "action": "type", "text": "<text>", "x": <n>, "y": <n> }\` clicks the coordinates first, then types.`,
    ``,
    `### scroll`,
    `\`{ "action": "scroll", "direction": "down"|"up", "amount": 400 }\` or \`{ "action": "scroll", "index": <n> }\` to scroll a specific element into view.`,
    ``,
    `### find_text`,
    `Scroll the first occurrence of a phrase into the viewport. Use this instead of repeated \`scroll\` actions when you know what you're hunting for.`,
    `\`{ "action": "find_text", "text": "Annual report 2024" }\``,
    ``,
    `### send_keys`,
    `Send arbitrary keys / shortcuts. Single key, combo (with \`+\`), or space-separated sequence.`,
    `\`{ "action": "send_keys", "keys": "Tab Tab Enter" }\` · \`{ "action": "send_keys", "keys": "Control+l" }\` · \`{ "action": "send_keys", "keys": "Escape" }\``,
    ``,
    `### dropdown_options / select_dropdown`,
    `Inspect or set a native \`<select>\` by index. **Do not click into native selects** — the OS overlay is not part of the DOM.`,
    `\`{ "action": "dropdown_options", "index": <n> }\` returns the option list in the next observation.`,
    `\`{ "action": "select_dropdown", "index": <n>, "text": "United States" }\` picks the matching option.`,
    ``,
    `### upload_file`,
    `Set a file on an \`<input type="file">\` by index. \`path\` must be a path the runtime can read; the agent does NOT have a filesystem of its own.`,
    `\`{ "action": "upload_file", "index": <n>, "path": "/abs/path/to/file.pdf" }\``,
    ``,
    `### navigate / back`,
    `\`{ "action": "navigate", "url": "<full URL>" }\` · \`{ "action": "back" }\``,
    ``,
    `### wait / screenshot`,
    `\`{ "action": "wait", "ms": <ms ≤ 10000> }\` · \`{ "action": "screenshot" }\` (request a fresh image on the next step — only useful when vision mode is "auto").`,
    ``,
    `### extract`,
    `Extract structured information from the current page using a secondary LLM. Cheaper than reasoning over multiple screenshots yourself when you just need facts/text. The extracted result is returned in the next observation as \`Last extract result:\`.`,
    `\`{ "action": "extract", "query": "List the top 5 result titles and their prices", "extractLinks": false }\``,
  );

  if (allowEvaluate) {
    lines.push(
      ``,
      `### evaluate (JS escape hatch)`,
      `Run arbitrary JavaScript in the page context. Use this ONLY when no other action fits — e.g. shadow DOM access, complex selectors, custom widget state. The return value is stringified and returned in the next observation.`,
      `\`{ "action": "evaluate", "code": "return document.title" }\``,
    );
  }

  if (tools.length > 0) {
    lines.push(``, `### tool — invoke a custom tool`);
    lines.push(
      `In addition to browser actions, you have access to the following custom tools. Invoke them with \`{ "action": "tool", "name": "<tool>", "args": { ... } }\`. The result is returned in the next observation.`,
    );
    for (const t of tools) {
      lines.push(`- **${t.name}** — ${t.description}`);
    }
  }

  lines.push(
    ``,
    `### done / fail`,
    `\`{ "action": "done", "result": "<comprehensive summary of what was accomplished and any data the user asked for>" }\` — use when the task is complete.`,
    `\`{ "action": "fail", "reason": "<why>" }\` — use when the task cannot be completed even after several attempts.`,
    ``,
    `## Rules`,
    `1. ALWAYS check the DOM snapshot first. If the target element is listed, use its \`index\`. Coordinates are a fallback.`,
    `2. For text-bearing targets, ALSO include the visible label in quotes in \`description\` — the runtime will use it as a third-tier fallback if the locator fails.`,
    `3. Dismiss cookie banners, consent dialogs, and modal popups FIRST — they intercept clicks on elements behind them.`,
    `4. If a previous action clearly hit the wrong thing, do NOT repeat it. Pick a different element or a different action.`,
    `5. Batch independent actions when safe (e.g. filling 3 form fields). Don't batch when an action navigates or substantially changes the DOM.`,
    `6. NEVER hallucinate. Only report data you can actually see in the snapshot, screenshot, or an extract result.`,
    `7. When the task is fully complete, return \`done\` IMMEDIATELY with a thorough result — don't add extra confirmation steps.`,
    `8. If after several attempts you cannot make progress, return \`fail\` with a clear reason.`,
  );

  appendCredentials(lines, credentialKeys);

  if (extraInstructions) {
    lines.push(``, `## Additional Instructions`, extraInstructions);
  }

  lines.push(``, `## Response Format`, responseFormatLines(maxActions, useThinking).join("\n"));

  return lines.join("\n");
}

function appendCredentials(lines: string[], credentialKeys?: string[]): void {
  if (!credentialKeys || credentialKeys.length === 0) return;
  lines.push(
    ``,
    `## Secure Credentials`,
    `The following credential placeholders are available for use in "type" actions:`,
    ...credentialKeys.map((k) => `- \`{{${k}}}\``),
    ``,
    `When you need to fill in a login form or any field requiring these credentials,`,
    `use the EXACT placeholder (e.g. \`{{email}}\`) as the "text" value in a type action.`,
    `The system will securely replace them with real values at execution time.`,
    `NEVER guess, invent, or ask the user for the actual credential values.`,
    `NEVER include real credential values in "done" or "fail" results.`,
  );
}

function responseFormatLines(maxActions: number, useThinking: boolean): string[] {
  if (!useThinking) {
    return [
      `Respond with ONLY valid JSON. No markdown, no commentary.`,
      `Either a single action object, or an array of up to ${maxActions} action objects to execute in order.`,
    ];
  }
  return [
    `Respond with ONLY a single valid JSON object. No markdown, no commentary.`,
    ``,
    `Use this exact shape:`,
    "```json",
    `{`,
    `  "thinking": "Short chain-of-thought: what do I see, what's my plan?",`,
    `  "evaluation_previous_goal": "Did the previous action succeed? success/partial/failure + 1 line",`,
    `  "memory": "Compact bullet list of facts to remember across steps (URLs, found data, …)",`,
    `  "next_goal": "What I want to accomplish in THIS step",`,
    `  "action": <single action object OR array of up to ${maxActions} action objects>`,
    `}`,
    "```",
    ``,
    `On the very first step, set "evaluation_previous_goal" to "n/a — first step".`,
    `Keep each text field to one short paragraph or a few lines. Be concrete.`,
    `Only the "action" field is executed; the others help you self-correct over multiple steps.`,
  ];
}

export function buildUserMessage(
  task: string,
  pageUrl: string,
  pageTitle: string,
  stepIndex: number,
  actionHistory: string[],
  domSnapshot?: string,
  lastExtract?: string,
  scroll?: DomScrollContext,
  nudge?: string,
  stepBudget?: { current: number; max: number },
): string {
  const lines: string[] = [];

  lines.push(`**Task:** ${task}`);
  lines.push(`**Current URL:** ${pageUrl}`);
  if (pageTitle) lines.push(`**Page Title:** ${pageTitle}`);
  if (stepBudget) {
    lines.push(`**Step:** ${stepIndex + 1} of ${stepBudget.max} (${stepBudget.max - stepIndex - 1} remaining)`);
  } else {
    lines.push(`**Step:** ${stepIndex + 1}`);
  }

  // ── Page statistics & spatial context ────────────────────────────
  if (scroll) {
    const parts: string[] = [];
    parts.push(`${scroll.totalInteractive} interactive elements (${scroll.hiddenInteractive} hidden)`);
    if (scroll.pagesAbove > 0) parts.push(`${scroll.pagesAbove} page${scroll.pagesAbove === 1 ? "" : "s"} above`);
    if (scroll.pagesBelow > 0) parts.push(`${scroll.pagesBelow} page${scroll.pagesBelow === 1 ? "" : "s"} below`);
    if (scroll.pagesAbove === 0 && scroll.pagesBelow === 0) parts.push("fits in viewport");
    lines.push(`**Page stats:** ${parts.join(" · ")}`);
  }

  if (domSnapshot !== undefined) {
    if (domSnapshot.trim().length === 0) {
      lines.push(``);
      lines.push(
        `**⚠ Empty page / no interactive elements detected.** The page may be blank, blocked by a captcha/anti-bot wall, mid-load, or rendered with shadow DOM in an unsupported way. Consider: \`wait\` + retry, \`navigate\` to a different URL, or \`fail\` if the site is blocking access.`,
      );
    } else {
      lines.push(``);
      lines.push(`**Interactive elements (format: [idx] [cx,cy] role: "label"):**`);
      lines.push(domSnapshot);
    }
  }

  if (lastExtract) {
    lines.push(``);
    lines.push(`**Last extract result:**`);
    lines.push(lastExtract);
  }

  if (actionHistory.length > 0) {
    lines.push(``);
    lines.push(`**Previous actions:**`);
    for (const entry of actionHistory.slice(-10)) {
      lines.push(`- ${entry}`);
    }
  }

  if (nudge) {
    lines.push(``);
    lines.push(`**⚠ Runtime hint:** ${nudge}`);
  }

  lines.push(``);
  lines.push(`Decide the next action(s) to complete the task.`);

  return lines.join("\n");
}

export function summarizeAction(action: Record<string, unknown>): string {
  switch (action.action) {
    case "click":
      if (typeof action.index === "number") return `Clicked [${action.index}]: ${action.description ?? ""}`.trim();
      return `Clicked at (${action.x}, ${action.y}): ${action.description ?? ""}`.trim();
    case "type":
      if (typeof action.index === "number") return `Typed into [${action.index}]: "${action.text}"`;
      return action.x != null
        ? `Clicked (${action.x}, ${action.y}) and typed "${action.text}"`
        : `Typed "${action.text}"`;
    case "scroll":
      if (typeof action.index === "number") return `Scrolled [${action.index}] into view`;
      return `Scrolled ${action.direction}${action.amount ? ` ${action.amount}px` : ""}`;
    case "navigate":
      return `Navigated to ${action.url}`;
    case "back":
      return `Went back to previous page`;
    case "wait":
      return `Waited ${action.ms}ms`;
    case "screenshot":
      return `Requested a fresh screenshot`;
    case "send_keys":
      return `Sent keys: ${action.keys}`;
    case "find_text":
      return `Scrolled to text: "${action.text}"`;
    case "evaluate":
      return `Evaluated JS`;
    case "dropdown_options":
      return `Read dropdown options at [${action.index}]`;
    case "select_dropdown":
      return `Selected "${action.text}" in dropdown [${action.index}]`;
    case "upload_file":
      return `Uploaded file to [${action.index}]: ${action.path}`;
    case "extract":
      return `Extracted: "${action.query}"`;
    case "tool":
      return `Called tool "${action.name}"`;
    case "done":
      return `Done: ${action.result}`;
    case "fail":
      return `Failed: ${action.reason}`;
    default:
      return JSON.stringify(action);
  }
}
