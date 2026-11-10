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

import type { CommandRoute } from "../command_routes.ts";

// each load is a literal import(): deno compile embeds only literal specifiers,
// and the order is the group help's listing order
export const DATA_ROUTES: readonly CommandRoute[] = [
  {
    name: "get",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/data_get.ts",
    needsFullTree: false,
    load: async () => (await import("./data_get.ts")).dataGetCommand,
  },
  {
    name: "list",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/data_list.ts",
    needsFullTree: false,
    load: async () => (await import("./data_list.ts")).dataListCommand,
  },
  {
    name: "search",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/data_search.ts",
    needsFullTree: false,
    load: async () => (await import("./data_search.ts")).dataSearchCommand,
  },
  {
    name: "query",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/data_query.ts",
    needsFullTree: false,
    load: async () => (await import("./data_query.ts")).dataQueryCommand,
  },
  {
    name: "versions",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/data_versions.ts",
    needsFullTree: false,
    load: async () => (await import("./data_versions.ts")).dataVersionsCommand,
  },
  {
    name: "gc",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/data_gc.ts",
    needsFullTree: false,
    load: async () => (await import("./data_gc.ts")).dataGcCommand,
  },
  {
    name: "prune",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/data_prune.ts",
    needsFullTree: false,
    load: async () => (await import("./data_prune.ts")).dataPruneCommand,
  },
  {
    name: "rename",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/data_rename.ts",
    needsFullTree: false,
    load: async () => (await import("./data_rename.ts")).dataRenameCommand,
  },
  {
    name: "delete",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/data_delete.ts",
    needsFullTree: false,
    load: async () => (await import("./data_delete.ts")).dataDeleteCommand,
  },
];
