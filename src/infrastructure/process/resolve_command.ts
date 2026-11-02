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

export interface CommandResolver {
  resolve(name: string): Promise<string | null>;
}

export interface CommandLookupResult {
  success: boolean;
  stdout: Uint8Array;
}

export type CommandLookupRunner = (
  tool: string,
  name: string,
) => Promise<CommandLookupResult>;

const defaultLookupRunner: CommandLookupRunner = async (tool, name) => {
  try {
    const cmd = new Deno.Command(tool, {
      args: [name],
      stdout: "piped",
      stderr: "piped",
      cwd: safeCwd(),
    });
    const output = await cmd.output();
    return { success: output.success, stdout: output.stdout };
  } catch {
    // Underlying lookup tool itself is missing (e.g. `which` not on PATH).
    return { success: false, stdout: new Uint8Array() };
  }
};

/**
 * falls back to the OS temp dir or root if the working directory is
 * inaccessible, e.g. via sudo -u from another user's restricted home
 */
function safeCwd(): string {
  try {
    Deno.cwd();
    return Deno.cwd();
  } catch {
    return Deno.env.get("TMPDIR") ?? Deno.env.get("TMP") ?? "/";
  }
}

function lookupTool(): "which" | "where" {
  return Deno.build.os === "windows" ? "where" : "which";
}

/**
 * takes the first match deliberately, mirroring the one-shot semantics of
 * which, though where (and which -a) can list several
 */
function parseFirstLine(stdout: Uint8Array): string | null {
  const text = new TextDecoder().decode(stdout);
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

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
