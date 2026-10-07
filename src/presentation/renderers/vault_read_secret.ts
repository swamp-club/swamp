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
import type { VaultReadSecretEvent } from "../../libswamp/vaults/read_secret.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

const encoder = new TextEncoder();

/**
 * Writes every byte of `bytes` to stdout, looping over short writes.
 *
 * On a non-terminal stdout Deno hands writes to a line-buffered writer: it
 * emits complete lines and returns a short count when the trailing partial
 * line does not fit its 1024-byte buffer. A single unchecked `writeSync`
 * therefore dropped the last line of a multi-line secret whose last line was
 * 1024+ chars with no trailing newline (swamp-club#3006). The next call
 * writes that tail directly.
 *
 * A zero-byte write means stdout is taking nothing more. It is not a user
 * mistake, but it is raised as a UserError so the CLI exits non-zero with a
 * clean message on stderr instead of spinning, or leaving a truncated file
 * behind with exit 0.
 */
function writeAllToStdout(bytes: Uint8Array): void {
  let remaining = bytes;
  while (remaining.length > 0) {
    const written = Deno.stdout.writeSync(remaining);
    if (written === 0) {
      throw new UserError(
        `stdout accepted no more data with ${remaining.length} of ` +
          `${bytes.length} bytes of the secret unwritten`,
      );
    }
    remaining = remaining.subarray(written);
  }
}

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
          writeAllToStdout(encoder.encode(e.data.value));
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
