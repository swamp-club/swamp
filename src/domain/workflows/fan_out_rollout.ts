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

import {
  nextBatch,
  type PlannedRollout,
  type RolloutProgress,
} from "../remote/rollout.ts";

export interface RolloutLanes<T> {
  readonly rollout: PlannedRollout;
  /** count against the budget and are never started */
  readonly failedBeforeStart?: Iterable<string>;
  /** a positive limit caps the lanes in flight; otherwise there is none */
  readonly limit: number | undefined;
  readonly signal?: AbortSignal;
  start(lane: string): AsyncIterable<T>;
  /** read once the lane's stream has ended */
  failed(lane: string): boolean;
  batchStarted(batch: number, lanes: readonly string[]): T;
  /** true while an undecided gate holds this lane; consulted once nextBatch would start it */
  held?(lane: string): boolean;
}

export type RolloutEnd =
  | { readonly kind: "complete" }
  | { readonly kind: "aborted" }
  | { readonly kind: "halted"; readonly held: string[] }
  | { readonly kind: "paused"; readonly lane: string };

type LaneMessage<T> =
  | { readonly lane: string; readonly kind: "event"; readonly event: T }
  | { readonly lane: string; readonly kind: "done" }
  | { readonly lane: string; readonly kind: "error"; readonly cause: unknown };

/**
 * consults nextBatch before every lane start; after a halt, abort or lane error
 * only running lanes finish. Lanes drain as they produce, as merge does
 */
export async function* runRolloutLanes<T>(
  lanes: RolloutLanes<T>,
): AsyncGenerator<T, RolloutEnd> {
  const started = new Set<string>();
  const settled = new Set<string>();
  const failed = new Set<string>();
  for (const lane of lanes.failedBeforeStart ?? []) {
    started.add(lane);
    settled.add(lane);
    failed.add(lane);
  }
  const progress: RolloutProgress = { started, settled, failed };
  const limit = lanes.limit !== undefined && lanes.limit > 0
    ? lanes.limit
    : Infinity;
  const messages: LaneMessage<T>[] = [];
  let wake: (() => void) | undefined;
  const post = (message: LaneMessage<T>) => {
    messages.push(message);
    wake?.();
    wake = undefined;
  };
  const drains: Promise<void>[] = [];
  const drain = async (lane: string) => {
    try {
      for await (const event of lanes.start(lane)) {
        post({ lane, kind: "event", event });
      }
      post({ lane, kind: "done" });
    } catch (cause) {
      post({ lane, kind: "error", cause });
    }
  };
  let running = 0;
  const announced = new Set<number>();
  let halted = false;
  let paused: string | undefined;
  let laneError: { readonly cause: unknown } | undefined;

  try {
    while (true) {
      while (
        !halted && paused === undefined && laneError === undefined &&
        !lanes.signal?.aborted && running < limit
      ) {
        const decision = nextBatch(progress, lanes.rollout);
        if (decision.kind === "halt") {
          halted = true;
          break;
        }
        if (decision.kind !== "start") break;
        // a gate opens only where the budget would start a lane
        if (lanes.held?.(decision.lanes[0]) === true) {
          paused = decision.lanes[0];
          break;
        }
        if (!announced.has(decision.batch)) {
          announced.add(decision.batch);
          yield lanes.batchStarted(
            decision.batch,
            lanes.rollout.batches[decision.batch],
          );
          if (lanes.signal?.aborted) break;
        }
        const lane = decision.lanes[0];
        started.add(lane);
        running++;
        drains.push(drain(lane));
      }
      if (running === 0 && messages.length === 0) {
        const stopped = halted || paused !== undefined ||
          laneError !== undefined || lanes.signal?.aborted;
        // a batch waits only on running lanes, so waiting with none would hang
        if (!stopped && nextBatch(progress, lanes.rollout).kind === "wait") {
          throw new Error("fan-out rollout is waiting with no lane running");
        }
        break;
      }
      if (messages.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      const message = messages.shift()!;
      if (message.kind === "event") {
        yield message.event;
        continue;
      }
      running--;
      settled.add(message.lane);
      if (message.kind === "error") {
        laneError ??= { cause: message.cause };
        failed.add(message.lane);
      } else if (lanes.failed(message.lane)) {
        failed.add(message.lane);
      }
    }
  } finally {
    // drains are still running only when the consumer stopped early
    await Promise.allSettled(drains);
  }
  if (laneError !== undefined) throw laneError.cause;
  if (lanes.signal?.aborted) return { kind: "aborted" };
  if (paused !== undefined) return { kind: "paused", lane: paused };
  if (halted) {
    const held = lanes.rollout.batches.flat().filter((lane) =>
      !started.has(lane)
    );
    if (held.length > 0) return { kind: "halted", held };
  }
  return { kind: "complete" };
}
