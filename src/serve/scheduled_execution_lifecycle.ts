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

import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type { TriggerOverride } from "../libswamp/workflows/scheduled_execution.ts";
import type { DrainableTriggerSource } from "./shutdown_drain.ts";

const logger = getSwampLogger(["serve", "scheduler"]);

export interface LifecycleScheduler extends DrainableTriggerSource {
  startCatchUp(): void;
  setMaxConcurrentRuns(maxConcurrentRuns: number): void;
  admitQueued(): void;
  holdsAny(identity: readonly string[]): boolean;
  idle(): Promise<void>;
}

export interface SchedulerBuildOptions {
  readonly triggerOverrides: ReadonlyMap<string, TriggerOverride> | undefined;
  readonly maxConcurrentRuns: number | undefined;
  readonly busyElsewhere: (identity: readonly string[]) => boolean;
  readonly onRunSettled: () => void;
}

export interface ScheduledExecutionLifecycleDeps<S extends LifecycleScheduler> {
  build(options: SchedulerBuildOptions): S;
  start(service: S): Promise<void>;
  /** the reference handlers read; null while scheduling is off */
  publish(service: S | null): void;
  leads(): boolean;
  /**
   * replays the cron runs this process left pending when it turned off; one
   * queued at or after createdBefore is the new scheduler's own fire
   */
  replayOwnCron(service: S, createdBefore: string): Promise<number>;
  readonly maxConcurrentRuns: number | undefined;
}

export interface TurnOnOptions {
  /** startup replays and catches up itself, after the boot reconciliation */
  readonly atBoot?: boolean;
}

/**
 * Owns the one live scheduler. Turning it off drains it: queued runs keep their
 * pending entries for replay and runs in flight finish, then it stops.
 */
export class ScheduledExecutionLifecycle<S extends LifecycleScheduler>
  implements DrainableTriggerSource {
  readonly #deps: ScheduledExecutionLifecycleDeps<S>;
  #current: S | null = null;
  readonly #retiring = new Map<S, Promise<void>>();
  #maxConcurrentRuns: number | undefined;
  #ranScheduler = false;
  #closed = false;
  /** a turn-on that did not lead leaves its replay to the lead, from this cutoff */
  #ownReplayCutoff: string | undefined;

  constructor(deps: ScheduledExecutionLifecycleDeps<S>) {
    this.#deps = deps;
    this.#maxConcurrentRuns = deps.maxConcurrentRuns;
  }

  current(): S | null {
    return this.#current;
  }

  enabled(): boolean {
    return this.#current !== null;
  }

  /** a process that ran a scheduler keeps cron runs pending while it is off */
  ranScheduler(): boolean {
    return this.#ranScheduler;
  }

  retiring(): readonly S[] {
    return [...this.#retiring.keys()];
  }

  setMaxConcurrentRuns(maxConcurrentRuns: number | undefined): void {
    this.#maxConcurrentRuns = maxConcurrentRuns;
    this.#current?.setMaxConcurrentRuns(maxConcurrentRuns ?? 1);
  }

  /**
   * a failure before the scheduler has started leaves nothing published and
   * rethrows; once it runs, a failed replay leaves the runs pending
   */
  async turnOn(
    triggerOverrides: ReadonlyMap<string, TriggerOverride> | undefined,
    options: TurnOnOptions = {},
  ): Promise<void> {
    if (this.#closed || this.#current) return;
    const createdBefore = new Date().toISOString();
    const service = this.#deps.build({
      triggerOverrides,
      maxConcurrentRuns: this.#maxConcurrentRuns,
      busyElsewhere: (identity) =>
        [...this.#retiring.keys()].some((sibling) =>
          sibling.holdsAny(identity)
        ),
      // a retiring sibling's run ending may free a workflow queued here
      onRunSettled: () => this.#current?.admitQueued(),
    });
    try {
      await this.#deps.start(service);
    } catch (error) {
      await service.stop().catch(() => {});
      throw error;
    }
    if (this.#closed) {
      await service.stop();
      return;
    }
    this.#current = service;
    this.#ranScheduler = true;
    this.#deps.publish(service);
    if (options.atBoot) return;
    if (!this.#deps.leads()) {
      this.#ownReplayCutoff = createdBefore;
      return;
    }
    await this.#replayThenCatchUp(service, createdBefore);
  }

  async atLead(): Promise<void> {
    const service = this.#current;
    if (!service || this.#closed) return;
    const cutoff = this.#ownReplayCutoff;
    this.#ownReplayCutoff = undefined;
    if (cutoff === undefined) {
      service.startCatchUp();
      return;
    }
    await this.#replayThenCatchUp(service, cutoff);
  }

  async #replayThenCatchUp(service: S, createdBefore: string): Promise<void> {
    try {
      const replayed = await this.#deps.replayOwnCron(service, createdBefore);
      if (replayed > 0) {
        logger
          .info`Replayed ${replayed} pending scheduled run(s) left when scheduling was turned off`;
      }
    } catch (error) {
      logger.warn`Replaying pending scheduled runs failed; they stay pending: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    // after the replay, so a replayed run queues ahead of a catch-up
    if (this.#current === service && !this.#closed) service.startCatchUp();
  }

  async turnOff(): Promise<void> {
    const service = this.#current;
    if (!service) return;
    this.#current = null;
    this.#ownReplayCutoff = undefined;
    this.#deps.publish(null);
    const retirement = Promise.withResolvers<void>();
    this.#retiring.set(service, retirement.promise);
    try {
      await service.drain(0);
    } finally {
      retirement.resolve(this.#retire(service));
    }
  }

  async #retire(service: S): Promise<void> {
    try {
      await service.idle();
      if (!this.#closed) await service.stop();
    } catch (error) {
      logger.warn`Stopping a scheduler turned off by reload failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    } finally {
      this.#retiring.delete(service);
      this.#current?.admitQueued();
    }
  }

  /** shutdown: nothing starts after this, and every scheduler drains */
  async drain(timeoutMs: number): Promise<void> {
    this.#closed = true;
    const all = [
      ...(this.#current ? [this.#current] : []),
      ...this.#retiring.keys(),
    ];
    const results = await Promise.allSettled(
      all.map((service) => service.drain(timeoutMs)),
    );
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
  }

  async stop(): Promise<void> {
    this.#closed = true;
    const current = this.#current;
    this.#current = null;
    const retiring = [...this.#retiring.entries()];
    const results = await Promise.allSettled([
      ...(current ? [current.stop()] : []),
      ...retiring.map(([service]) => service.stop()),
    ]);
    await Promise.allSettled(retiring.map(([, retirement]) => retirement));
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
  }
}
