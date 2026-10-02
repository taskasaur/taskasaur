import { JSONRPCServer, type JSONRPCRequest } from "json-rpc-2.0";
import { CloudEvent } from "cloudevents";
import type { Principal } from "../plugin-sdk";
import { CoreError, invariant } from "./errors";
import { ZodError } from "zod";

export interface CommandContext {
  principal: Principal;
  signal: AbortSignal;
  mutationId?: string;
}
export interface Command {
  permission: string;
  validate(input: unknown): unknown;
  execute(input: unknown, context: CommandContext): Promise<unknown>;
}
export class MessageRouter {
  private commands = new Map<string, Command>();
  private rpc = new JSONRPCServer<CommandContext>();
  constructor() {
    this.rpc.mapErrorToJSONRPCErrorResponse = (id, error) => ({
      jsonrpc: "2.0",
      id,
      error: {
        code:
          error instanceof ZodError ||
          (error instanceof CoreError && error.kind === "VALIDATION_FAILED")
            ? -32602
            : -32000,
        message:
          error instanceof CoreError
            ? error.message
            : error instanceof ZodError
              ? "Command input does not match its declared contract"
              : "Command failed",
        data: {
          kind:
            error instanceof CoreError
              ? error.kind
              : error instanceof ZodError
                ? "VALIDATION_FAILED"
                : "INTERNAL_ERROR",
        },
      },
    });
  }
  register(id: string, command: Command) {
    invariant(
      !this.commands.has(id),
      "CONTRACT_COLLISION",
      `Command ${id} is already registered`,
    );
    this.commands.set(id, command);
    this.rpc.addMethod(id, async (input, context) => {
      invariant(
        context,
        "UNAUTHENTICATED",
        "Authenticated context is required",
      );
      invariant(
        context.principal.permissions.includes(command.permission),
        "PERMISSION_DENIED",
        `Missing ${command.permission}`,
      );
      return command.execute(command.validate(input), context);
    });
  }
  unregister(id: string) {
    this.commands.delete(id);
    this.rpc.removeMethod(id);
  }
  has(id: string) {
    return this.commands.has(id);
  }
  permissionFor(id: string) {
    return this.commands.get(id)?.permission;
  }
  async receive(request: unknown, context: CommandContext) {
    invariant(
      request && typeof request === "object" && !Array.isArray(request),
      "VALIDATION_FAILED",
      "Expected one JSON-RPC request",
    );
    const rpc = request as JSONRPCRequest;
    if (!this.commands.has(rpc.method))
      return {
        jsonrpc: "2.0",
        id: rpc.id ?? null,
        error: { code: -32601, message: "Method not found" },
      };
    const command = this.commands.get(rpc.method)!;
    try {
      invariant(
        rpc.jsonrpc === "2.0" && rpc.id !== undefined,
        "VALIDATION_FAILED",
        "Commands require JSON-RPC 2.0 and a request ID",
      );
      invariant(
        context.principal.permissions.includes(command.permission),
        "PERMISSION_DENIED",
        `Missing ${command.permission}`,
      );
      // Validate before the library handles errors, retaining stable Taskasaur error data.
      command.validate(rpc.params);
      return await this.rpc.receive(rpc, context);
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: rpc.id ?? null,
        error: {
          code:
            error instanceof ZodError ||
            (error instanceof CoreError && error.kind === "VALIDATION_FAILED")
              ? -32602
              : -32000,
          message:
            error instanceof CoreError
              ? error.message
              : error instanceof ZodError
                ? "Command input does not match its declared contract"
                : "Command failed",
          data: {
            kind:
              error instanceof CoreError
                ? error.kind
                : error instanceof ZodError
                  ? "VALIDATION_FAILED"
                  : "INTERNAL_ERROR",
          },
        },
      };
    }
  }
}
export function domainEvent(
  principal: Principal,
  type: string,
  resourceId: string,
  revision: number,
  data: unknown,
  operationId: string,
) {
  return new CloudEvent({
    id: operationId,
    source: `/plugins/${principal.pluginId}`,
    type: `taskasaur.${type}.v1`,
    subject: resourceId,
    datacontenttype: "application/json",
    data: {
      workspaceId: principal.workspaceId,
      resourceId,
      revision,
      value: data,
    },
  }).toJSON();
}
