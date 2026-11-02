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

import type { EventHandlers } from "../../libswamp/stream.ts";
import type { InviteLinkEvent } from "../../libswamp/invite/link.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { dim } from "@std/fmt/colors";

/**
 * log mode splits streams on purpose: the URL alone on stdout, all prose on
 * stderr, so piping to pbcopy captures only the link. The command is listed in
 * src/cli/stdout_contract.ts to keep log records off stdout.
 */
class LogInviteLinkRenderer implements Renderer<InviteLinkEvent> {
  readonly #quiet: boolean;

  constructor(quiet: boolean) {
    this.#quiet = quiet;
  }

  handlers(): EventHandlers<InviteLinkEvent> {
    return {
      completed: (e) => {
        // stdout: the link, bare and uncoloured, so a pipeline can consume it.
        // Emitted before the quiet check — `-q` suppresses the commentary, not
        // the thing the user asked for.
        writeOutput(e.data.url);

        // the note is non-essential so -q silences it; it uses console.error
        // directly because the logger would stamp designed prose with a
        // timestamp, level and category
        if (this.#quiet) return;

        // names the moment, not the amount: the payout lands only for a net-new
        // account that crosses the reward tier, never at signup. The point
        // value lives server-side and changes, so it stays out of here.
        console.error("");
        console.error(
          dim(
            "A recruit who joins through this link pays out when they claw their way up to Marsh Skulker.",
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

/**
 * takes quiet rather than the CLI's Verbosity because presentation must not
 * import cli types; the caller narrows
 */
export function createInviteLinkRenderer(
  mode: OutputMode,
  quiet = false,
): Renderer<InviteLinkEvent> {
  switch (mode) {
    case "json":
      return new JsonInviteLinkRenderer();
    case "log":
      return new LogInviteLinkRenderer(quiet);
  }
}
