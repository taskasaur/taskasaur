import ts from "typescript";
self.onmessage = async (
  event: MessageEvent<{ source: string; input: unknown }>,
) => {
  try {
    const { source, input } = event.data;
    if (source.length > 50000) throw Error("Code node exceeds 50 KB");
    const text = `async function main(input: unknown) {\n${source}\n}`;
    const syntax = ts.createSourceFile(
      "workflow.ts",
      text,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    const inspect = (node: ts.Node) => {
      if (
        ts.isImportDeclaration(node) ||
        ts.isImportEqualsDeclaration(node) ||
        (ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword)
      )
        throw Error("Code nodes cannot import modules");
      ts.forEachChild(node, inspect);
    };
    inspect(syntax);
    const compiled = ts.transpileModule(text, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.None,
      },
      reportDiagnostics: true,
    });
    if (
      compiled.diagnostics?.some(
        (d) => d.category === ts.DiagnosticCategory.Error,
      )
    )
      throw Error("Invalid TypeScript source");
    const value = await new Function(compiled.outputText + "\nreturn main;")()(
      input,
    );
    const json = JSON.stringify(value ?? null);
    if (json.length > 1024 * 1024) throw Error("Code output exceeds 1 MB");
    self.postMessage({ value: JSON.parse(json) });
  } catch (error) {
    self.postMessage({
      error:
        error instanceof Error ? error.message : "TypeScript execution failed",
    });
  }
};
