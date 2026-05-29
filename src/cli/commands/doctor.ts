// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { doctorAuditCommand } from "./doctor_audit.ts";
import { doctorExtensionsCommand } from "./doctor_extensions.ts";
import { doctorInstallCommand } from "./doctor_install.ts";
import { doctorSecretsCommand } from "./doctor_secrets.ts";
import { doctorWorkflowsCommand } from "./doctor_workflows.ts";

export const doctorCommand = new Command()
  .description(
    "Run diagnostics that verify swamp's integrations are healthy.",
  )
  .example(
    "Check the audit integration for the configured tool",
    "swamp doctor audit",
  )
  .example(
    "Check the audit integration for a specific tool",
    "swamp doctor audit --tool kiro",
  )
  .example(
    "Check swamp installation health",
    "swamp doctor install",
  )
  .example(
    "Check that user-defined extensions in this repo load cleanly",
    "swamp doctor extensions",
  )
  .example(
    "Check that workflow YAML files load cleanly",
    "swamp doctor workflows",
  )
  .example(
    "Scan for cleartext sensitive global arguments",
    "swamp doctor secrets",
  )
  // `--repo-dir` is accepted on the top-level command for consistency
  // with subcommands and other repo-scoped commands. The top-level
  // action only shows help; subcommands consume the option.
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(groupCommandAction)
  .command("audit", doctorAuditCommand)
  .command("extensions", doctorExtensionsCommand)
  .command("install", doctorInstallCommand)
  .command("secrets", doctorSecretsCommand)
  .command("workflows", doctorWorkflowsCommand);
