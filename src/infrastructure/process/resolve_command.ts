// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

/**
 * Cross-platform PATH resolver. On POSIX uses `which`; on Windows uses `where`.
 *
 * Returns the absolute path of the first match, or `null` when the binary is
 * not on PATH (or the underlying lookup tool itself is missing). Callers that
 * want to surface a specific error should wrap the `null` result.
 */
export interface CommandResolver {
  resolve(name: string): Promise<string | null>;
}

/**
 * The result of running a PATH-lookup process. The default resolver wraps
 * `Deno.Command(...).output()`; tests inject a fake to exercise the parser
 * without spawning a subprocess.
 */
export interface CommandLookupResult {
  /** Whether the lookup process exited with code 0. */
  success: boolean;
  /** Captured stdout bytes from the lookup process. */
  stdout: Uint8Array;
}

/**
 * Function shape that runs the platform-native lookup tool (`which` / `where`)
 * and returns its stdout. Exposed so unit tests can inject deterministic
 * multi-line output without relying on the host's PATH.
 */
export type CommandLookupRunner = (
  tool: string,
  name: string,
) => Promise<CommandLookupResult>;

/** Default runner — actually spawns `which` or `where`. */
const defaultLookupRunner: CommandLookupRunner = async (tool, name) => {
  try {
    const cmd = new Deno.Command(tool, {
      args: [name],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    return { success: output.success, stdout: output.stdout };
  } catch {
    // Underlying lookup tool itself is missing (e.g. `which` not on PATH).
    return { success: false, stdout: new Uint8Array() };
  }
};

/** Picks the platform-appropriate lookup tool name. */
function lookupTool(): "which" | "where" {
  return Deno.build.os === "windows" ? "where" : "which";
}

/**
 * Parses `which`/`where` stdout: returns the first non-empty trimmed line, or
 * `null` if there is none. `where` returns multiple matches separated by
 * newlines on Windows; `which -a` does the same on POSIX. We deliberately take
 * the first match, mirroring the long-standing one-shot semantics of `which`.
 */
function parseFirstLine(stdout: Uint8Array): string | null {
  const text = new TextDecoder().decode(stdout);
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

/**
 * The default cross-platform command resolver. Use this everywhere instead of
 * spawning `which`/`where` inline.
 */
export function defaultCommandResolver(
  runner: CommandLookupRunner = defaultLookupRunner,
): CommandResolver {
  return {
    async resolve(name: string): Promise<string | null> {
      const result = await runner(lookupTool(), name);
      if (!result.success) return null;
      return parseFirstLine(result.stdout);
    },
  };
}
