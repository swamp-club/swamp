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
import { doctorAuditCommand } from "./doctor_audit.ts";

/**
 * Parent namespace for diagnostic subcommands.
 *
 * `doctor` has no `.action()` — Cliffy falls back to printing help when the
 * user runs `swamp doctor` with no subcommand. Future diagnostics (e.g.
 * `doctor datastore`, `doctor vault`) register as sibling `.command(...)`
 * entries.
 */
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
  .command("audit", doctorAuditCommand);
