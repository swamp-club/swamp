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
import type { RootRoute } from "./command_routes.ts";

// each load is a literal import(): deno compile embeds only literal specifiers,
// and the order is root help's listing order; root help reads the rows alone
export const ROOT_ROUTES: readonly RootRoute[] = [
  {
    name: "access",
    shortDescription:
      "Manage authorization policies (grants), groups, and access checks",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/access.ts",
    needsFullTree: false,
    load: async (rest) =>
      (await import("./commands/access.ts")).createAccessCommand(rest),
  },
  {
    name: "version",
    shortDescription: "Display the version of swamp",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/version.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/version.ts")).versionCommand,
  },
  {
    name: "behavior",
    shortDescription: "Manage and run behaviors (preferred over 'model')",
    aliases: ["behaviour"],
    hidden: false,
    module: "src/cli/commands/behavior.ts",
    needsFullTree: false,
    load: async (rest) =>
      (await import("./commands/behavior.ts")).createBehaviorCommand(rest),
  },
  {
    name: "model",
    shortDescription:
      "Manage models (legacy spelling of 'behavior'; kept, no removal planned)",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/model.ts",
    needsFullTree: false,
    load: async (rest) =>
      (await import("./commands/model.ts")).createModelCommand(rest),
  },
  {
    name: "init",
    shortDescription: "Initialize a new swamp repository",
    arguments: "[path:string]",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/repo_init.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/repo_init.ts")).repoInitCommand,
  },
  {
    name: "repo",
    shortDescription: "Manage swamp repositories",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/repo_init.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/repo_init.ts")).repoCommand,
  },
  {
    name: "workflow",
    shortDescription: "Manage workflows",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/workflow.ts",
    needsFullTree: false,
    load: async (rest) =>
      (await import("./commands/workflow.ts")).createWorkflowCommand(rest),
  },
  {
    name: "vault",
    shortDescription: "Manage vault configurations",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/vault.ts",
    needsFullTree: false,
    load: async (rest) =>
      (await import("./commands/vault.ts")).createVaultCommand(rest),
  },
  {
    name: "data",
    shortDescription: "Manage behavior data",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/data.ts",
    needsFullTree: false,
    load: async (rest) =>
      (await import("./commands/data.ts")).createDataCommand(rest),
  },
  {
    name: "telemetry",
    shortDescription: "Manage CLI telemetry",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/telemetry_stats.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./commands/telemetry_stats.ts")).telemetryCommand,
  },
  {
    name: "audit",
    shortDescription: "View audit timeline of swamp vs direct CLI commands",
    aliases: [],
    hidden: true,
    module: "src/cli/commands/audit.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/audit.ts")).auditCommand,
  },
  {
    name: "update",
    shortDescription: "Update swamp to the latest version",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/update.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/update.ts")).updateCommand,
  },
  {
    name: "config",
    shortDescription: "Manage swamp configuration",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/config.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/config.ts")).configCommand,
  },
  {
    name: "source",
    shortDescription: "Manage swamp source code for troubleshooting",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/source.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/source.ts")).sourceCommand,
  },
  {
    name: "completions",
    shortDescription: "Generate shell completions.",
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
    shortDescription:
      "Search, fetch, report, and comment on swamp-club Lab issues",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/issue.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/issue.ts")).issueCommand,
  },
  {
    name: "invite",
    shortDescription: "Invite people to swamp-club",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/invite.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/invite.ts")).inviteCommand,
  },
  // Hidden easter egg — the same command as `swamp invite link`.
  {
    name: "first-rule",
    shortDescription: "Print your swamp-club invite link",
    aliases: [],
    hidden: true,
    module: "src/cli/commands/invite_link.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./commands/invite_link.ts")).firstRuleCommand,
  },
  {
    name: "auth",
    shortDescription: "Manage swamp-club authentication.",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/auth.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/auth.ts")).authCommand,
  },
  {
    name: "extension",
    shortDescription: "Manage swamp extensions",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/extension.ts",
    needsFullTree: false,
    load: async (rest) =>
      (await import("./commands/extension.ts")).createExtensionCommand(rest),
  },
  {
    name: "summarise",
    shortDescription:
      "Show a high-level overview of repo activity (method executions, workflows, data)",
    aliases: ["summarize"],
    hidden: false,
    module: "src/cli/commands/summarise.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./commands/summarise.ts")).summariseCommand,
  },
  {
    name: "datastore",
    shortDescription: "Manage datastore configuration",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/datastore.ts",
    needsFullTree: false,
    load: async (rest) =>
      (await import("./commands/datastore.ts")).createDatastoreCommand(rest),
  },
  {
    name: "doctor",
    shortDescription:
      "Run diagnostics that verify swamp's integrations are healthy.",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/doctor.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/doctor.ts")).doctorCommand,
  },
  {
    name: "run",
    shortDescription: "Track and diagnose in-flight method and workflow runs",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/run.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/run.ts")).runCommand,
  },
  {
    name: "report",
    shortDescription: "Browse and view stored report results",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/report.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/report.ts")).reportCommand,
  },
  {
    name: "serve",
    shortDescription:
      "Start a WebSocket API server for workflow and behavior execution.",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/serve.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/serve.ts")).serveCommand,
  },
  {
    name: "agent",
    shortDescription: "Manage custom AI agent tool definitions",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/agent_setup.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/agent_setup.ts")).agentCommand,
  },
  {
    name: "worker",
    shortDescription: "Manage remote execution workers and enrollment tokens",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/worker.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/worker.ts")).workerCommand,
  },
  {
    name: "quest",
    shortDescription: "What treasures are there yet to discover?",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/quest.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/quest.ts")).questCommand,
  },
  {
    name: "subscription",
    shortDescription:
      "Show the plan and billing standing of your swamp-club collectives, and open their billing page",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/subscription.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./commands/subscription.ts")).subscriptionCommand,
  },
  {
    name: "inbox",
    shortDescription:
      "Browse your Swamp Club inbox. In a terminal, an interactive inbox where opening a message marks it read. Otherwise a list of messages with their ids, which marks nothing read.",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/inbox.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/inbox.ts")).inboxCommand,
  },
  {
    name: "start",
    shortDescription:
      "Get from a task to an agent working on it. Opens a local page where you",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/start.ts",
    needsFullTree: false,
    load: async () => (await import("./commands/start.ts")).startCommand,
  },
  {
    name: "dashboard",
    shortDescription:
      "Open this repo's dashboard in your browser, with no swamp serve",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/dashboard.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./commands/dashboard.ts")).dashboardCommand,
  },
  {
    name: "workspace",
    shortDescription:
      "Manage workspaces: swamp repos Swamp keeps track of, wherever they are",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/workspace.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./commands/workspace.ts")).workspaceCommand,
  },
];
