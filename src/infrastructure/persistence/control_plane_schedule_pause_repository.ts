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
  type SchedulePause,
  type SchedulePauseRepository,
  SchedulePauseSchema,
  unreadableSchedulePause,
} from "../../domain/workflows/schedule_pause.ts";
import {
  createWorkflowId,
  type WorkflowId,
} from "../../domain/workflows/workflow_id.ts";
import { withDeadline } from "./datastore_format_marker_reader.ts";
import { workflowIdOfKey, workflowKey } from "./control_plane_workflow_key.ts";

const logger = getLogger(["swamp", "persistence", "schedule-pause"]);

const PAUSE_DIR = "schedule-pauses";
const PAUSE_PREFIX = `${PAUSE_DIR}/`;

/**
 * serve reads a workflow's pause before each fire, so a slow remote control
 * plane must not hold a fire longer than a drain waits
 */
export const SCHEDULE_PAUSE_READ_TIMEOUT_MS = 5_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * the control plane lets every serve instance sharing the datastore, and the
 * CLI, see the same pauses; the workflow definition and serve.yaml are never
 * touched
 */
export class ControlPlaneSchedulePauseRepository
  implements SchedulePauseRepository {
  constructor(
    private readonly store: ControlPlaneStore,
    private readonly readTimeoutMs = SCHEDULE_PAUSE_READ_TIMEOUT_MS,
  ) {}

  async get(
    workflowId: WorkflowId,
    options?: { signal?: AbortSignal },
  ): Promise<SchedulePause | null> {
    // Raced as well as cancelled: a store that ignores the signal is still
    // bounded by the deadline.
    const bytes = await withDeadline(
      (deadline) =>
        this.store.get(keyFor(workflowId), {
          signal: options?.signal
            ? AbortSignal.any([options.signal, deadline])
            : deadline,
        }),
      this.readTimeoutMs,
    );
    if (bytes === null) return null;
    return parsePause(bytes, workflowId);
  }

  async list(): Promise<SchedulePause[]> {
    const keys = await this.store.list(PAUSE_DIR);
    const pauses: SchedulePause[] = [];
    for (const key of keys) {
      const workflowId = workflowIdOf(key);
      if (workflowId === null) continue;
      let pause: SchedulePause | null;
      try {
        pause = await this.get(workflowId);
      } catch (error) {
        // One record that cannot be read never hides the others; it is
        // listed as paused, as a corrupt one is, so resume can clear it.
        logger
          .warn`Cannot read the schedule pause of workflow ${workflowId}; listing it as paused: ${
          error instanceof Error ? error.message : String(error)
        }`;
        pause = unreadableSchedulePause(workflowId);
      }
      if (pause) pauses.push(pause);
    }
    return pauses;
  }

  async save(pause: SchedulePause): Promise<void> {
    const valid = SchedulePauseSchema.parse(pause);
    await this.store.put(
      keyFor(createWorkflowId(valid.workflowId)),
      encoder.encode(JSON.stringify(valid)),
    );
  }

  async delete(workflowId: WorkflowId): Promise<void> {
    await this.store.delete(keyFor(workflowId));
  }
}

function keyFor(workflowId: WorkflowId): string {
  return workflowKey(PAUSE_PREFIX, workflowId);
}

function workflowIdOf(key: string): WorkflowId | null {
  return workflowIdOfKey(PAUSE_PREFIX, key);
}

/**
 * Parses a stored pause. A record that does not parse, or names another
 * workflow, is reported as a pause with no expiry: a corrupt record keeps
 * the schedule paused, and resume can still remove it.
 */
function parsePause(
  bytes: Uint8Array,
  workflowId: WorkflowId,
): SchedulePause {
  try {
    const parsed = SchedulePauseSchema.safeParse(
      JSON.parse(decoder.decode(bytes)),
    );
    if (parsed.success && parsed.data.workflowId === workflowId) {
      return parsed.data;
    }
  } catch {
    // Falls through to the fail-safe pause below.
  }
  logger
    .warn`Unreadable schedule pause for workflow ${workflowId}; keeping its schedule paused`;
  return unreadableSchedulePause(workflowId);
}
