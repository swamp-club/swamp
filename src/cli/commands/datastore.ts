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
import { groupCommandAction } from "../group_action.ts";
import { datastoreStatusCommand } from "./datastore_status.ts";
import { datastoreSetupCommand } from "./datastore_setup.ts";
import { datastoreSyncCommand } from "./datastore_sync.ts";
import { datastoreLockCommand } from "./datastore_lock.ts";
import { datastoreCompactCommand } from "./datastore_compact.ts";
import { datastoreCatalogPullCommand } from "./datastore_catalog_pull.ts";
import {
  datastoreNamespaceSetCommand,
  datastoreNamespaceUnsetCommand,
} from "./datastore_namespace.ts";
import { datastoreNamespacesCommand } from "./datastore_namespaces.ts";
import {
  datastoreTypeSearchAction,
  datastoreTypeSearchCommand,
} from "./datastore_type_search.ts";
import { unknownCommandErrorHandler } from "../unknown_command_handler.ts";

export const datastoreTypeCommand = new Command()
  .name("type")
  .description("Inspect datastore types")
  .action(groupCommandAction)
  .command("search", datastoreTypeSearchCommand)
  .command(
    "list",
    new Command()
      .description("Alias for datastore type search")
      .hidden()
      .arguments("[query:string]")
      .action(datastoreTypeSearchAction),
  );

const datastoreCatalogCommand = new Command()
  .name("catalog")
  .description("Manage datastore catalog")
  .action(groupCommandAction)
  .command("pull", datastoreCatalogPullCommand);

const datastoreNamespaceCommand = new Command()
  .name("namespace")
  .description("Manage datastore namespace")
  .action(groupCommandAction)
  .command("set", datastoreNamespaceSetCommand)
  .command("unset", datastoreNamespaceUnsetCommand)
  .command("list", datastoreNamespacesCommand);

export const datastoreCommand = new Command()
  .description("Manage datastore configuration")
  .error(unknownCommandErrorHandler)
  .action(groupCommandAction)
  .command("type", datastoreTypeCommand)
  .command("status", datastoreStatusCommand)
  .command("setup", datastoreSetupCommand)
  .command("sync", datastoreSyncCommand)
  .command("lock", datastoreLockCommand)
  .command("compact", datastoreCompactCommand)
  .command("catalog", datastoreCatalogCommand)
  .command("namespace", datastoreNamespaceCommand);
