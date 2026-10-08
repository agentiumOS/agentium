import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** Keep the CJS declaration graph separate from the ESM graph, including relative type imports. */
export function commonJsDeclaration(source, filename = "index.d.ts") {
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const edits = [];
  const add = (literal) => {
    if (!literal || !ts.isStringLiteral(literal) || !literal.text.startsWith(".")) return;
    const replacement = literal.text.replace(/\.js$/, ".cjs").replace(/\.d\.ts$/, ".d.cts");
    if (replacement !== literal.text)
      edits.push({ start: literal.getStart(tree) + 1, end: literal.end - 1, text: replacement });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    if (ts.isExternalModuleReference(node)) add(node.expression);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  for (const edit of edits.sort((a, b) => b.start - a.start))
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return source;
}

export async function writeCommonJsDeclarations(directory) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) count += await writeCommonJsDeclarations(path);
    else if (entry.isFile() && entry.name.endsWith(".d.ts")) {
      const source = await readFile(path, "utf8");
      await writeFile(path.replace(/\.d\.ts$/, ".d.cts"), commonJsDeclaration(source, path));
      count++;
    }
  }
  return count;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.argv[2] ?? "dist");
  const count = await writeCommonJsDeclarations(directory);
  console.log(`Generated ${count} CommonJS declarations.`);
}
