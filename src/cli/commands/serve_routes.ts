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
export const SERVE_ROUTES: readonly CommandRoute[] = [
  {
    name: "reload",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/serve_reload.ts",
    needsFullTree: false,
    load: async () => (await import("./serve_reload.ts")).reloadCommand,
  },
  {
    name: "check-config",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/serve_check_config.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./serve_check_config.ts")).checkConfigCommand,
  },
  {
    name: "daemon",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/serve_daemon.ts",
    needsFullTree: false,
    load: async () => (await import("./serve_daemon.ts")).daemonCommand,
  },
];
