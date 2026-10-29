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

export const PlacementFieldsSchema = z.object({
  target: z.string().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  platform: z.string().optional(),
  queueTimeout: z.number().nonnegative().optional(),
});

export type PlacementFields = z.infer<typeof PlacementFieldsSchema>;

export interface ResolvedPlacement {
  target?: string;
  labels?: Record<string, string>;
  platform?: string;
  queueTimeoutMs?: number;
  affinityKey?: string;
}

/**
 * Merges placement layers with child-wins semantics: for each field,
 * if the child's value is undefined (omitted), inherit from parent;
 * if the child's value is anything else (including explicit {} for labels),
 * use the child's value.
 */
export function mergePlacementFields(
  parent: PlacementFields | undefined,
  child: PlacementFields | undefined,
): PlacementFields | undefined {
  if (parent === undefined && child === undefined) return undefined;
  if (parent === undefined) return child;
  if (child === undefined) return parent;
  return {
    target: child.target !== undefined ? child.target : parent.target,
    labels: child.labels !== undefined ? child.labels : parent.labels,
    platform: child.platform !== undefined ? child.platform : parent.platform,
    queueTimeout: child.queueTimeout !== undefined
      ? child.queueTimeout
      : parent.queueTimeout,
  };
}

/**
 * Resolves merged placement fields into the dispatching form, or undefined
 * when no placement is active (step runs on the loopback executor).
 */
export function resolvePlacement(
  fields: PlacementFields | undefined,
): ResolvedPlacement | undefined {
  if (fields === undefined) return undefined;
  if (
    fields.target === undefined && fields.platform === undefined &&
    (fields.labels === undefined || Object.keys(fields.labels).length === 0)
  ) {
    return undefined;
  }
  return {
    target: fields.target,
    labels: fields.labels,
    platform: fields.platform,
    queueTimeoutMs: fields.queueTimeout !== undefined
      ? fields.queueTimeout * 1000
      : undefined,
  };
}

/**
 * Resolves the worker affinity key for a step from its workflow's and job's
 * `affinity` settings. A job that sets `affinity: false` opts out of
 * workflow-level affinity, so its steps are placed independently. Otherwise
 * workflow-level affinity pins the step to the run's worker (also when the
 * job sets `affinity: true`), and job-level affinity pins it to the job's.
 */
export function resolveAffinityKey(
  workflowAffinity: boolean | undefined,
  jobAffinity: boolean | undefined,
  runId: string,
  jobName: string,
): string | undefined {
  if (jobAffinity === false) return undefined;
  if (workflowAffinity) return runId;
  if (jobAffinity) return `${runId}:${jobName}`;
  return undefined;
}
