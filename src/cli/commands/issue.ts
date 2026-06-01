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
import { issueBugCommand } from "./issue_bug.ts";
import { issueEditCommand } from "./issue_edit.ts";
import { issueFeatureCommand } from "./issue_feature.ts";
import { issueGetCommand } from "./issue_get.ts";
import { issueRippleCommand } from "./issue_ripple.ts";
import { issueSecurityCommand } from "./issue_security.ts";

export const issueCommand = new Command()
  .name("issue")
  .description(
    "Fetch issue details, submit bug reports, feature requests, security reports, and ripples (comments)",
  )
  .action(groupCommandAction)
  .command("get", issueGetCommand)
  .command("edit", issueEditCommand)
  .command("bug", issueBugCommand)
  .command("feature", issueFeatureCommand)
  .command("security", issueSecurityCommand)
  .command("ripple", issueRippleCommand);
