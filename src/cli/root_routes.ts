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

import type { AnyCommand } from "./cli_schema.ts";
import type { CommandRoute } from "./command_routes.ts";

// each load is a literal import(): deno compile embeds only literal specifiers,
// and the order is root help's listing order
export const ROOT_ROUTES: readonly CommandRoute[] = [
  {
    name: "access",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/access.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/access.ts")).accessCommand,
  },
  {
    name: "version",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/version.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/version.ts")).versionCommand,
  },
  {
    name: "behavior",
    aliases: ["behaviour"],
    hidden: false,
    module: "src/cli/commands/behavior.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/behavior.ts")).behaviorCommand,
  },
  {
    name: "model",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/model_create.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/model_create.ts")).modelCommand,
  },
  {
    name: "init",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/repo_init.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/repo_init.ts")).repoInitCommand,
  },
  {
    name: "repo",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/repo_init.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/repo_init.ts")).repoCommand,
  },
  {
    name: "workflow",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/workflow.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/workflow.ts")).workflowCommand,
  },
  {
    name: "vault",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/vault.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/vault.ts")).vaultCommand,
  },
  {
    name: "data",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/data.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/data.ts")).dataCommand,
  },
  {
    name: "telemetry",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/telemetry_stats.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./commands/telemetry_stats.ts")).telemetryCommand,
  },
  {
    name: "audit",
    aliases: [],
    hidden: true,
    module: "src/cli/commands/audit.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/audit.ts")).auditCommand,
  },
  {
    name: "update",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/update.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/update.ts")).updateCommand,
  },
  {
    name: "config",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/config.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/config.ts")).configCommand,
  },
  {
    name: "source",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/source.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/source.ts")).sourceCommand,
  },
  {
    name: "completions",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/completion.ts",
    needsFullTree: true,
    // CompletionsCommand overrides Command methods with narrower signatures
    load: async () =>
      (await import("./commands/completion.ts"))
        .completionCommand as AnyCommand,
  },
  {
    name: "issue",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/issue.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/issue.ts")).issueCommand,
  },
  {
    name: "invite",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/invite.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/invite.ts")).inviteCommand,
  },
  // Hidden easter egg — the same command as `swamp invite link`.
  {
    name: "first-rule",
    aliases: [],
    hidden: true,
    module: "src/cli/commands/invite_link.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./commands/invite_link.ts")).firstRuleCommand,
  },
  {
    name: "auth",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/auth.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/auth.ts")).authCommand,
  },
  {
    name: "extension",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/extension.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./commands/extension.ts")).extensionCommand,
  },
  {
    name: "summarise",
    aliases: ["summarize"],
    hidden: false,
    module: "src/cli/commands/summarise.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./commands/summarise.ts")).summariseCommand,
  },
  {
    name: "datastore",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/datastore.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./commands/datastore.ts")).datastoreCommand,
  },
  {
    name: "doctor",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/doctor.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/doctor.ts")).doctorCommand,
  },
  {
    name: "run",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/run.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/run.ts")).runCommand,
  },
  {
    name: "report",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/report.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/report.ts")).reportCommand,
  },
  {
    name: "serve",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/serve.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/serve.ts")).serveCommand,
  },
  {
    name: "agent",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/agent_setup.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/agent_setup.ts")).agentCommand,
  },
  {
    name: "worker",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/worker.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/worker.ts")).workerCommand,
  },
  {
    name: "quest",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/quest.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/quest.ts")).questCommand,
  },
  {
    name: "subscription",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/subscription.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./commands/subscription.ts")).subscriptionCommand,
  },
  {
    name: "inbox",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/inbox.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/inbox.ts")).inboxCommand,
  },
  {
    name: "start",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/start.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/start.ts")).startCommand,
  },
  {
    name: "dashboard",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/dashboard.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./commands/dashboard.ts")).dashboardCommand,
  },
  {
    name: "workspace",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/workspace.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./commands/workspace.ts")).workspaceCommand,
  },
];
