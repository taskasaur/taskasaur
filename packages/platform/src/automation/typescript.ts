import ts from "typescript";
import { createHash } from "node:crypto";
import { invariant, CoreError } from "../core/errors";
const cache = new Map<string, string>();
export function compileTypeScript(source: string) {
  invariant(
    source.length <= 50000,
    "PAYLOAD_TOO_LARGE",
    "Code node exceeds 50 KB",
  );
  const hash = createHash("sha256").update(source).digest("hex"),
    existing = cache.get(hash);
  if (existing) return existing;
  const filename = "/taskasaur-workflow-node.ts",
    text = `async function main(input: unknown) {\n${source}\n}\nexport {};`,
    syntax = ts.createSourceFile(
      filename,
      text,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
  function inspect(node: ts.Node) {
    invariant(
      !ts.isImportDeclaration(node) &&
        !ts.isImportEqualsDeclaration(node) &&
        !(ts.isExportDeclaration(node) && node.moduleSpecifier) &&
        !(
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword
        ),
      "IMPORT_NOT_ALLOWED",
      "Code nodes cannot import modules",
    );
    ts.forEachChild(node, inspect);
  }
  inspect(syntax);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    strict: true,
    types: [],
    lib: ["lib.es2022.d.ts"],
    skipLibCheck: true,
    noEmitOnError: true,
  };
  const host = ts.createCompilerHost(options),
    originalRead = host.readFile.bind(host),
    originalExists = host.fileExists.bind(host);
  host.readFile = (file) => (file === filename ? text : originalRead(file));
  host.fileExists = (file) => file === filename || originalExists(file);
  const program = ts.createProgram([filename], options, host),
    errors = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length)
    throw new CoreError(
      "TYPESCRIPT_TYPE_ERROR",
      errors
        .slice(0, 5)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "))
        .join("; "),
    );
  let output = "";
  program.emit(undefined, (name, content) => {
    if (name.endsWith(".js")) output = content;
  });
  invariant(output, "TYPESCRIPT_TYPE_ERROR", "Code could not be compiled");
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(hash, output);
  return output;
}
