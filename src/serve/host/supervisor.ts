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

import type { AuthMode } from "../../domain/access/serve_auth_config.ts";
import { UserError } from "../../domain/errors.ts";
import {
  DEFAULT_MANAGED_SERVE_POLICY,
  ManagedServe,
  type ManagedServeAction,
  type ManagedServeEvent,
  type ManagedServePolicy,
  type ObservedServeState,
  parseManagedServePolicy,
  SAFE_RESTART_EXIT_CODE,
  type ServeId,
  serveIdKey,
  type WantedServeState,
} from "../../domain/serve/managed_serve.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { ListenedServe } from "../listening_line.ts";
import type {
  ServeChild,
  ServeChildExit,
  ServeChildSpec,
  ServeProcessPort,
} from "./serve_process.ts";

const logger = getSwampLogger(["serve", "host", "supervisor"]);

export const DEFAULT_READY_TIMEOUT_MS = 120_000;
// must exceed a default serve shutdown, drain timeout included
export const DEFAULT_STOP_GRACE_MS = 120_000;

export interface SupervisorClock {
  now(): number;
  setTimer(fn: () => void, ms: number): () => void;
}

const SYSTEM_CLOCK: SupervisorClock = {
  now: () => Date.now(),
  setTimer(fn, ms) {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
};

/** null admits the child; a reason stops it and holds it until wanted running */
export type ServeAdmission = (
  spec: ServeChildSpec,
  listened: ListenedServe,
) => string | null;

export interface ServeSupervisorOptions {
  readonly processPort: ServeProcessPort;
  readonly admit?: ServeAdmission;
  readonly clock?: SupervisorClock;
  readonly policy?: ManagedServePolicy;
  readonly readyTimeoutMs?: number;
  readonly stopGraceMs?: number;
}

export interface ServeStatus {
  readonly id: ServeId;
  readonly wanted: WantedServeState;
  readonly observed: ObservedServeState;
  /** set only while the serve is ready */
  readonly port: number | null;
  /** what the live child reported on its listening line */
  readonly authMode: AuthMode | null;
  /** why admission stopped the serve; cleared when it is wanted running */
  readonly refusal: string | null;
  readonly crashCount: number;
  readonly lastExit: ServeChildExit | null;
}

export interface ServeSupervisor {
  add(spec: ServeChildSpec): void;
  setWanted(id: ServeId, wanted: WantedServeState): void;
  resume(id: ServeId): void;
  lookup(id: ServeId): ServeStatus | undefined;
  /** returns how many ready children were asked */
  reload(): number;
  /** stops every child through its drain path; changes no wanted state */
  shutdown(): Promise<void>;
}

interface LiveChild {
  readonly handle: ServeChild;
  port: number | null;
  authMode: AuthMode | null;
  terminating: boolean;
  /** a stop the caller asked for; any other exit is logged as a crash */
  requested: boolean;
}

interface Entry {
  readonly spec: ServeChildSpec;
  serve: ManagedServe;
  child: LiveChild | null;
  lastExit: ServeChildExit | null;
  refusal: string | null;
  cancelRetry: (() => void) | null;
  /** the ready deadline, then the kill escalation, of the live child */
  cancelStopTimer: (() => void) | null;
}

export function createServeSupervisor(
  options: ServeSupervisorOptions,
): ServeSupervisor {
  const { processPort, admit } = options;
  const clock = options.clock ?? SYSTEM_CLOCK;
  const policy = parseManagedServePolicy(
    options.policy ?? DEFAULT_MANAGED_SERVE_POLICY,
  );
  const readyTimeoutMs = positiveWhole(
    "readyTimeoutMs",
    options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
  );
  const stopGraceMs = positiveWhole(
    "stopGraceMs",
    options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
  );
  const entries = new Map<string, Entry>();
  const pending = new Set<Promise<void>>();
  let closing = false;
  let shutdownDone: Promise<void> | undefined;

  const track = (work: Promise<void>) => {
    const settled = work.catch((error) => {
      logger.error("Serve supervisor handler failed: {error}", { error });
    }).finally(() => pending.delete(settled));
    pending.add(settled);
  };

  const entryOf = (id: ServeId): Entry => {
    const entry = entries.get(serveIdKey(id));
    if (entry === undefined) {
      throw new UserError(`No serve ${serveIdKey(id)} is supervised.`);
    }
    return entry;
  };

  const refuseWhenClosing = () => {
    if (closing) throw new UserError("The serve supervisor is shutting down.");
  };

  // step and every action are synchronous, so events for one serve never
  // interleave even though they arrive from separate promises
  const apply = (entry: Entry, event: ManagedServeEvent) => {
    const { next, action } = entry.serve.step(event, clock.now());
    entry.serve = next;
    carryOut(entry, action);
  };

  const carryOut = (entry: Entry, action: ManagedServeAction) => {
    switch (action.kind) {
      case "spawn":
        if (!closing) spawn(entry);
        return;
      case "stop":
        terminate(entry, true);
        return;
      case "wait":
        entry.cancelRetry?.();
        entry.cancelRetry = null;
        if (action.until !== undefined && !closing) {
          entry.cancelRetry = clock.setTimer(() => {
            entry.cancelRetry = null;
            apply(entry, { kind: "tick" });
          }, Math.max(0, action.until - clock.now()));
        }
        return;
    }
  };

  const spawn = (entry: Entry) => {
    let handle: ServeChild;
    try {
      handle = processPort.spawn(entry.spec);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      entry.lastExit = { code: null, stderrTail: [reason] };
      apply(entry, { kind: "exited", code: null });
      return;
    }
    const child: LiveChild = {
      handle,
      port: null,
      authMode: null,
      terminating: false,
      requested: false,
    };
    entry.child = child;
    entry.cancelStopTimer?.();
    entry.cancelStopTimer = clock.setTimer(() => {
      entry.cancelStopTimer = null;
      if (entry.child !== child) return;
      logger.warn("Serve {serve} was not ready within {ms} ms; stopping it", {
        serve: serveIdKey(entry.spec.id),
        ms: readyTimeoutMs,
      });
      terminate(entry, false);
    }, readyTimeoutMs);

    track(handle.listening.then((listened) => {
      if (entry.child !== child) return;
      child.port = listened.port;
      child.authMode = listened.authMode;
      const refusal = admission(entry.spec, listened);
      if (refusal === null || child.terminating) return;
      entry.refusal = refusal;
      logger.warn("Serve {serve} was refused: {reason}", {
        serve: serveIdKey(entry.spec.id),
        reason: refusal,
      });
      apply(entry, { kind: "wanted", wanted: "suspended" });
    }, () => {}));
    track(handle.ready.then(() => {
      if (entry.child !== child || child.terminating) return;
      entry.cancelStopTimer?.();
      entry.cancelStopTimer = null;
      apply(entry, { kind: "ready" });
    }, () => {}));
    track(handle.exited.then((exit) => onExited(entry, child, exit)));
  };

  // a check that throws refuses: a child is never admitted by an error
  const admission = (
    spec: ServeChildSpec,
    listened: ListenedServe,
  ): string | null => {
    if (admit === undefined) return null;
    try {
      return admit(spec, listened);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  const onExited = (entry: Entry, child: LiveChild, exit: ServeChildExit) => {
    track(child.handle.release());
    if (entry.child !== child) return;
    const wasReady = entry.serve.observed === "ready";
    entry.cancelStopTimer?.();
    entry.cancelStopTimer = null;
    entry.child = null;
    entry.lastExit = exit;
    if (exit.code === SAFE_RESTART_EXIT_CODE && wasReady) {
      logger.info("Serve {serve} exited for a safe restart", {
        serve: serveIdKey(entry.spec.id),
      });
    } else if (!child.requested) {
      logger.warn("Serve {serve} exited with code {code}", {
        serve: serveIdKey(entry.spec.id),
        code: exit.code,
      });
    }
    apply(entry, { kind: "exited", code: exit.code });
  };

  const terminate = (entry: Entry, requested: boolean) => {
    const child = entry.child;
    if (child === null) return;
    child.requested ||= requested;
    if (child.terminating) return;
    child.terminating = true;
    child.handle.terminate();
    entry.cancelStopTimer?.();
    entry.cancelStopTimer = clock.setTimer(() => {
      entry.cancelStopTimer = null;
      if (entry.child !== child) return;
      logger.warn("Serve {serve} did not stop in time; killing it", {
        serve: serveIdKey(entry.spec.id),
      });
      child.handle.kill();
    }, entry.spec.stopGraceMs ?? stopGraceMs);
  };

  return {
    add(spec) {
      refuseWhenClosing();
      const key = serveIdKey(spec.id);
      if (entries.has(key)) {
        throw new UserError(`Serve ${key} is already supervised.`);
      }
      if (spec.stopGraceMs !== undefined) {
        positiveWhole("stopGraceMs", spec.stopGraceMs);
      }
      const entry: Entry = {
        spec,
        serve: ManagedServe.create(spec.id, policy),
        child: null,
        lastExit: null,
        refusal: null,
        cancelRetry: null,
        cancelStopTimer: null,
      };
      entries.set(key, entry);
      apply(entry, { kind: "wanted", wanted: "running" });
    },

    setWanted(id, wanted) {
      refuseWhenClosing();
      const entry = entryOf(id);
      if (wanted === "running") entry.refusal = null;
      apply(entry, { kind: "wanted", wanted });
    },

    resume(id) {
      refuseWhenClosing();
      const entry = entryOf(id);
      entry.refusal = null;
      apply(entry, { kind: "resume" });
    },

    lookup(id) {
      const entry = entries.get(serveIdKey(id));
      if (entry === undefined) return undefined;
      const { serve, child } = entry;
      return {
        id: serve.id,
        wanted: serve.wanted,
        observed: serve.observed,
        port: serve.observed === "ready" ? child?.port ?? null : null,
        authMode: child?.authMode ?? null,
        refusal: entry.refusal,
        crashCount: serve.crashCount,
        lastExit: entry.lastExit,
      };
    },

    reload() {
      let asked = 0;
      for (const { serve, child } of entries.values()) {
        // a starting child may not handle SIGHUP yet, and would die of it
        if (serve.observed !== "ready" || child === null || child.terminating) {
          continue;
        }
        child.handle.reload();
        asked++;
      }
      return asked;
    },

    shutdown() {
      shutdownDone ??= (async () => {
        closing = true;
        const exits: Promise<ServeChildExit>[] = [];
        for (const entry of entries.values()) {
          entry.cancelRetry?.();
          entry.cancelRetry = null;
          if (entry.child !== null) exits.push(entry.child.handle.exited);
          terminate(entry, true);
        }
        await Promise.all(exits);
        while (pending.size > 0) await Promise.all([...pending]);
      })();
      return shutdownDone;
    },
  };
}

function positiveWhole(field: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new UserError(
      `Invalid serve supervisor setting: ${field} must be a positive whole number, got ${value}.`,
    );
  }
  return value;
}
