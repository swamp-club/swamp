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

import type { EventHandlers, InviteLinkEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { dim } from "@std/fmt/colors";

/**
 * Log mode deliberately splits the two streams: the URL alone on stdout, every
 * word of prose on stderr. That is what makes `swamp invite link | pbcopy`
 * capture a link and nothing else. Do not "tidy" the note onto stdout.
 */
class LogInviteLinkRenderer implements Renderer<InviteLinkEvent> {
  handlers(): EventHandlers<InviteLinkEvent> {
    return {
      completed: (e) => {
        // stdout: the link, bare and uncoloured, so a pipeline can consume it.
        writeOutput(e.data.url);

        // Deliberately vague about when and how much. The payout lands only
        // for a net-new account, and only once that recruit gets established
        // — not at signup. Naming a moment here would promise something the
        // server does not do, and the point value lives server-side and will
        // change.
        console.error("");
        console.error(
          dim(
            "Someone who joins through this link earns you points once they get established.",
          ),
        );
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonInviteLinkRenderer implements Renderer<InviteLinkEvent> {
  handlers(): EventHandlers<InviteLinkEvent> {
    return {
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createInviteLinkRenderer(
  mode: OutputMode,
): Renderer<InviteLinkEvent> {
  switch (mode) {
    case "json":
      return new JsonInviteLinkRenderer();
    case "log":
      return new LogInviteLinkRenderer();
  }
}
