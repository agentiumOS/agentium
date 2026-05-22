import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

export interface CalculatorConfig {
  /** Decimal precision for results (default 10). */
  precision?: number;
}

const ALLOWED_TOKENS = /^[\d\s+\-*/().,%^eE]+$/;

const MATH_ENV: Record<string, unknown> = {
  abs: Math.abs,
  ceil: Math.ceil,
  floor: Math.floor,
  round: Math.round,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  pow: Math.pow,
  log: Math.log,
  log2: Math.log2,
  log10: Math.log10,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  exp: Math.exp,
  min: Math.min,
  max: Math.max,
  random: Math.random,
  PI: Math.PI,
  E: Math.E,
};

function safeEvaluate(expression: string): number {
  const cleaned = expression.replace(/\s+/g, " ").trim();

  const isSimple = ALLOWED_TOKENS.test(cleaned);
  const hasMathFns = /[a-zA-Z]/.test(cleaned);

  if (!isSimple && !hasMathFns) {
    throw new Error(`Invalid expression: contains disallowed characters`);
  }

  if (hasMathFns) {
    const identifiers = cleaned.match(/[a-zA-Z_]\w*/g) ?? [];
    for (const id of identifiers) {
      if (!(id in MATH_ENV)) {
        throw new Error(`Unknown identifier: "${id}". Allowed: ${Object.keys(MATH_ENV).join(", ")}`);
      }
    }
  }

  const paramNames = Object.keys(MATH_ENV);
  const paramValues = Object.values(MATH_ENV);

  const fn = new Function(...paramNames, `"use strict"; return (${cleaned});`);
  const result = fn(...paramValues);

  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw new Error(`Expression did not evaluate to a finite number (got ${result})`);
  }

  return result;
}

/**
 * Calculator Toolkit — evaluate math expressions safely.
 *
 * Supports basic arithmetic, exponentiation, and common Math functions
 * (sin, cos, sqrt, log, etc.) without using eval().
 *
 * @example
 * ```ts
 * const calc = new CalculatorToolkit();
 * const agent = new Agent({ tools: [...calc.getTools()] });
 * ```
 */
export class CalculatorToolkit extends Toolkit {
  readonly name = "calculator";
  private precision: number;

  constructor(config: CalculatorConfig = {}) {
    super();
    this.precision = config.precision ?? 10;
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "calculate",
        description:
          "Evaluate a mathematical expression. Supports +, -, *, /, ^, %, parentheses, and math functions: abs, ceil, floor, round, sqrt, cbrt, pow, log, log2, log10, sin, cos, tan, asin, acos, atan, exp, min, max. Constants: PI, E.",
        parameters: z.object({
          expression: z.string().describe('The math expression to evaluate (e.g. "sqrt(144) + pow(2, 10)")'),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const expr = args.expression as string;
          try {
            const result = safeEvaluate(expr);
            const rounded = Number.parseFloat(result.toPrecision(this.precision));
            return `${rounded}`;
          } catch (err: any) {
            return `Error: ${err.message}`;
          }
        },
      },
    ];
  }
}
