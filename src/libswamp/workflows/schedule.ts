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

/**
 * a pause is a control-plane record keyed by workflow id; the workflow
 * definition and serve.yaml are never edited. Serve skips cron fires of a
 * paused workflow; manual and webhook runs are unaffected.
 */

import {
  isSchedulePauseActiveAt,
  type SchedulePause,
  SchedulePauseReasonSchema,
  type SchedulePauseRepository,
  SchedulePauseSchema,
  SchedulePauseUntilSchema,
  unreadableSchedulePause,
} from "../../domain/workflows/schedule_pause.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import {
  createWorkflowId,
  type WorkflowId,
} from "../../domain/workflows/workflow_id.ts";
import {
  findWorkflowById,
  findWorkflowByIdOrName,
} from "../../domain/workflows/workflow_lookup.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import {
  effectiveSchedule,
  nextFireTime,
} from "../../domain/workflows/workflow_scheduler.ts";
import type { ControlPlaneStore } from "../../domain/datastore/control_plane_store.ts";
import { ControlPlaneSchedulePauseRepository } from "../../infrastructure/persistence/control_plane_schedule_pause_repository.ts";
import { ControlPlaneScheduleStateRepository } from "../../infrastructure/persistence/control_plane_schedule_state_repository.ts";
import type {
  MissedFire,
  ScheduleStateRepository,
} from "../../domain/workflows/schedule_state.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound, validationFailed } from "../errors.ts";
import { parseDuration } from "../data/search.ts";

const logger = getSwampLogger(["workflow", "schedule"]);

export type ScheduleSource = "definition" | "override";

export interface LiveSchedule {
  readonly workflowId: string;
  readonly workflowName: string;
  readonly cronExpression: string;
  readonly nextRun: Date | null;
}

export interface WorkflowScheduleDeps {
  workflowRepo: Pick<WorkflowRepository, "findById" | "findByName" | "findAll">;
  overrideSchedules: () => Promise<ReadonlyMap<string, string>>;
  pauses: SchedulePauseRepository;
  /** when absent, no schedule reports a missed fire */
  states?: ScheduleStateRepository;
  liveSchedules?: () => ReadonlyArray<LiveSchedule>;
  now: () => Date;
}

/**
 * Wires the schedule operations to the control-plane store serve checks
 * pauses in: the datastore's shared store, or the repository's filesystem
 * fallback (`.swamp/_control`).
 */
export function createWorkflowScheduleDeps(options: {
  workflowRepo: WorkflowScheduleDeps["workflowRepo"];
  controlPlaneStore: ControlPlaneStore;
  overrideSchedules: WorkflowScheduleDeps["overrideSchedules"];
  liveSchedules?: WorkflowScheduleDeps["liveSchedules"];
}): WorkflowScheduleDeps {
  return {
    workflowRepo: options.workflowRepo,
    overrideSchedules: options.overrideSchedules,
    pauses: new ControlPlaneSchedulePauseRepository(options.controlPlaneStore),
    states: new ControlPlaneScheduleStateRepository(options.controlPlaneStore),
    liveSchedules: options.liveSchedules,
    now: () => new Date(),
  };
}

export function overrideSchedulesOf(
  overrides: Iterable<[string, { readonly schedule?: string }]>,
): Map<string, string> {
  const schedules = new Map<string, string>();
  for (const [name, override] of overrides) {
    if (override.schedule !== undefined) schedules.set(name, override.schedule);
  }
  return schedules;
}

export interface WorkflowScheduleTarget {
  workflowIdOrName: string;
  /**
   * Treat `workflowIdOrName` as a workflow id the caller already resolved
   * and authorized, and look it up by id only.
   */
  byId?: boolean;
  expectedName?: string;
}

export interface WorkflowSchedulePauseInput extends WorkflowScheduleTarget {
  reason?: string;
  until?: string;
  pausedBy: string;
}

export interface WorkflowSchedulePauseData {
  workflowId: string;
  workflowName: string;
  schedule: string;
  reason?: string;
  pausedBy: string;
  pausedAt: string;
  until?: string;
  replaced: boolean;
}

export type WorkflowSchedulePauseEvent =
  | { kind: "pausing" }
  | { kind: "completed"; data: WorkflowSchedulePauseData }
  | { kind: "error"; error: SwampError };

export type WorkflowScheduleResumeInput = WorkflowScheduleTarget;

export interface WorkflowScheduleResumeData {
  workflowId: string;
  workflowName: string;
  wasPaused: boolean;
}

export type WorkflowScheduleResumeEvent =
  | { kind: "resuming" }
  | { kind: "completed"; data: WorkflowScheduleResumeData }
  | { kind: "error"; error: SwampError };

export interface ScheduleListEntry {
  workflowId: string;
  workflowName: string;
  schedule: string | null;
  source: ScheduleSource | null;
  nextRun: string | null;
  paused: boolean;
  reason?: string;
  pausedBy?: string;
  pausedAt?: string;
  until?: string;
  orphaned: boolean;
  lastMissed?: MissedFire;
}

export interface WorkflowScheduleListData {
  schedules: ScheduleListEntry[];
}

export type WorkflowScheduleListEvent =
  | { kind: "listing" }
  | { kind: "completed"; data: WorkflowScheduleListData }
  | { kind: "error"; error: SwampError };

export function parsePauseUntil(
  value: string,
  now: Date,
): { until: string } | { error: string } {
  const trimmed = value.trim();
  if (/^\d+(mo|y|h|m|d|w)$/.test(trimmed)) {
    const ms = parseDuration(trimmed);
    if (ms <= 0) return { error: "--until must be a duration above zero" };
    return untilAt(now.getTime() + ms, value);
  }
  if (!ISO_DATE_TIME.test(trimmed)) {
    return {
      error:
        `Invalid --until value: '${value}'. Use a duration such as 30m, 2h or 1d, or an ISO-8601 time with Z or an offset, such as 2026-01-31T09:00:00Z.`,
    };
  }
  // A time without a zone would be read in the local zone of whichever
  // process parses it: with --server, the server's, not the user's.
  if (!ISO_ZONE.test(trimmed)) {
    return {
      error:
        `--until ${value} has no time zone: add Z or an offset such as +02:00, or give a duration such as 2h.`,
    };
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) {
    return { error: `Invalid --until time: '${value}'.` };
  }
  if (at <= now.getTime()) {
    return { error: `--until ${value} is not in the future.` };
  }
  return untilAt(at, value);
}

const ISO_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/i;
const ISO_ZONE = /(Z|[+-]\d{2}:\d{2})$/i;

function untilAt(
  ms: number,
  value: string,
): { until: string } | { error: string } {
  const at = new Date(ms);
  if (Number.isFinite(at.getTime())) {
    const until = at.toISOString();
    if (SchedulePauseUntilSchema.safeParse(until).success) return { until };
  }
  return { error: `--until ${value} is too far in the future.` };
}

/**
 * A workflow's pause, where a record that exists but cannot be read counts as
 * an open-ended pause: resume still removes it, and a new pause replaces it.
 */
async function readPause(
  ctx: LibSwampContext,
  deps: WorkflowScheduleDeps,
  workflowId: WorkflowId,
): Promise<SchedulePause | null> {
  try {
    return await deps.pauses.get(workflowId);
  } catch (error) {
    ctx.logger
      .warn`Cannot read the schedule pause of workflow ${workflowId}; treating it as paused: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return unreadableSchedulePause(workflowId);
  }
}

function findTarget(
  deps: WorkflowScheduleDeps,
  target: WorkflowScheduleTarget,
): Promise<Workflow | null> {
  return target.byId
    ? findWorkflowById(
      deps.workflowRepo,
      target.workflowIdOrName,
      target.expectedName,
    )
    : findWorkflowByIdOrName(deps.workflowRepo, target.workflowIdOrName);
}

export async function* workflowSchedulePause(
  ctx: LibSwampContext,
  deps: WorkflowScheduleDeps,
  input: WorkflowSchedulePauseInput,
): AsyncIterable<WorkflowSchedulePauseEvent> {
  yield* withGeneratorSpan(
    "swamp.workflow.schedule.pause",
    { "workflow.id_or_name": input.workflowIdOrName },
    (async function* (): AsyncGenerator<WorkflowSchedulePauseEvent> {
      yield { kind: "pausing" };

      if (input.reason !== undefined) {
        const reason = SchedulePauseReasonSchema.safeParse(input.reason);
        if (!reason.success) {
          yield {
            kind: "error",
            error: validationFailed(reason.error.issues[0].message),
          };
          return;
        }
      }

      const now = deps.now();
      let until: string | undefined;
      if (input.until !== undefined) {
        const parsed = parsePauseUntil(input.until, now);
        if ("error" in parsed) {
          yield { kind: "error", error: validationFailed(parsed.error) };
          return;
        }
        until = parsed.until;
      }

      const workflow = await findTarget(deps, input);
      if (!workflow) {
        yield {
          kind: "error",
          error: notFound("Workflow", input.workflowIdOrName),
        };
        return;
      }

      const overrides = await deps.overrideSchedules();
      const schedule = effectiveSchedule(
        workflow.schedule ?? null,
        overrides.get(workflow.name),
      );
      if (schedule === null) {
        yield {
          kind: "error",
          error: validationFailed(
            `Workflow '${workflow.name}' has no schedule to pause: it has no trigger schedule and no serve.yaml trigger override.`,
          ),
        };
        return;
      }

      const existing = await readPause(ctx, deps, workflow.id);
      const candidate: SchedulePause = {
        workflowId: workflow.id,
        workflowName: workflow.name,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        pausedBy: input.pausedBy,
        pausedAt: now.toISOString(),
        ...(until !== undefined ? { until } : {}),
      };
      // Checked here as the save would, so a bad value is reported as a
      // validation error, never as the schema's own dump.
      const checked = SchedulePauseSchema.safeParse(candidate);
      if (!checked.success) {
        yield {
          kind: "error",
          error: validationFailed(checked.error.issues[0].message),
        };
        return;
      }
      const pause = checked.data;
      ctx.logger.debug`Pausing the schedule of workflow ${workflow.name}`;
      await deps.pauses.save(pause);

      yield {
        kind: "completed",
        data: {
          workflowId: pause.workflowId,
          workflowName: pause.workflowName,
          schedule,
          reason: pause.reason,
          pausedBy: pause.pausedBy,
          pausedAt: pause.pausedAt,
          until: pause.until,
          replaced: existing !== null && isSchedulePauseActiveAt(existing, now),
        },
      };
    })(),
  );
}

export async function* workflowScheduleResume(
  ctx: LibSwampContext,
  deps: WorkflowScheduleDeps,
  input: WorkflowScheduleResumeInput,
): AsyncIterable<WorkflowScheduleResumeEvent> {
  yield* withGeneratorSpan(
    "swamp.workflow.schedule.resume",
    { "workflow.id_or_name": input.workflowIdOrName },
    (async function* (): AsyncGenerator<WorkflowScheduleResumeEvent> {
      yield { kind: "resuming" };

      const workflow = await findTarget(deps, input);
      let workflowId: WorkflowId;
      let workflowName: string;
      let existing: SchedulePause | null;
      if (workflow) {
        workflowId = workflow.id;
        workflowName = workflow.name;
        existing = await readPause(ctx, deps, workflowId);
      } else {
        // An orphaned pause: its workflow is gone, so it is named by id.
        workflowId = createWorkflowId(input.workflowIdOrName);
        existing = await readPause(ctx, deps, workflowId);
        if (existing === null) {
          yield {
            kind: "error",
            error: notFound("Workflow", input.workflowIdOrName),
          };
          return;
        }
        workflowName = existing.workflowName;
      }

      if (existing !== null) {
        ctx.logger.debug`Resuming the schedule of workflow ${workflowName}`;
        await deps.pauses.delete(workflowId);
      }

      yield {
        kind: "completed",
        data: {
          workflowId,
          workflowName,
          wasPaused: existing !== null &&
            isSchedulePauseActiveAt(existing, deps.now()),
        },
      };
    })(),
  );
}

export async function* workflowScheduleList(
  _ctx: LibSwampContext,
  deps: WorkflowScheduleDeps,
): AsyncIterable<WorkflowScheduleListEvent> {
  yield* withGeneratorSpan(
    "swamp.workflow.schedule.list",
    {},
    (async function* (): AsyncGenerator<WorkflowScheduleListEvent> {
      yield { kind: "listing" };

      const now = deps.now();
      const overrides = await deps.overrideSchedules();
      const scheduled = deps.liveSchedules
        ? deps.liveSchedules().map((live) => ({
          workflowId: live.workflowId,
          workflowName: live.workflowName,
          schedule: live.cronExpression,
          source: (overrides.has(live.workflowName)
            ? "override"
            : "definition") as ScheduleSource,
          nextRun: live.nextRun,
        }))
        : await definedSchedules(deps, overrides, now);

      const pauses = new Map<string, SchedulePause>();
      for (const pause of await deps.pauses.list()) {
        pauses.set(pause.workflowId, pause);
      }

      const missed = await lastMissedFires(deps.states);

      const schedules: ScheduleListEntry[] = [];
      for (const entry of scheduled) {
        const pause = pauses.get(entry.workflowId);
        pauses.delete(entry.workflowId);
        const lastMissed = missed.get(entry.workflowId);
        schedules.push({
          workflowId: entry.workflowId,
          workflowName: entry.workflowName,
          schedule: entry.schedule,
          source: entry.source,
          nextRun: entry.nextRun?.toISOString() ?? null,
          orphaned: false,
          ...pauseFields(pause, now),
          ...(lastMissed ? { lastMissed } : {}),
        });
      }
      // Pauses that match no schedule. A lapsed one affects nothing and is
      // left out; an active one is shown so it can be resumed.
      for (const pause of pauses.values()) {
        if (!isSchedulePauseActiveAt(pause, now)) continue;
        schedules.push({
          workflowId: pause.workflowId,
          workflowName: pause.workflowName,
          schedule: null,
          source: null,
          nextRun: null,
          orphaned: true,
          ...pauseFields(pause, now),
        });
      }
      schedules.sort((a, b) => a.workflowName.localeCompare(b.workflowName));

      yield { kind: "completed", data: { schedules } };
    })(),
  );
}

/** missed fires are advisory, so a store that cannot be read only omits them */
async function lastMissedFires(
  states: ScheduleStateRepository | undefined,
): Promise<Map<string, MissedFire>> {
  const missed = new Map<string, MissedFire>();
  if (!states) return missed;
  try {
    for (const state of await states.list()) {
      if (state.lastMissed) missed.set(state.workflowId, state.lastMissed);
    }
  } catch (error) {
    logger.warn("Cannot read missed scheduled fires: {error}", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return missed;
}

function pauseFields(
  pause: SchedulePause | undefined,
  now: Date,
): Pick<
  ScheduleListEntry,
  "paused" | "reason" | "pausedBy" | "pausedAt" | "until"
> {
  if (!pause || !isSchedulePauseActiveAt(pause, now)) return { paused: false };
  return {
    paused: true,
    reason: pause.reason,
    pausedBy: pause.pausedBy,
    pausedAt: pause.pausedAt,
    until: pause.until,
  };
}

async function definedSchedules(
  deps: WorkflowScheduleDeps,
  overrides: ReadonlyMap<string, string>,
  now: Date,
): Promise<
  Array<{
    workflowId: string;
    workflowName: string;
    schedule: string;
    source: ScheduleSource;
    nextRun: Date | null;
  }>
> {
  const result = [];
  for (const workflow of await deps.workflowRepo.findAll()) {
    const override = overrides.get(workflow.name);
    const schedule = effectiveSchedule(workflow.schedule ?? null, override);
    if (schedule === null) continue;
    result.push({
      workflowId: workflow.id,
      workflowName: workflow.name,
      schedule,
      source:
        (override !== undefined ? "override" : "definition") as ScheduleSource,
      nextRun: nextFireTime(schedule, now),
    });
  }
  return result;
}
