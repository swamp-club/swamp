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

import type { RunStartKey } from "../domain/workflows/run_start_key.ts";

export interface HeldRunStart {
  readonly key: RunStartKey;
  /** the run id, or undefined when the attempt failed before it started */
  readonly started: Promise<string | undefined>;
}

export interface RunStartClaim {
  started(runId: string): void;
  /** frees the key for another attempt, whatever became of this one */
  settled(): void;
}

/**
 * covers the window before a run's record can be read; held until the run leaves
 * the registry, by when the index holds its key. Per process: across instances
 * only the run index decides.
 */
export class RunStartClaims {
  readonly #held = new Map<string, HeldRunStart>();

  holder(lookup: string): HeldRunStart | undefined {
    return this.#held.get(lookup);
  }

  /** call only after holder returned undefined, with no await in between */
  claim(lookup: string, key: RunStartKey): RunStartClaim {
    let resolve!: (runId: string | undefined) => void;
    const started = new Promise<string | undefined>((r) => {
      resolve = r;
    });
    const held: HeldRunStart = { key, started };
    this.#held.set(lookup, held);
    return {
      started: (runId) => resolve(runId),
      settled: () => {
        resolve(undefined);
        if (this.#held.get(lookup) === held) this.#held.delete(lookup);
      },
    };
  }
}

export const runStartClaims = new RunStartClaims();
