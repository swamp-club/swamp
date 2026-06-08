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

import { Command } from "@cliffy/command";
import {
  consumeStream,
  createCreekTypeSearchDeps,
  createLibSwampContext,
  creekTypeSearch,
} from "../../libswamp/mod.ts";
import { createCreekTypeSearchRenderer } from "../../presentation/renderers/creek_type_search.ts";
import { createContext, type GlobalOptions } from "../context.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export async function creekTypeSearchAction(
  options: AnyOptions,
  query?: string,
): Promise<void> {
  const ctx = createContext(options as GlobalOptions, [
    "creek",
    "type-search",
  ]);
  const libCtx = createLibSwampContext();
  const deps = await createCreekTypeSearchDeps();
  const renderer = createCreekTypeSearchRenderer(ctx.outputMode);
  await consumeStream(
    creekTypeSearch(libCtx, deps, { query }),
    renderer.handlers(),
  );
}

export const creekTypeSearchCommand = new Command()
  .name("search")
  .description("Search registered creek types")
  .arguments("[query:string]")
  .example("List every creek", "swamp creek type search")
  .example("Filter by keyword", "swamp creek type search jira")
  .action(creekTypeSearchAction);
