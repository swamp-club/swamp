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

import type {
  EventHandlers,
  VaultReadSecretEvent,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

const encoder = new TextEncoder();

class LogVaultReadSecretRenderer implements Renderer<VaultReadSecretEvent> {
  #isTerminal: () => boolean;

  constructor(isTerminal: () => boolean) {
    this.#isTerminal = isTerminal;
  }

  handlers(): EventHandlers<VaultReadSecretEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        if (this.#isTerminal()) {
          writeOutput(e.data.value);
        } else {
          Deno.stdout.writeSync(encoder.encode(e.data.value));
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonVaultReadSecretRenderer implements Renderer<VaultReadSecretEvent> {
  handlers(): EventHandlers<VaultReadSecretEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createVaultReadSecretRenderer(
  mode: OutputMode,
  isTerminal: () => boolean = () => Deno.stdout.isTerminal(),
): Renderer<VaultReadSecretEvent> {
  switch (mode) {
    case "json":
      return new JsonVaultReadSecretRenderer();
    case "log":
      return new LogVaultReadSecretRenderer(isTerminal);
  }
}
