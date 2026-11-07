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

import type { WorkflowRun } from "./workflow_run.ts";

/**
 * Which step events a landed save of their run already holds. Sound because a
 * producer changes the run before it yields the event, and a save snapshots the
 * run after begin() is read: a save begun after an event was stamped holds it.
 */
export class RunSaveHorizon {
  #produced = 0;
  readonly #stamps = new WeakMap<object, number>();
  readonly #landed = new WeakMap<WorkflowRun, number>();

  stamp(event: object): void {
    this.#stamps.set(event, ++this.#produced);
  }

  begin(): number {
    return this.#produced;
  }

  /** only for a save that wrote: a refused or failed one holds nothing */
  landed(run: WorkflowRun, mark: number): void {
    if (mark > (this.#landed.get(run) ?? 0)) this.#landed.set(run, mark);
  }

  covers(run: WorkflowRun, event: object): boolean {
    const stamp = this.#stamps.get(event);
    return stamp !== undefined && stamp <= (this.#landed.get(run) ?? 0);
  }
}
