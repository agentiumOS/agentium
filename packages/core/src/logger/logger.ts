export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",

  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",

  bgBlack: "\x1b[40m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
  bgCyan: "\x1b[46m",

  gray: "\x1b[90m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
};

function noColor(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

export interface LoggerConfig {
  level?: LogLevel;
  color?: boolean;
  prefix?: string;
  /**
   * Max characters of a tool arg/result body printed at debug.
   * Default: 100_000 (full JSON in practice). Set lower if a toolkit dumps megabytes.
   */
  maxPayloadChars?: number;
}

export class Logger {
  private level: LogLevel;
  private color: boolean;
  private prefix: string;
  private maxPayloadChars: number;

  constructor(config: LoggerConfig = {}) {
    this.level = config.level ?? "info";
    this.color = config.color ?? process.stdout.isTTY !== false;
    this.prefix = config.prefix ?? "agentium";
    this.maxPayloadChars = config.maxPayloadChars ?? 100_000;
  }

  private c(code: string, text: string): string {
    return this.color ? `${code}${text}${C.reset}` : text;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.level];
  }

  private tag(level: LogLevel): string {
    switch (level) {
      case "debug":
        return this.c(C.gray, "DBG");
      case "info":
        return this.c(C.brightCyan, "INF");
      case "warn":
        return this.c(C.brightYellow, "WRN");
      case "error":
        return this.c(C.red, "ERR");
      default:
        return "";
    }
  }

  private timestamp(): string {
    const now = new Date();
    const ts = now.toISOString().slice(11, 23);
    return this.c(C.dim, ts);
  }

  private log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;
    const parts = [this.timestamp(), this.tag(level), this.c(C.dim, `[${this.prefix}]`), msg];
    const multiline: string[] = [];
    if (data && Object.keys(data).length > 0) {
      for (const [k, v] of Object.entries(data)) {
        const rendered = this.formatValue(v);
        if (rendered.includes("\n")) {
          multiline.push(`${this.c(C.dim, k)}=\n${rendered}`);
        } else {
          parts.push(`${this.c(C.dim, `${k}=`)}${rendered}`);
        }
      }
    }
    console.log(parts.join(" "));
    for (const block of multiline) {
      console.log(block);
    }
  }

  private formatValue(v: unknown): string {
    if (v === null) return this.c(C.gray, "null");
    if (v === undefined) return this.c(C.gray, "undefined");
    if (typeof v === "number") return this.c(C.brightGreen, String(v));
    if (typeof v === "boolean") return this.c(C.magenta, String(v));
    if (typeof v === "string") {
      if (v.length <= 80 && !v.includes("\n")) return this.c(C.yellow, JSON.stringify(v));
      return this.formatPayload(v);
    }
    if (typeof v === "object") return this.formatPayload(v);
    return String(v);
  }

  /** Compact JSON when it fits one line; otherwise pretty-print. Never slice mid-token. */
  formatPayload(value: unknown, maxChars = this.maxPayloadChars): string {
    let text: string;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          text = this.stringifyJson(JSON.parse(trimmed));
        } catch {
          text = value;
        }
      } else {
        text = value;
      }
    } else {
      text = this.stringifyJson(value);
    }

    if (text.length <= maxChars) return text;
    const keep = text.slice(0, maxChars);
    const lastNl = keep.lastIndexOf("\n");
    const cut = lastNl > maxChars * 0.5 ? keep.slice(0, lastNl) : keep;
    return `${cut}\n… (${(text.length - cut.length).toLocaleString()} more chars)`;
  }

  private stringifyJson(value: unknown): string {
    try {
      const compact = JSON.stringify(value);
      if (compact === undefined) return String(value);
      if (compact.length <= 100) return compact;
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  debug(msg: string, data?: Record<string, unknown>) {
    this.log("debug", msg, data);
  }

  info(msg: string, data?: Record<string, unknown>) {
    this.log("info", msg, data);
  }

  warn(msg: string, data?: Record<string, unknown>) {
    this.log("warn", msg, data);
  }

  error(msg: string, data?: Record<string, unknown>) {
    this.log("error", msg, data);
  }

  // ── Formatted agent output helpers ────────────────────────────────────

  private readonly boxWidth = 80;

  private pipe(): string {
    return this.c(C.brightCyan, "│");
  }

  private printBoxLine(label: string, value: string, labelColor = C.dim, valueColor = C.white): void {
    const lines = value.split("\n");
    const prefix = `${this.pipe()} ${this.c(labelColor, label)}`;
    console.log(`${prefix}${this.c(valueColor, lines[0])}`);
    const pad = " ".repeat(noColor(label).length);
    for (let i = 1; i < lines.length; i++) {
      console.log(`${this.pipe()} ${pad}${this.c(valueColor, lines[i])}`);
    }
  }

  agentStart(agentName: string, input: string): void {
    if (!this.shouldLog("info")) return;
    const title = ` Agent: ${agentName} `;
    const lineLen = Math.max(0, this.boxWidth - title.length - 2);
    console.log("");
    console.log(
      this.c(C.bold + C.brightCyan, "┌─") + this.c(C.bold + C.brightCyan, title) + this.c(C.dim, "─".repeat(lineLen)),
    );
    this.printBoxLine("Input:  ", input);
    console.log(this.pipe());
  }

  private printIndented(body: string, color: string): void {
    for (const line of body.split("\n")) {
      console.log(`${this.pipe()}   ${this.c(color, line)}`);
    }
  }

  toolCall(toolName: string, args: Record<string, unknown> = {}): void {
    if (!this.shouldLog("debug")) return;
    const payload = this.formatPayload(args);
    const oneLine = !payload.includes("\n") && payload !== "{}";
    console.log(
      `${this.pipe()} ${this.c(C.brightMagenta, "→")} ${this.c(C.magenta, toolName)}${oneLine ? `  ${this.c(C.dim, payload)}` : ""}`,
    );
    if (!oneLine && payload !== "{}") {
      this.printIndented(payload, C.dim);
    }
  }

  toolResult(toolName: string, result: string): void {
    if (!this.shouldLog("debug")) return;
    const payload = this.formatPayload(result);
    if (!payload.includes("\n") && payload.length <= 120) {
      console.log(`${this.pipe()} ${this.c(C.green, "←")} ${this.c(C.dim, toolName)}  ${this.c(C.gray, payload)}`);
      return;
    }
    console.log(`${this.pipe()} ${this.c(C.green, "←")} ${this.c(C.dim, toolName)}`);
    this.printIndented(payload, C.gray);
  }

  thinking(content: string): void {
    if (!this.shouldLog("info")) return;
    const body = this.shouldLog("debug") ? this.formatPayload(content) : this.formatPayload(content, 500);
    const lines = body.split("\n");
    const label = this.c(C.dim + C.italic, "Thinking: ");
    console.log(`${this.pipe()} ${label}${this.c(C.dim + C.italic, lines[0])}`);
    const pad = " ".repeat(10);
    for (let i = 1; i < lines.length; i++) {
      console.log(`${this.pipe()} ${pad}${this.c(C.dim + C.italic, lines[i])}`);
    }
  }

  agentEnd(
    _agentName: string,
    output: string,
    usage: { promptTokens: number; completionTokens: number; totalTokens: number; reasoningTokens?: number },
    durationMs: number,
  ): void {
    if (!this.shouldLog("info")) return;

    console.log(this.pipe());
    this.printBoxLine("Output: ", output);
    console.log(this.pipe());

    let tokensLine =
      this.c(C.dim, "Tokens: ") +
      this.c(C.brightGreen, `↑ ${usage.promptTokens}`) +
      this.c(C.dim, "  ") +
      this.c(C.brightGreen, `↓ ${usage.completionTokens}`) +
      this.c(C.dim, "  ") +
      this.c(C.bold + C.brightGreen, `Σ ${usage.totalTokens}`);

    if (usage.reasoningTokens) {
      tokensLine += this.c(C.dim, "  ") + this.c(C.brightMagenta, `🧠 ${usage.reasoningTokens}`);
    }

    const duration = this.c(C.dim, "Duration: ") + this.c(C.yellow, this.formatDuration(durationMs));

    console.log(`${this.pipe()} ${tokensLine}`);
    console.log(`${this.pipe()} ${duration}`);
    console.log(this.c(C.bold + C.brightCyan, "└") + this.c(C.dim, "─".repeat(this.boxWidth - 1)));
  }

  separator(): void {
    if (!this.shouldLog("info")) return;
    console.log(this.c(C.dim, "─".repeat(this.boxWidth)));
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const secs = (ms / 1000).toFixed(1);
    return `${secs}s`;
  }
}
