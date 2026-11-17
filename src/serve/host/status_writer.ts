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

import { hostedWantedOf } from "../../domain/serve/hosted_workspace.ts";
import {
  type HostedWorkspaceStatus,
  writeHostedWorkspaceStatus,
} from "../../infrastructure/persistence/hosted_workspace_status_file.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { ServeStatus } from "./supervisor.ts";

const logger = getSwampLogger(["serve", "host", "status"]);

export type StatusFileWrite = (
  name: string,
  status: HostedWorkspaceStatus,
) => Promise<void>;

export const DEFAULT_STATUS_RETRY_MS = 5_000;

export interface StatusWriterOptions {
  readonly workspacesDir: string;
  readonly now?: () => Date;
  readonly write?: StatusFileWrite;
  readonly retryMs?: number;
}

export interface StatusWriter {
  /** from the supervisor's onStatus; the root has no status file */
  report(status: ServeStatus): void;
  /** a wanted file that cannot be read; null clears it */
  setProblem(name: string, problem: string | null): void;
  /** waits for the write in flight, then writes nothing more until track */
  forget(name: string): Promise<void>;
  track(name: string): void;
  /** after the supervisor's shutdown: every file says stopped, whatever the serve last reported */
  markShutDown(): void;
  /** waits for every write, including those queued while it waits */
  drain(): Promise<void>;
}

interface Slot {
  latest: ServeStatus | null;
  problem: string | null;
  forgotten: boolean;
  dirty: boolean;
  writing: Promise<void> | null;
  /** the reason the last write failed, logged once */
  failure: string | null;
  /** ends a retry wait early, for forget and shutdown */
  wake: (() => void) | null;
}

export function createStatusWriter(options: StatusWriterOptions): StatusWriter {
  const now = options.now ?? (() => new Date());
  const write: StatusFileWrite = options.write ??
    ((name, status) =>
      writeHostedWorkspaceStatus(options.workspacesDir, name, status));
  const slots = new Map<string, Slot>();
  const retryMs = options.retryMs ?? DEFAULT_STATUS_RETRY_MS;
  let shuttingDown = false;

  const slotOf = (name: string): Slot => {
    let slot = slots.get(name);
    if (slot === undefined) {
      slot = {
        latest: null,
        problem: null,
        forgotten: false,
        dirty: false,
        writing: null,
        failure: null,
        wake: null,
      };
      slots.set(name, slot);
    }
    return slot;
  };

  const waitOrWake = (slot: Slot): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(() => wake(), retryMs);
    const wake = () => {
      clearTimeout(timer);
      slot.wake = null;
      resolve();
    };
    slot.wake = wake;
    return promise;
  };

  const contentOf = (
    slot: Slot,
    status: ServeStatus,
  ): HostedWorkspaceStatus => ({
    state: shuttingDown ? "stopped" : status.observed,
    wanted: hostedWantedOf(status.wanted),
    restarts: status.restarts,
    reason: shuttingDown ? slot.problem : reasonOf(slot.problem, status),
    updatedAt: now().toISOString(),
  });

  // one write in flight per workspace; a burst coalesces into its last status
  const schedule = (name: string, slot: Slot) => {
    if (slot.forgotten || slot.latest === null) return;
    slot.dirty = true;
    if (slot.writing !== null) return;
    slot.writing = (async () => {
      while (slot.dirty && !slot.forgotten && slot.latest !== null) {
        slot.dirty = false;
        try {
          await write(name, contentOf(slot, slot.latest));
          slot.failure = null;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          if (reason !== slot.failure) {
            slot.failure = reason;
            logger.warn(
              "Writing the status of workspace {name} failed, and is tried again every {seconds} s: {error}",
              { name, seconds: retryMs / 1000, error },
            );
          }
          // no event follows a stable state such as failed, so the file is retried on a timer,
          // not on the folder watch its own write would wake; shutdown never waits on it
          if (shuttingDown) break;
          slot.dirty = true;
          await waitOrWake(slot);
        }
      }
    })().finally(() => {
      slot.writing = null;
      // a status reported after the loop's last check but before this ran
      if (slot.dirty) schedule(name, slot);
    });
  };

  return {
    report(status) {
      if (status.id.kind !== "workspace") return;
      const slot = slotOf(status.id.name);
      slot.latest = status;
      schedule(status.id.name, slot);
    },

    setProblem(name, problem) {
      const slot = slotOf(name);
      if (slot.problem === problem) return;
      slot.problem = problem;
      schedule(name, slot);
    },

    async forget(name) {
      const slot = slotOf(name);
      slot.forgotten = true;
      slot.dirty = false;
      slot.wake?.();
      await slot.writing;
    },

    track(name) {
      const slot = slotOf(name);
      slot.forgotten = false;
      slot.latest = null;
    },

    markShutDown() {
      shuttingDown = true;
      for (const [name, slot] of slots) {
        slot.wake?.();
        schedule(name, slot);
      }
    },

    async drain() {
      for (;;) {
        const writing = [...slots.values()].flatMap((slot) =>
          slot.writing === null ? [] : [slot.writing]
        );
        if (writing.length === 0) return;
        await Promise.all(writing);
      }
    },
  };
}

function reasonOf(problem: string | null, status: ServeStatus): string | null {
  if (problem !== null) return problem;
  if (status.refusal !== null) return status.refusal;
  if (status.observed !== "backoff" && status.observed !== "failed") {
    return null;
  }
  const exit = status.lastExit;
  if (exit === null) return null;
  if (exit.stderrTail.length > 0) return exit.stderrTail.join("\n");
  return exit.code === null
    ? "The serve was killed."
    : `The serve exited with code ${exit.code}.`;
}
