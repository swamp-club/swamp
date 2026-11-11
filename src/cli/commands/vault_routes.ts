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
export const VAULT_ROUTES: readonly CommandRoute[] = [
  {
    name: "type",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/vault_type.ts",
    needsFullTree: false,
    load: async () => (await import("./vault_type.ts")).vaultTypeCommand,
  },
  {
    name: "create",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/vault_create.ts",
    needsFullTree: false,
    load: async () => (await import("./vault_create.ts")).vaultCreateCommand,
  },
  {
    name: "search",
    aliases: ["list"],
    hidden: false,
    module: "src/cli/commands/vault_search.ts",
    needsFullTree: false,
    load: async () => (await import("./vault_search.ts")).vaultSearchCommand,
  },
  {
    name: "get",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/vault_get.ts",
    needsFullTree: false,
    load: async () => (await import("./vault_get.ts")).vaultGetCommand,
  },
  {
    name: "describe",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/vault_describe.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./vault_describe.ts")).vaultDescribeCommand,
  },
  {
    name: "edit",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/vault_edit.ts",
    needsFullTree: false,
    load: async () => (await import("./vault_edit.ts")).vaultEditCommand,
  },
  {
    name: "put",
    aliases: ["write-secret"],
    hidden: false,
    module: "src/cli/commands/vault_put.ts",
    needsFullTree: false,
    load: async () => (await import("./vault_put.ts")).vaultPutCommand,
  },
  {
    name: "delete",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/vault_delete.ts",
    needsFullTree: false,
    load: async () => (await import("./vault_delete.ts")).vaultDeleteCommand,
  },
  {
    name: "remove",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/vault_remove.ts",
    needsFullTree: false,
    load: async () => (await import("./vault_remove.ts")).vaultRemoveCommand,
  },
  {
    name: "annotate",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/vault_annotate.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./vault_annotate.ts")).vaultAnnotateCommand,
  },
  {
    name: "inspect",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/vault_inspect.ts",
    needsFullTree: false,
    load: async () => (await import("./vault_inspect.ts")).vaultInspectCommand,
  },
  {
    name: "migrate",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/vault_migrate.ts",
    needsFullTree: false,
    load: async () => (await import("./vault_migrate.ts")).vaultMigrateCommand,
  },
  {
    name: "read-secret",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/vault_read_secret.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./vault_read_secret.ts")).vaultReadSecretCommand,
  },
  {
    name: "list-keys",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/vault_list_keys.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./vault_list_keys.ts")).vaultListKeysCommand,
  },
  {
    name: "audit-trail",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/vault_audit_trail.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./vault_audit_trail.ts")).vaultAuditTrailCommand,
  },
];
