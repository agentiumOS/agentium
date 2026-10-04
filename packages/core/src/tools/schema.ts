import * as z4 from "zod/v4/core";

/** Structural v3 contract avoids nominal private-field differences between
 * the standalone v3 package and the v3 compatibility copy shipped with v4. */
export interface Zod3Schema {
  readonly _def: { readonly typeName?: string };
  readonly _output: unknown;
  parse(value: unknown): unknown;
  safeParse(value: unknown): SchemaParseResult<unknown>;
}
export type SchemaParseResult<T> =
  | { success: true; data: T }
  | {
      success: false;
      error: { message: string; issues: readonly { path: readonly PropertyKey[]; message: string }[] };
    };
/** Public schema boundary accepts Zod 3, Zod 4 Classic and Zod 4 Mini. */
export type AgentiumSchema = Zod3Schema | z4.$ZodType;
export type ToolParameterSchema =
  | (Zod3Schema & {
      readonly _def: { readonly typeName: "ZodObject" };
      readonly _output: Record<string, unknown>;
      readonly shape: Record<string, Zod3Schema>;
    })
  | z4.$ZodObject;
export type SchemaOutput<T extends AgentiumSchema> = T extends z4.$ZodType
  ? z4.output<T>
  : T extends Zod3Schema
    ? T["_output"]
    : never;

export function parseSchema<T extends AgentiumSchema>(schema: T, value: unknown): SchemaOutput<T> {
  return ("_zod" in schema ? z4.parse(schema, value) : schema.parse(value)) as SchemaOutput<T>;
}

export function safeParseSchema<T extends AgentiumSchema>(
  schema: T,
  value: unknown,
): SchemaParseResult<SchemaOutput<T>> {
  return ("_zod" in schema ? z4.safeParse(schema, value) : schema.safeParse(value)) as SchemaParseResult<
    SchemaOutput<T>
  >;
}

export function schemaShape(schema: ToolParameterSchema): Record<string, AgentiumSchema> {
  return "_zod" in schema ? schema._zod.def.shape : schema.shape;
}
