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

import { Command } from "@cliffy/command";
import { groupCommandAction } from "../group_action.ts";
import { workflowSchedulePauseCommand } from "./workflow_schedule_pause.ts";
import { workflowScheduleResumeCommand } from "./workflow_schedule_resume.ts";
import { workflowScheduleListCommand } from "./workflow_schedule_list.ts";
import { unknownCommandErrorHandler } from "../unknown_command_handler.ts";

export const workflowScheduleCommand = new Command()
  .name("schedule")
  .description(
    "Pause, resume and list workflow schedules without editing workflow definitions",
  )
  .error(unknownCommandErrorHandler)
  .action(groupCommandAction)
  .command("pause", workflowSchedulePauseCommand)
  .command("resume", workflowScheduleResumeCommand)
  .command("list", workflowScheduleListCommand);
