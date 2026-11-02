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

import { UserError } from "../errors.ts";

export type OutputKind = "file" | "resource";

/** called once when the claimed write ends; a write that saved nothing frees the name */
export type SettleClaim = (written: boolean) => void;

interface Claim {
  kind: OutputKind;
  specName: string;
  inFlight: number;
  written: boolean;
}

/**
 * the data names one method execution has written, so a name cannot hold
 * versions of a different kind or spec within that execution
 */
export class ExecutionOutputNames {
  readonly #claims = new Map<string, Claim>();

  /**
   * synchronous check-and-set: two concurrent writes of one name cannot both
   * pass, so call it before the writer's first await
   */
  claim(name: string, kind: OutputKind, specName: string): SettleClaim {
    let held = this.#claims.get(name);
    if (held === undefined) {
      held = { kind, specName, inFlight: 0, written: false };
      this.#claims.set(name, held);
    } else if (held.kind !== kind || held.specName !== specName) {
      throw new UserError(
        `Duplicate data instance name '${name}' (already written as ${held.kind} '${held.specName}' in this run)`,
      );
    }
    const claim = held;
    claim.inFlight++;
    let settled = false;
    return (written) => {
      if (settled) return;
      settled = true;
      claim.inFlight--;
      if (written) claim.written = true;
      if (!claim.written && claim.inFlight === 0) this.#claims.delete(name);
    };
  }
}
