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
}

export class Logger {
  private level: LogLevel;
  private color: boolean;
  private prefix: string;

  constructor(config: LoggerConfig = {}) {
    this.level = config.level ?? "info";
    this.color = config.color ?? process.stdout.isTTY !== false;
    this.prefix = config.prefix ?? "agentium";
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
    if (data && Object.keys(data).length > 0) {
      const formatted = Object.entries(data)
        .map(([k, v]) => `${this.c(C.dim, `${k}=`)}${this.formatValue(v)}`)
        .join(" ");
      parts.push(formatted);
    }
    console.log(parts.join(" "));
  }

  private formatValue(v: unknown): string {
    if (typeof v === "number") return this.c(C.brightGreen, String(v));
    if (typeof v === "string") return this.c(C.yellow, `"${v}"`);
    if (typeof v === "boolean") return this.c(C.magenta, String(v));
    return String(v);
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

  toolCall(toolName: string, args: Record<string, unknown>): void {
    if (!this.shouldLog("debug")) return;
    const argsStr = JSON.stringify(args, null, 2);
    console.log(`${this.pipe()} ${this.c(C.brightMagenta, "⚡")} ${this.c(C.magenta, toolName)}`);
    if (argsStr !== "{}" && argsStr !== "[]") {
      const truncated = argsStr.length > 200 ? `${argsStr.slice(0, 200)}…` : argsStr;
      for (const line of truncated.split("\n")) {
        console.log(`${this.pipe()}   ${this.c(C.dim, line)}`);
      }
    }
  }

  toolResult(toolName: string, result: string): void {
    if (!this.shouldLog("debug")) return;
    const truncated = result.length > 300 ? `${result.slice(0, 300)}…` : result;
    console.log(`${this.pipe()} ${this.c(C.green, "✓")} ${this.c(C.dim, `${toolName} →`)}`);
    for (const line of truncated.split("\n")) {
      console.log(`${this.pipe()}   ${this.c(C.gray, line)}`);
    }
    console.log(this.pipe());
  }

  thinking(content: string): void {
    if (!this.shouldLog("info")) return;
    const truncated = content.length > 500 ? `${content.slice(0, 500)}…` : content;
    const label = this.c(C.dim + C.italic, "Thinking: ");
    const lines = truncated.split("\n");
    console.log(`${this.pipe()} ${label}${this.c(C.dim + C.italic, lines[0])}`);
    const pad = " ".repeat(10);
    for (let i = 1; i < lines.length; i++) {
      console.log(`${this.pipe()} ${pad}${this.c(C.dim + C.italic, lines[i])}`);
    }
    console.log(this.pipe());
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
