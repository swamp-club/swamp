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

export interface ContinuedScheduledRun {
  readonly workflowId: string;
  readonly runId: string;
  readonly workflowName: string;
}

/**
 * scheduled runs serve continued, kept outside any one scheduler so a rebuilt
 * scheduler still holds off their workflows' next fires
 */
export class ContinuedScheduledRuns {
  readonly #runs = new Map<string, ContinuedScheduledRun>();
  readonly #onEnd: () => void;

  /** onEnd must not throw: it runs from the run's completion */
  constructor(onEnd: () => void) {
    this.#onEnd = onEnd;
  }

  add(run: ContinuedScheduledRun, completion: Promise<void>): void {
    this.#runs.set(run.runId, run);
    const release = () => {
      this.#runs.delete(run.runId);
      this.#onEnd();
    };
    completion.then(release, release);
  }

  holds(identity: readonly string[]): boolean {
    for (const run of this.#runs.values()) {
      if (
        identity.includes(run.workflowId) ||
        identity.includes(run.workflowName)
      ) {
        return true;
      }
    }
    return false;
  }
}
