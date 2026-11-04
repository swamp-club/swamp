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

import { join } from "@std/path";

const MISE_CONFIGS = [
  "mise.toml",
  ".mise.toml",
  "mise.local.toml",
  ".tool-versions",
];

/** the folder pins its tools with mise, so Bun runs through `mise exec` */
export async function usesMise(folder: string): Promise<boolean> {
  for (const name of MISE_CONFIGS) {
    try {
      if ((await Deno.stat(join(folder, name))).isFile) return true;
    } catch {
      // no such config here
    }
  }
  return false;
}

export interface AppCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** each way to run a script under Bun, in the order to try them */
export function bunCommands(
  mise: boolean,
  script: string,
  args: readonly string[],
): AppCommand[] {
  const direct = { command: "bun", args: [script, ...args] };
  return mise
    ? [
      { command: "mise", args: ["exec", "--", "bun", script, ...args] },
      direct,
    ]
    : [direct];
}

export function missingBunMessage(mise: boolean): string {
  return `swamp app needs Bun on your PATH${
    mise ? ", or mise to install the version it pins" : ""
  }. Install Bun, or run mise install in the app folder when it has a mise.toml.`;
}
