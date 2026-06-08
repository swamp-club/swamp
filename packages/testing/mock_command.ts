// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

/** A recorded command execution for inspection. */
export interface CapturedCommandCall {
  command: string;
  args: string[];
  timestamp: number;
}

/** Result from withMockedCommand — includes the callback result and captured calls. */
export interface MockCommandResult<T> {
  result: T;
  calls: CapturedCommandCall[];
}

/** The output shape returned by a command handler. */
export interface CommandOutput {
  stdout: string | Uint8Array;
  stderr?: string | Uint8Array;
  code: number;
}

/**
 * A command handler that receives the command name and args, returns output.
 * Can be async.
 */
export type CommandHandler = (
  command: string,
  args: string[],
) => CommandOutput | Promise<CommandOutput>;

/**
 * Runs a callback with `Deno.Command` replaced by a mock.
 *
 * The mock can be:
 * - A **CommandOutput array** — outputs are returned sequentially, one per command
 * - A **handler function** — receives the command and args, returns output
 *
 * All command executions are recorded and returned for inspection.
 * The original `Deno.Command` is always restored, even if the callback throws.
 *
 * **Simple mode** — sequential responses:
 * ```typescript
 * import { withMockedCommand } from "@swamp-club/swamp-testing";
 *
 * const { result, calls } = await withMockedCommand([
 *   { stdout: "sk-test-123", code: 0 },
 * ], async () => {
 *   const provider = vault.createProvider("test", { op_vault: "Eng" });
 *   return await provider.get("api-key");
 * });
 *
 * assertEquals(result, "sk-test-123");
 * assertEquals(calls[0].command, "op");
 * ```
 *
 * **Handler mode** — dynamic responses:
 * ```typescript
 * const { calls } = await withMockedCommand((cmd, args) => {
 *   if (cmd === "op" && args.includes("read")) {
 *     return { stdout: "sk-test-123", code: 0 };
 *   }
 *   return { stderr: "not found", code: 1 };
 * }, async () => {
 *   const provider = vault.createProvider("test", { op_vault: "Eng" });
 *   await assertVaultConformance(provider);
 * });
 * ```
 */
export async function withMockedCommand<T>(
  handlerOrOutputs: CommandHandler | CommandOutput[],
  fn: () => T | Promise<T>,
): Promise<MockCommandResult<T>> {
  const calls: CapturedCommandCall[] = [];
  let callIndex = 0;

  const isSequential = Array.isArray(handlerOrOutputs);
  const outputs = isSequential ? handlerOrOutputs : null;
  const handler = isSequential ? null : handlerOrOutputs;

  const OriginalCommand = Deno.Command;

  function toBytes(value: string | Uint8Array | undefined): Uint8Array {
    if (value === undefined) return new Uint8Array();
    if (value instanceof Uint8Array) return value;
    return new TextEncoder().encode(value);
  }

  Object.defineProperty(Deno, "Command", {
    value: class MockCommand {
      #command: string;
      #args: string[];

      constructor(
        command: string | URL,
        options?: { args?: string[]; [key: string]: unknown },
      ) {
        this.#command = command.toString();
        this.#args = (options?.args as string[]) ?? [];
      }

      output(): Promise<Deno.CommandOutput> {
        calls.push({
          command: this.#command,
          args: this.#args,
          timestamp: Date.now(),
        });

        const getOutput = async (): Promise<CommandOutput> => {
          if (outputs) {
            if (callIndex >= outputs.length) {
              throw new Error(
                `withMockedCommand: no more outputs (got ${
                  callIndex + 1
                } calls, ` +
                  `only ${outputs.length} outputs queued). ` +
                  `Last call: ${this.#command} ${this.#args.join(" ")}`,
              );
            }
            return outputs[callIndex++];
          }
          return await handler!(this.#command, this.#args);
        };

        return getOutput().then((out) => ({
          code: out.code,
          signal: null,
          success: out.code === 0,
          stdout: toBytes(out.stdout),
          stderr: toBytes(out.stderr),
        })) as Promise<Deno.CommandOutput>;
      }

      spawn(): Deno.ChildProcess {
        throw new Error(
          "withMockedCommand: spawn() is not supported in mock mode. " +
            "Use output() instead.",
        );
      }

      outputSync(): Deno.CommandOutput {
        throw new Error(
          "withMockedCommand: outputSync() is not supported in mock mode. " +
            "Use output() instead.",
        );
      }
    },
    configurable: true,
    writable: true,
  });

  try {
    const result = await fn();
    return { result, calls };
  } finally {
    Object.defineProperty(Deno, "Command", {
      value: OriginalCommand,
      configurable: true,
      writable: true,
    });
  }
}
