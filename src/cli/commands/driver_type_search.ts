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
  driverTypeSearch,
  type DriverTypeSearchDeps,
} from "../../libswamp/mod.ts";
import { createDriverTypeSearchRenderer } from "../../presentation/renderers/driver_type_search.tsx";
import {
  createContext,
  type GlobalOptions,
  interactiveOutputMode,
} from "../context.ts";
import { getDriverTypes } from "../../domain/drivers/driver_types.ts";
import { driverTypeRegistry } from "../../domain/drivers/driver_type_registry.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export async function driverTypeSearchAction(
  options: AnyOptions,
  query?: string,
): Promise<void> {
  const ctx = createContext(options as GlobalOptions, [
    "driver",
    "type-search",
  ]);
  const effectiveMode = interactiveOutputMode(ctx);
  const libCtx = createLibSwampContext();
  ctx.logger.debug`Searching driver types with query: ${query ?? "(none)"}`;

  await driverTypeRegistry.ensureLoaded();

  const deps: DriverTypeSearchDeps = {
    getDriverTypes: () => getDriverTypes(),
  };

  const renderer = createDriverTypeSearchRenderer(effectiveMode);
  await consumeStream(
    driverTypeSearch(libCtx, deps, { query }),
    renderer.handlers(),
  );

  const selected = renderer.selectedItem();
  if (selected) {
    ctx.logger.debug`Selected driver type: ${selected.type}`;
    console.log(JSON.stringify(selected, null, 2));
  } else {
    ctx.logger.debug`Search cancelled`;
  }

  ctx.logger.debug("Driver type search command completed");
}

export const driverTypeSearchCommand = new Command()
  .name("search")
  .description("Search for driver types")
  .example("Browse driver types", "swamp driver type search")
  .example("Search by keyword", "swamp driver type search docker")
  .arguments("[query:string]")
  .action(driverTypeSearchAction);
