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

/**
 * the data names one method execution has written, so a name cannot hold
 * versions of a different kind or spec within that execution
 */
export class ExecutionOutputNames {
  readonly #claims = new Map<string, { kind: OutputKind; specName: string }>();

  /**
   * synchronous check-and-set: two concurrent writes of one name cannot both
   * pass, so call it before the writer's first await
   */
  claim(name: string, kind: OutputKind, specName: string): void {
    const held = this.#claims.get(name);
    if (held === undefined) {
      this.#claims.set(name, { kind, specName });
      return;
    }
    if (held.kind === kind && held.specName === specName) return;
    throw new UserError(
      `Duplicate data instance name '${name}' (already written as ${held.kind} '${held.specName}' in this run)`,
    );
  }
}
