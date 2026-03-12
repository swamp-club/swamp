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

import type { AuthWhoamiEvent, EventHandlers } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogAuthWhoamiRenderer implements Renderer<AuthWhoamiEvent> {
  handlers(): EventHandlers<AuthWhoamiEvent> {
    return {
      loading_credentials: () => {},
      contacting_server: () => {},
      completed: (e) => {
        writeOutput(
          `${e.identity.username} (${e.identity.email}) on ${e.identity.serverUrl}`,
        );
        if (e.identity.collectives && e.identity.collectives.length > 0) {
          writeOutput(`Collectives: ${e.identity.collectives.join(", ")}`);
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonAuthWhoamiRenderer implements Renderer<AuthWhoamiEvent> {
  handlers(): EventHandlers<AuthWhoamiEvent> {
    return {
      loading_credentials: () => {},
      contacting_server: () => {},
      completed: (e) => {
        console.log(JSON.stringify(
          {
            authenticated: true,
            serverUrl: e.identity.serverUrl,
            id: e.identity.id,
            username: e.identity.username,
            email: e.identity.email,
            name: e.identity.name,
            ...(e.identity.collectives
              ? { collectives: e.identity.collectives }
              : {}),
          },
          null,
          2,
        ));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createAuthWhoamiRenderer(
  mode: OutputMode,
): Renderer<AuthWhoamiEvent> {
  switch (mode) {
    case "json":
      return new JsonAuthWhoamiRenderer();
    case "log":
      return new LogAuthWhoamiRenderer();
  }
}
