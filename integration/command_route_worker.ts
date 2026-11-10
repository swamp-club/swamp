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

import type { ErrorHandler } from "@cliffy/command";
import { type AnyCommand, buildCliSchema } from "../src/cli/cli_schema.ts";
import { VERSION } from "../src/infrastructure/runtime/build_info.ts";
import { completionOwnersUnder } from "./command_completion_helpers.ts";

export interface RouteWorkerRequest {
  /** undefined builds the full tree */
  args?: string[];
  path: string[];
}

export type RouteWorkerResponse =
  | {
    ok: true;
    schema: string | null;
    /** for every command path at and under the requested one */
    errorHandlers: Record<string, string>;
    /** for the requested path and every visible command path under it */
    completionOwners: Record<string, Record<string, string>>;
  }
  | { ok: false; error: string };

declare const self: Worker;

interface CliEntry {
  buildCommandTree(args?: string[]): Promise<AnyCommand>;
}

interface ErrorHandlerEntry {
  unknownCommandErrorHandler: ErrorHandler;
}

// specifiers held in variables: the worker type library has no window globals
// such as prompt, which the CLI graph uses, so it must not be type-checked here
const entryPoint = new URL("../main.ts", import.meta.url).href;
const compositionRoot = new URL("../src/cli/mod.ts", import.meta.url).href;
const errorHandlerModule =
  new URL("../src/cli/unknown_command_handler.ts", import.meta.url).href;
async function loadCli(): Promise<CliEntry & ErrorHandlerEntry> {
  await import(entryPoint);
  const { buildCommandTree } = await import(compositionRoot) as CliEntry;
  const { unknownCommandErrorHandler } = await import(
    errorHandlerModule
  ) as ErrorHandlerEntry;
  return { buildCommandTree, unknownCommandErrorHandler };
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

// Cliffy asks only the command and its parent, so a command shared between two
// parents answers with whichever parent registered it last
function errorHandlers(
  node: AnyCommand,
  path: string[],
): Record<string, string> {
  const found: Record<string, string> = {};
  const visit = (command: AnyCommand, at: string[]) => {
    const handler = command.settings.errorHandler ??
      command.getParent()?.settings.errorHandler;
    found[at.join(" ")] = handler === undefined ? "none" : handler.name;
    for (const child of command.getCommands(true)) {
      visit(child, [...at, child.getName()]);
    }
  };
  visit(node, path);
  return found;
}

self.onmessage = async (event: MessageEvent<RouteWorkerRequest>) => {
  const { args, path } = event.data;
  let response: RouteWorkerResponse;
  try {
    const { buildCommandTree, unknownCommandErrorHandler } = await cli;
    // the handler runInvocation gives its root; buildCommandTree's has none
    // reset() first: Cliffy applies a setting to the last registered command
    const tree = (await buildCommandTree(args)).reset().error(
      unknownCommandErrorHandler,
    );
    const node = resolvePath(tree, path);
    response = {
      ok: true,
      errorHandlers: node === undefined ? {} : errorHandlers(node, path),
      completionOwners: node === undefined
        ? {}
        : completionOwnersUnder(node, path),
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
