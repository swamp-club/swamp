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
export const DATASTORE_ROUTES: readonly CommandRoute[] = [
  {
    name: "type",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/datastore_type.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./datastore_type.ts")).datastoreTypeCommand,
  },
  {
    name: "status",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/datastore_status.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./datastore_status.ts")).datastoreStatusCommand,
  },
  {
    name: "setup",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/datastore_setup.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./datastore_setup.ts")).datastoreSetupCommand,
  },
  {
    name: "sync",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/datastore_sync.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./datastore_sync.ts")).datastoreSyncCommand,
  },
  {
    name: "lock",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/datastore_lock.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./datastore_lock.ts")).datastoreLockCommand,
  },
  {
    name: "quarantine",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/datastore_quarantine.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./datastore_quarantine.ts")).datastoreQuarantineCommand,
  },
  {
    name: "compact",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/datastore_compact.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./datastore_compact.ts")).datastoreCompactCommand,
  },
  {
    name: "gc",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/datastore_gc.ts",
    needsFullTree: false,
    load: async () => (await import("./datastore_gc.ts")).datastoreGcCommand,
  },
  {
    name: "claim",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/datastore_claim.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./datastore_claim.ts")).datastoreClaimCommand,
  },
  {
    name: "release",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/datastore_release.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./datastore_release.ts")).datastoreReleaseCommand,
  },
  {
    name: "migrate-index",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/datastore_migrate_index.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./datastore_migrate_index.ts"))
        .datastoreMigrateIndexCommand,
  },
  {
    name: "catalog",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/datastore_catalog.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./datastore_catalog.ts")).datastoreCatalogCommand,
  },
  {
    name: "namespace",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/datastore_namespace_group.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./datastore_namespace_group.ts"))
        .datastoreNamespaceCommand,
  },
  {
    name: "config",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/datastore_config.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./datastore_config.ts")).datastoreConfigCommand,
  },
];
