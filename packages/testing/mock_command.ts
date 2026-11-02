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

export interface CapturedCommandCall {
  command: string;
  args: string[];
  timestamp: number;
  /**
   * The `env` option passed to `Deno.Command`, recorded verbatim (including
   * any secrets). Present only when the caller passed it.
   */
  env?: Record<string, string>;
  cwd?: string | URL;
  clearEnv?: boolean;
}

export interface MockCommandResult<T> {
  result: T;
  calls: CapturedCommandCall[];
}

export interface CommandOutput {
  stdout: string | Uint8Array;
  stderr?: string | Uint8Array;
  code: number;
}

export type CommandHandler = (
  command: string,
  args: string[],
) => CommandOutput | Promise<CommandOutput>;

/**
 * replaces Deno.Command with a mock, from a sequential CommandOutput array or a
 * handler; records every call, including env, cwd and clearEnv when passed, and
 * always restores the original, even if the callback throws.
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
      #env: Record<string, string> | undefined;
      #cwd: string | URL | undefined;
      #clearEnv: boolean | undefined;

      constructor(command: string | URL, options?: Deno.CommandOptions) {
        this.#command = command.toString();
        this.#args = options?.args ?? [];
        // Snapshot env so later mutation by the caller can't alter the record.
        this.#env = options?.env !== undefined ? { ...options.env } : undefined;
        this.#cwd = options?.cwd;
        this.#clearEnv = options?.clearEnv;
      }

      output(): Promise<Deno.CommandOutput> {
        // Only add option keys the caller passed: deep equality treats an
        // undefined-valued key as different from a missing one.
        const call: CapturedCommandCall = {
          command: this.#command,
          args: this.#args,
          timestamp: Date.now(),
        };
        if (this.#env !== undefined) call.env = { ...this.#env };
        if (this.#cwd !== undefined) call.cwd = this.#cwd;
        if (this.#clearEnv !== undefined) call.clearEnv = this.#clearEnv;
        calls.push(call);

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
