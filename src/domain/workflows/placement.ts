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
import type { FanOutLanePin } from "../remote/scheduler.ts";

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
  lane?: FanOutLanePin;
}

/**
 * child wins per field: undefined inherits from the parent, anything else
 * (including an explicit {} for labels) overrides
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
 * job affinity false opts out of workflow affinity; otherwise workflow affinity
 * pins to the run's worker and job affinity to the job's
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

export const NestedPlacementModeSchema = z.enum(["inherit", "own"]);

export type NestedPlacementMode = z.infer<typeof NestedPlacementModeSchema>;

/** the calling step's placement, resolved where it was called */
export const InheritedPlacementSchema = z.object({
  fields: PlacementFieldsSchema,
  affinityKey: z.string().min(1).optional(),
  source: z.object({
    workflowName: z.string().min(1),
    jobName: z.string().min(1),
    stepName: z.string().min(1),
  }),
});

export type InheritedPlacement = z.infer<typeof InheritedPlacementSchema>;

export function declaresPlacement(
  fields: PlacementFields | undefined,
): boolean {
  return fields !== undefined &&
    (fields.target !== undefined || fields.labels !== undefined ||
      fields.platform !== undefined);
}

/**
 * the caller's fields, unless the child places itself at any level: a child
 * that places itself is placed only by itself, so an inherited target can
 * never outrank the labels it chose
 */
export function inheritPlacement(
  inherited: InheritedPlacement | undefined,
  childLevels: ReadonlyArray<PlacementFields | undefined>,
): PlacementFields | undefined {
  if (inherited === undefined) return undefined;
  if (childLevels.some(declaresPlacement)) return undefined;
  return inherited.fields;
}

/**
 * the caller's pin holds unless the child places itself at any level or its
 * job opts out of affinity, so a child stays on the worker its caller is on
 */
export function inheritedAffinityKey(
  inherited: InheritedPlacement | undefined,
  childLevels: ReadonlyArray<PlacementFields | undefined>,
  childJobAffinity: boolean | undefined,
): string | undefined {
  if (inherited?.affinityKey === undefined) return undefined;
  if (childJobAffinity === false) return undefined;
  if (childLevels.some(declaresPlacement)) return undefined;
  return inherited.affinityKey;
}
