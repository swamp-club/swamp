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
import { issueBugCommand } from "./issue_bug.ts";
import { issueFeatureCommand } from "./issue_feature.ts";
import { issueRippleCommand } from "./issue_ripple.ts";
import { issueSecurityCommand } from "./issue_security.ts";

export const issueCommand = new Command()
  .name("issue")
  .description(
    "Submit bug reports, feature requests, security reports, and ripples",
  )
  .action(function () {
    this.showHelp();
  })
  .command("bug", issueBugCommand)
  .command("feature", issueFeatureCommand)
  .command("security", issueSecurityCommand)
  .command("ripple", issueRippleCommand);
