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

import { getLogger } from "@logtape/logtape";
import type { ControlPlaneStore } from "../../domain/datastore/control_plane_store.ts";
import {
  type ScheduleState,
  type ScheduleStateRepository,
  ScheduleStateSchema,
} from "../../domain/workflows/schedule_state.ts";
import {
  createWorkflowId,
  type WorkflowId,
} from "../../domain/workflows/workflow_id.ts";
import { withDeadline } from "./datastore_format_marker_reader.ts";
import { workflowIdOfKey, workflowKey } from "./control_plane_workflow_key.ts";

const logger = getLogger(["swamp", "persistence", "schedule-state"]);

const STATE_DIR = "schedule-states";
const STATE_PREFIX = `${STATE_DIR}/`;

/**
 * serve writes a schedule's state on every fire, so a slow remote control plane
 * must not hold a fire longer than a drain waits
 */
export const SCHEDULE_STATE_TIMEOUT_MS = 5_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface ScheduleStateRepositoryOptions {
  /**
   * read on every save: the instance that runs fires owns the watermark, and
   * a follower promoted later must start writing without a rebuild
   */
  readonly canWrite?: () => boolean;
  readonly timeoutMs?: number;
}

/** shared through the control plane so every serve instance sees one watermark */
export class ControlPlaneScheduleStateRepository
  implements ScheduleStateRepository {
  private readonly canWrite: () => boolean;
  private readonly timeoutMs: number;

  constructor(
    private readonly store: ControlPlaneStore,
    options: ScheduleStateRepositoryOptions = {},
  ) {
    this.canWrite = options.canWrite ?? (() => true);
    this.timeoutMs = options.timeoutMs ?? SCHEDULE_STATE_TIMEOUT_MS;
  }

  async get(
    workflowId: WorkflowId,
    options?: { signal?: AbortSignal },
  ): Promise<ScheduleState | null> {
    const bytes = await withDeadline(
      (deadline) =>
        this.store.get(workflowKey(STATE_PREFIX, workflowId), {
          signal: options?.signal
            ? AbortSignal.any([options.signal, deadline])
            : deadline,
        }),
      this.timeoutMs,
    );
    if (bytes === null) return null;
    return parseState(bytes, workflowId);
  }

  async list(options?: { signal?: AbortSignal }): Promise<ScheduleState[]> {
    const signal = options?.signal;
    signal?.throwIfAborted();
    // store.list takes no signal, so a hung list is abandoned, not stopped
    const keys = await withDeadline(
      () => this.store.list(STATE_DIR),
      this.timeoutMs,
    );
    const states: ScheduleState[] = [];
    for (const key of keys) {
      signal?.throwIfAborted();
      const workflowId = workflowIdOfKey(STATE_PREFIX, key);
      if (workflowId === null) continue;
      try {
        const state = await this.get(workflowId, { signal });
        if (state) states.push(state);
      } catch (error) {
        signal?.throwIfAborted();
        logger.warn`Cannot read the schedule state of workflow ${workflowId}: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
    return states;
  }

  async save(state: ScheduleState): Promise<boolean> {
    if (!this.canWrite()) return false;
    const valid = ScheduleStateSchema.parse(state);
    const key = workflowKey(STATE_PREFIX, createWorkflowId(valid.workflowId));
    const bytes = encoder.encode(JSON.stringify(valid));
    await withDeadline(() => this.store.put(key, bytes), this.timeoutMs);
    return true;
  }
}

/**
 * a record that does not parse, or names another workflow, reads as absent:
 * the next boot then seeds a fresh watermark rather than catching up from a
 * time it cannot trust
 */
function parseState(
  bytes: Uint8Array,
  workflowId: WorkflowId,
): ScheduleState | null {
  try {
    const parsed = ScheduleStateSchema.safeParse(
      JSON.parse(decoder.decode(bytes)),
    );
    if (parsed.success && parsed.data.workflowId === workflowId) {
      return parsed.data;
    }
  } catch {
    // unparseable JSON reads as absent, like a record that fails the schema
  }
  logger
    .warn`Unreadable schedule state for workflow ${workflowId}; treating it as absent`;
  return null;
}
