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

import type { AnyCommand } from "../src/cli/cli_schema.ts";

/** Cliffy's complete walks down through visible commands only */
export function walkVisible(
  root: AnyCommand,
  names: readonly string[],
): AnyCommand | undefined {
  let current: AnyCommand | undefined = root;
  for (const name of names) current = current?.getCommand(name, false);
  return current;
}

function completionNames(node: AnyCommand): string[] {
  return [...new Set(node.getCompletions().map((c) => c.name))].sort();
}

/**
 * each completion name the node answers, mapped to "self" or the path of the
 * ancestor holding it: a command shared between two parents has an unstable path
 */
export function completionOwners(node: AnyCommand): Record<string, string> {
  const owners: Record<string, string> = {};
  for (const name of completionNames(node)) {
    if (node.getBaseCompletion(name)) {
      owners[name] = "self";
      continue;
    }
    let owner = "none";
    for (
      let parent = node.getParent();
      owner === "none" && parent !== undefined;
      parent = parent.getParent()
    ) {
      if (parent.getBaseCompletion(name)?.global) owner = parent.getPath();
    }
    owners[name] = owner;
  }
  return owners;
}

export function completionOwnersUnder(
  node: AnyCommand,
  path: readonly string[],
): Record<string, Record<string, string>> {
  const found: Record<string, Record<string, string>> = {};
  const visit = (command: AnyCommand, at: readonly string[]) => {
    found[at.join(" ")] = completionOwners(command);
    for (const child of command.getBaseCommands(false)) {
      visit(child, [...at, child.getName()]);
    }
  };
  visit(node, path);
  return found;
}

/** parent is the command before node in the walk, as Cliffy's complete passes it */
export async function completionValues(
  node: AnyCommand,
  parent: AnyCommand | undefined,
): Promise<Record<string, string[]>> {
  const values: Record<string, string[]> = {};
  for (const name of completionNames(node)) {
    const result = await node.getCompletion(name)?.complete(node, parent);
    values[name] = (result ?? []).map(String);
  }
  return values;
}

export async function completionValuesUnder(
  node: AnyCommand,
  path: readonly string[],
  parent: AnyCommand | undefined,
): Promise<Record<string, Record<string, string[]>>> {
  const found: Record<string, Record<string, string[]>> = {};
  const visit = async (
    command: AnyCommand,
    at: readonly string[],
    above: AnyCommand | undefined,
  ) => {
    found[at.join(" ")] = await completionValues(command, above);
    for (const child of command.getBaseCommands(false)) {
      await visit(child, [...at, child.getName()], command);
    }
  };
  await visit(node, path, parent);
  return found;
}
