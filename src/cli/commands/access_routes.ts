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
export const ACCESS_ROUTES: readonly CommandRoute[] = [
  {
    name: "token",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/access_token.ts",
    needsFullTree: false,
    load: async (rest) =>
      (await import("./access_token.ts")).createAccessTokenCommand(rest),
  },
  {
    name: "integration",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/access_integration.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./access_integration.ts")).accessIntegrationCommand,
  },
  {
    name: "delegation",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/access_delegation.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./access_delegation.ts")).accessDelegationCommand,
  },
  {
    name: "grant",
    aliases: ["policy"],
    hidden: false,
    module: "src/cli/commands/access_grant.ts",
    needsFullTree: false,
    load: async () => (await import("./access_grant.ts")).accessGrantCommand,
  },
  {
    name: "group",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/access_group.ts",
    needsFullTree: false,
    load: async () => (await import("./access_group.ts")).accessGroupCommand,
  },
  {
    name: "can-i",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/access_can_i.ts",
    needsFullTree: false,
    load: async () => (await import("./access_can_i.ts")).accessCanICommand,
  },
  {
    name: "check",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/access_check.ts",
    needsFullTree: false,
    load: async () => (await import("./access_check.ts")).accessCheckCommand,
  },
  {
    name: "reload",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/access_reload.ts",
    needsFullTree: false,
    load: async () => (await import("./access_reload.ts")).accessReloadCommand,
  },
];

export const ACCESS_TOKEN_ROUTES: readonly CommandRoute[] = [
  {
    name: "mint",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/access_token_mint.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./access_token_mint.ts")).accessTokenMintCommand,
  },
  {
    name: "list",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/access_token_list.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./access_token_list.ts")).accessTokenListCommand,
  },
  {
    name: "reveal",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/access_token_reveal.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./access_token_reveal.ts")).accessTokenRevealCommand,
  },
  {
    name: "revoke",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/access_token_revoke.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./access_token_revoke.ts")).accessTokenRevokeCommand,
  },
  {
    name: "rotate",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/access_token_rotate.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./access_token_rotate.ts")).accessTokenRotateCommand,
  },
];
