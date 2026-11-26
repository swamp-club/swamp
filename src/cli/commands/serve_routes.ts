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
import { isServeFederationEnabled } from "../../domain/serve/federation_gate.ts";

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
  {
    name: "host",
    aliases: [],
    hidden: true,
    module: "src/cli/commands/serve_host.ts",
    needsFullTree: false,
    load: async () => (await import("./serve_host.ts")).serveHostCommand,
  },
  {
    name: "provision-workspace",
    aliases: [],
    hidden: true,
    module: "src/cli/commands/serve_provision_workspace.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./serve_provision_workspace.ts"))
        .serveProvisionWorkspaceCommand,
  },
  {
    name: "workspace",
    aliases: [],
    hidden: true,
    module: "src/cli/commands/serve_workspace.ts",
    needsFullTree: false,
    load: async (rest) =>
      (await import("./serve_workspace.ts")).createServeWorkspaceCommand(rest),
  },
];

/** registered only with the federation gate on */
export const SERVE_FEDERATION_ROUTES: readonly CommandRoute[] = [
  {
    name: "fingerprint",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/serve_fingerprint.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./serve_fingerprint.ts")).serveFingerprintCommand,
  },
  {
    name: "member",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/serve_member.ts",
    needsFullTree: false,
    load: async () => (await import("./serve_member.ts")).serveMemberCommand,
  },
];

export function resolveServeRoutes(
  env: (name: string) => string | undefined,
): readonly CommandRoute[] {
  return isServeFederationEnabled(env)
    ? [...SERVE_ROUTES, ...SERVE_FEDERATION_ROUTES]
    : SERVE_ROUTES;
}

export const SERVE_WORKSPACE_ROUTES: readonly CommandRoute[] = [
  {
    name: "create",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/serve_workspace_create.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./serve_workspace_create.ts")).serveWorkspaceCreateCommand,
  },
  {
    name: "list",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/serve_workspace_list.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./serve_workspace_list.ts")).serveWorkspaceListCommand,
  },
  {
    name: "get",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/serve_workspace_get.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./serve_workspace_get.ts")).serveWorkspaceGetCommand,
  },
  {
    name: "suspend",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/serve_workspace_suspend.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./serve_workspace_suspend.ts"))
        .serveWorkspaceSuspendCommand,
  },
  {
    name: "resume",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/serve_workspace_resume.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./serve_workspace_resume.ts")).serveWorkspaceResumeCommand,
  },
  {
    name: "rm",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/serve_workspace_rm.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./serve_workspace_rm.ts")).serveWorkspaceRmCommand,
  },
];
