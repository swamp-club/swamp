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

import { z } from "zod";
import {
  type NestedRunRef,
  NestedRunRefSchema,
  type ParentRunRef,
  ParentRunRefSchema,
} from "./nested_run_ref.ts";

/**
 * listing paths must not reconstruct the aggregate: step outputs are unbounded,
 * so hydrating every run makes peak memory scale with on-disk run size and OOMs
 * on large histories
 */
export interface WorkflowRunSummary {
  id: string;
  workflowId: string;
  workflowName: string;
  status: string;
  startedAt?: Date;
  completedAt?: Date;
  tags: Record<string, string>;
  inputs: Record<string, unknown>;
  instanceId?: string;
  triggerSource?: string;
  failedStep?: string;
  failureReason?: string;
  stepProgress?: { completed: number; total: number };
  awaitingResume?: boolean;
  parentRun?: ParentRunRef;
  /**
   * a run waiting on any is not awaitingResume; whether it can resume is
   * derived from the children
   */
  waitingOnRun?: NestedRunRef[];
  waitsOnlyOnNestedRuns?: boolean;
  /** keys whose values only the run's record holds: inputs lacks them */
  inputsOmitted?: string[];
  startKeyLookup?: string;
}

export const INDEXED_INPUT_MAX_BYTES = 1024;
export const INDEXED_INPUTS_MAX_BYTES = 8 * 1024;

export interface IndexedInputs {
  inputs: Record<string, unknown>;
  omitted: string[];
}

const utf8 = new TextEncoder();

function encodedBytes(value: unknown): number | undefined {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? undefined : utf8.encode(json).length;
  } catch {
    return undefined;
  }
}

/**
 * what a run's summary may carry wherever every run's summary is held at once:
 * a run's inputs are unbounded, so a listing that kept them all would grow with
 * the bytes of its history rather than its runs
 */
export function boundIndexedInputs(
  inputs: Readonly<Record<string, unknown>>,
): IndexedInputs {
  const kept: Record<string, unknown> = {};
  const omitted: string[] = [];
  let total = 0;
  for (const [key, value] of Object.entries(inputs)) {
    const bytes = encodedBytes(value);
    if (
      bytes === undefined || bytes > INDEXED_INPUT_MAX_BYTES ||
      total + bytes > INDEXED_INPUTS_MAX_BYTES
    ) {
      omitted.push(key);
      continue;
    }
    // a key named __proto__ is an input like any other, not a prototype
    Object.defineProperty(kept, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    total += bytes;
  }
  return { inputs: kept, omitted };
}

/** the summary as a listing holds it, whether read from the index or a record */
export function boundSummaryInputs(
  summary: WorkflowRunSummary,
): WorkflowRunSummary {
  const { inputs, omitted } = boundIndexedInputs(summary.inputs);
  if (omitted.length === 0) return summary;
  return { ...summary, inputs, inputsOmitted: omitted };
}

/**
 * lenient on purpose: status is a bare string and ids are not UUID-validated,
 * so a listing is never blocked by a malformed field the summary never reads
 */
const WorkflowRunSummarySchema = z.object({
  id: z.string().min(1),
  workflowId: z.string().min(1),
  workflowName: z.string().min(1),
  status: z.string().min(1),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  tags: z.record(z.string(), z.string()).default({}),
  inputs: z.record(z.string(), z.unknown()).default({}),
  instanceId: z.string().optional(),
  triggerSource: z.string().optional(),
  failedStep: z.string().optional(),
  failureReason: z.string().optional(),
  stepProgress: z.object({
    completed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }).optional(),
  awaitingResume: z.boolean().optional(),
  // a malformed key never blocks a listing; the record is what a retry trusts
  startKey: z.object({ lookup: z.string() }).optional().catch(undefined),
});

/**
 * only step status strings are read and only a boolean kept, so nothing from
 * the heavy subtree is retained
 */
function deriveAwaitingResume(
  data: unknown,
  status: string,
): true | undefined {
  if (status !== "suspended") return undefined;
  const jobs = (data as { jobs?: unknown }).jobs;
  if (!Array.isArray(jobs)) return undefined;
  for (const job of jobs) {
    const steps = (job as { steps?: unknown } | null)?.steps;
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      const stepStatus = (step as { status?: unknown } | null)?.status;
      if (
        stepStatus === "waiting_approval" || stepStatus === "waiting" ||
        stepStatus === "waiting_signal"
      ) {
        return undefined;
      }
    }
  }
  return true;
}

function deriveWaitingOnRun(
  data: unknown,
): { waitingOnRun?: NestedRunRef[]; waitsOnlyOnNestedRuns?: true } {
  const jobs = (data as { jobs?: unknown }).jobs;
  if (!Array.isArray(jobs)) return {};
  const result: NestedRunRef[] = [];
  let gateWaits = false;
  let nestedWaits = false;
  for (const job of jobs) {
    const steps = (job as { steps?: unknown } | null)?.steps;
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      const s = step as { status?: unknown; nestedRun?: unknown } | null;
      // A wait for a signal is a wait of the run's own, as a gate is.
      if (s?.status === "waiting" || s?.status === "waiting_signal") {
        gateWaits = true;
        continue;
      }
      if (s?.status !== "waiting_approval") continue;
      if (s.nestedRun === undefined) {
        gateWaits = true;
        continue;
      }
      nestedWaits = true;
      const link = NestedRunRefSchema.safeParse(s.nestedRun);
      if (link.success) result.push(link.data);
    }
  }
  return {
    ...(result.length > 0 ? { waitingOnRun: result } : {}),
    ...(nestedWaits && !gateWaits ? { waitsOnlyOnNestedRuns: true } : {}),
  };
}

/**
 * retained strings are detached by a JSON round-trip because parser sliced
 * strings pin the whole source buffer, and thousands of them reproduce the OOM
 * this projection prevents
 */
export function parseWorkflowRunSummary(data: unknown): WorkflowRunSummary {
  const v = WorkflowRunSummarySchema.parse(data);
  // Links are validated leniently: a malformed one is left out, never fails
  // the summary.
  const parentRun = ParentRunRefSchema.safeParse(
    (data as { parentRun?: unknown }).parentRun,
  );
  const detached = JSON.parse(
    JSON.stringify({
      id: v.id,
      workflowId: v.workflowId,
      workflowName: v.workflowName,
      status: v.status,
      tags: v.tags,
      inputs: v.inputs,
      instanceId: v.instanceId,
      triggerSource: v.triggerSource,
      failedStep: v.failedStep,
      failureReason: v.failureReason,
      stepProgress: v.stepProgress,
      startKeyLookup: v.startKey?.lookup,
      parentRun: parentRun.success ? parentRun.data : undefined,
      ...deriveWaitingOnRun(data),
    }),
  ) as {
    id: string;
    workflowId: string;
    workflowName: string;
    status: string;
    tags: Record<string, string>;
    inputs: Record<string, unknown>;
    instanceId?: string;
    triggerSource?: string;
    failedStep?: string;
    failureReason?: string;
    stepProgress?: { completed: number; total: number };
    startKeyLookup?: string;
    parentRun?: ParentRunRef;
    waitingOnRun?: NestedRunRef[];
    waitsOnlyOnNestedRuns?: boolean;
  };
  return {
    id: detached.id,
    workflowId: detached.workflowId,
    workflowName: detached.workflowName,
    status: detached.status,
    startedAt: v.startedAt ? new Date(v.startedAt) : undefined,
    completedAt: v.completedAt ? new Date(v.completedAt) : undefined,
    tags: detached.tags,
    inputs: detached.inputs,
    instanceId: detached.instanceId,
    triggerSource: detached.triggerSource,
    failedStep: detached.failedStep,
    failureReason: detached.failureReason,
    stepProgress: detached.stepProgress,
    awaitingResume: v.awaitingResume ?? deriveAwaitingResume(data, v.status),
    parentRun: detached.parentRun,
    waitingOnRun: detached.waitingOnRun,
    waitsOnlyOnNestedRuns: detached.waitsOnlyOnNestedRuns,
    startKeyLookup: detached.startKeyLookup,
  };
}
