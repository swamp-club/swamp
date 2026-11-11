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
export const EXTENSION_ROUTES: readonly CommandRoute[] = [
  {
    name: "push",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/extension_push.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./extension_push.ts")).extensionPushCommand,
  },
  {
    name: "info",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/extension_info.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./extension_info.ts")).extensionInfoCommand,
  },
  {
    name: "fmt",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/extension_fmt.ts",
    needsFullTree: false,
    load: async () => (await import("./extension_fmt.ts")).extensionFmtCommand,
  },
  {
    name: "quality",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/extension_quality.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./extension_quality.ts")).extensionQualityCommand,
  },
  {
    name: "pull",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/extension_pull.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./extension_pull.ts")).extensionPullCommand,
  },
  {
    name: "install",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/extension_install.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./extension_install.ts")).extensionInstallCommand,
  },
  {
    name: "rm",
    aliases: ["remove"],
    hidden: false,
    module: "src/cli/commands/extension_rm.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./extension_rm.ts")).extensionRemoveCommand,
  },
  {
    name: "list",
    aliases: ["ls"],
    hidden: false,
    module: "src/cli/commands/extension_list.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./extension_list.ts")).extensionListCommand,
  },
  {
    name: "search",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/extension_search.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./extension_search.ts")).extensionSearchCommand,
  },
  {
    name: "update",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/extension_update.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./extension_update.ts")).extensionUpdateCommand,
  },
  {
    name: "outdated",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/extension_outdated.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./extension_outdated.ts")).extensionOutdatedCommand,
  },
  {
    name: "version",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/extension_version.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./extension_version.ts")).extensionVersionCommand,
  },
  {
    name: "yank",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/extension_yank.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./extension_yank.ts")).extensionYankCommand,
  },
  {
    name: "unyank",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/extension_unyank.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./extension_unyank.ts")).extensionUnyankCommand,
  },
  {
    name: "deprecate",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/extension_deprecate.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./extension_deprecate.ts")).extensionDeprecateCommand,
  },
  {
    name: "undeprecate",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/extension_undeprecate.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./extension_undeprecate.ts")).extensionUndeprecateCommand,
  },
  {
    name: "trust",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/extension_trust.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./extension_trust.ts")).extensionTrustCommand,
  },
  {
    name: "source",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/extension_source.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./extension_source.ts")).extensionSourceCommand,
  },
  {
    name: "promote",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/extension_promote.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./extension_promote.ts")).extensionPromoteCommand,
  },
  {
    name: "visibility",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/extension_visibility.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./extension_visibility.ts")).extensionVisibilityCommand,
  },
];
