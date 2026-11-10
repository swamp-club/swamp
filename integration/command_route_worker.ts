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

// a fresh module graph per route, so a cycle entered from a new side shows up

import { type AnyCommand, buildCliSchema } from "../src/cli/cli_schema.ts";
import { VERSION } from "../src/infrastructure/runtime/build_info.ts";

export interface RouteWorkerRequest {
  /** undefined builds the full tree */
  args?: string[];
  path: string[];
}

export type RouteWorkerResponse =
  | { ok: true; schema: string | null }
  | { ok: false; error: string };

declare const self: Worker;

interface CliEntry {
  buildCommandTree(args?: string[]): Promise<AnyCommand>;
}

// specifiers held in variables: the worker type library has no window globals
// such as prompt, which the CLI graph uses, so it must not be type-checked here
const entryPoint = new URL("../main.ts", import.meta.url).href;
const compositionRoot = new URL("../src/cli/mod.ts", import.meta.url).href;
async function loadCli(): Promise<CliEntry> {
  await import(entryPoint);
  return await import(compositionRoot) as CliEntry;
}

// started before the handler is set, so no message waits on it unheard; a
// failure surfaces in the handler that awaits it
const cli = loadCli();
cli.catch(() => {});

function resolvePath(root: AnyCommand, path: string[]): AnyCommand | undefined {
  let current: AnyCommand | undefined = root;
  for (const word of path) current = current?.getCommand(word, true);
  return current;
}

self.onmessage = async (event: MessageEvent<RouteWorkerRequest>) => {
  const { args, path } = event.data;
  let response: RouteWorkerResponse;
  try {
    const { buildCommandTree } = await cli;
    const node = resolvePath(await buildCommandTree(args), path);
    response = {
      ok: true,
      schema: node === undefined ? null : JSON.stringify(
        buildCliSchema(node, VERSION, {
          stripGlobalOptions: path.length > 0,
          includeHidden: true,
        }),
      ),
    };
  } catch (error) {
    response = {
      ok: false,
      error: error instanceof Error
        ? (error.stack ?? error.message)
        : String(error),
    };
  }
  self.postMessage(response);
};
