export class CoreError extends Error {
  constructor(
    public readonly kind: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "CoreError";
  }
}
export function invariant(
  condition: unknown,
  kind: string,
  message: string,
): asserts condition {
  if (!condition) throw new CoreError(kind, message);
}
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
