declare module "hot-formula-parser" {
  export class Parser {
    on(event: string, callback: (...args: any[]) => void): void;
    parse(formula: string): { error: string | null; result: any };
  }
}
