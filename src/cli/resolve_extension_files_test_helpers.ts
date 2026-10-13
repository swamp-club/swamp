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

import { parse } from "@std/path";
import type { ModuleGraphReader } from "../domain/extensions/extension_source_graph.ts";
import { resolveLocalImports } from "../domain/models/local_import_resolver.ts";

/**
 * An in-process stand-in for the `deno info` reader in resolver unit tests:
 * the files an entry point reaches through relative imports, without edges.
 * Real graphs are covered by deno_info_module_graph_reader_test.ts and the
 * integration tests.
 */
export const regexModuleGraphReader: ModuleGraphReader = {
  async read(entryPoint) {
    const { resolvedFiles } = await resolveLocalImports(
      [entryPoint],
      parse(entryPoint).root,
    );
    return {
      modules: resolvedFiles.map((path) => ({ path, kind: "code" as const })),
      edges: [],
      missing: [],
    };
  },
};
