import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { commonJsDeclaration, writeCommonJsDeclarations } from "./cjs-declarations.mjs";

test("rewrites only local module specifiers in CJS declarations", () => {
  const source = `import type { A } from "./a.js";
export { B } from '../b.js';
export type C = import("./c.js").C;
import D = require("./d.js");
import type { SDK } from "external-sdk";
export type Name = "./keep.js";
/** Keep this example: import("./example.js") */
`;
  const actual = commonJsDeclaration(source);
  for (const name of ["./a.cjs", "../b.cjs", "./c.cjs", "./d.cjs"]) assert.ok(actual.includes(name));
  assert.ok(actual.includes('from "external-sdk"'));
  assert.ok(actual.includes('Name = "./keep.js"'));
  assert.ok(actual.includes('import("./example.js")'));
});

test("emits a full CJS type graph without changing ESM declarations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentium-cjs-types-"));
  try {
    await mkdir(join(directory, "cost"));
    const original = 'export type { Cost } from "./cost/types.js";\n';
    await writeFile(join(directory, "index.d.ts"), original);
    await writeFile(join(directory, "cost/types.d.ts"), "export interface Cost { total: string | null }\n");
    assert.equal(await writeCommonJsDeclarations(directory), 2);
    assert.equal(await readFile(join(directory, "index.d.ts"), "utf8"), original);
    assert.equal(await readFile(join(directory, "index.d.cts"), "utf8"), original.replace("types.js", "types.cjs"));
    assert.match(await readFile(join(directory, "cost/types.d.cts"), "utf8"), /interface Cost/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("every workspace exposes distinct ESM and CommonJS declaration conditions", async () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  for (const workspace of manifest.workspaces) {
    const pkg = JSON.parse(await readFile(join(root, workspace, "package.json"), "utf8"));
    for (const [name, entry] of Object.entries(pkg.exports ?? {})) {
      if (typeof entry !== "object" || !entry.require) continue;
      assert.match(entry.import.types, /\.d\.ts$/, `${pkg.name}${name}: ESM types`);
      assert.match(entry.require.types, /\.d\.cts$/, `${pkg.name}${name}: CJS types`);
    }
    assert.match(pkg.scripts.build, /cjs-declarations\.mjs/, `${pkg.name}: declaration build`);
  }
});
