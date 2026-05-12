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

import { Command } from "@cliffy/command";
import {
  consumeStream,
  createLibSwampContext,
  datastoreTypeSearch,
  type DatastoreTypeSearchDeps,
} from "../../libswamp/mod.ts";
import { createDatastoreTypeSearchRenderer } from "../../presentation/renderers/datastore_type_search.tsx";
import {
  createContext,
  type GlobalOptions,
  interactiveOutputMode,
} from "../context.ts";
import { getDatastoreTypes } from "../../domain/datastore/datastore_types.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export async function datastoreTypeSearchAction(
  options: AnyOptions,
  query?: string,
): Promise<void> {
  const ctx = createContext(options as GlobalOptions, [
    "datastore",
    "type-search",
  ]);
  const effectiveMode = interactiveOutputMode(ctx);
  const libCtx = createLibSwampContext();
  ctx.logger.debug`Searching datastore types with query: ${query ?? "(none)"}`;

  await datastoreTypeRegistry.ensureLoaded();

  const deps: DatastoreTypeSearchDeps = {
    getDatastoreTypes: () => getDatastoreTypes(),
  };

  const renderer = createDatastoreTypeSearchRenderer(effectiveMode);
  await consumeStream(
    datastoreTypeSearch(libCtx, deps, { query }),
    renderer.handlers(),
  );

  const selected = renderer.selectedItem();
  if (selected) {
    ctx.logger.debug`Selected datastore type: ${selected.type}`;
    console.log(JSON.stringify(selected, null, 2));
  } else {
    ctx.logger.debug`Search cancelled`;
  }

  ctx.logger.debug("Datastore type search command completed");
}

export const datastoreTypeSearchCommand = new Command()
  .name("search")
  .description("Search for datastore types")
  .example("Browse datastore types", "swamp datastore type search")
  .example("Search by keyword", "swamp datastore type search s3")
  .arguments("[query:string]")
  .action(datastoreTypeSearchAction);
