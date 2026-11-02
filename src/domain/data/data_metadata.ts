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
  BEHAVIOR_OWNER_TYPE,
  MODEL_OWNER_TYPE,
} from "../terminology/behavior_aliases.ts";
import { boundedRecord } from "../untrusted_parse.ts";

export const LifetimeSchema = z.union([
  z.string().regex(/^\d+(mo|y|h|m|d|w)$/, {
    message:
      "Duration must match pattern like '1h', '5m', '10d', '2w', '1mo', '10y'",
  }),
  z.literal("ephemeral"),
  z.literal("infinite"),
  z.literal("job"),
  z.literal("workflow"),
]);

export type Lifetime = z.infer<typeof LifetimeSchema>;

/**
 * ephemeral, job and workflow have no clear semantics for invocation records,
 * so only durations and infinite are valid
 */
export const OutputLifetimeSchema = z.union([
  z.string().regex(/^\d+(mo|y|h|m|d|w)$/, {
    message:
      "Duration must match pattern like '1h', '5m', '10d', '2w', '1mo', '10y'",
  }).refine((val) => {
    const match = val.match(/^(\d+)/);
    return match !== null && parseInt(match[1], 10) > 0;
  }, {
    message: "Output lifetime duration must be greater than zero",
  }),
  z.literal("infinite"),
]);

export type OutputLifetime = z.infer<typeof OutputLifetimeSchema>;

export function lifetimeToMs(lifetime: Lifetime): number | null {
  const match = lifetime.match(/^(\d+)(mo|y|h|m|d|w)$/);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case "mo":
      return value * 30 * 24 * 60 * 60 * 1000;
    case "y":
      return value * 365 * 24 * 60 * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "m":
      return value * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    case "w":
      return value * 7 * 24 * 60 * 60 * 1000;
    default:
      return null;
  }
}

export const GarbageCollectionSchema = z.union([
  z.number().int().positive(),
  z.string().regex(/^\d+(mo|y|h|m|d|w)$/, {
    message:
      "Duration must match pattern like '1h', '5m', '10d', '2w', '1mo', '10y'",
  }).refine((val) => {
    const match = val.match(/^(\d+)/);
    return match !== null && parseInt(match[1], 10) > 0;
  }, {
    message: "Garbage collection duration must be greater than zero",
  }),
]);

export type GarbageCollectionPolicy = z.infer<typeof GarbageCollectionSchema>;

export function garbageCollectionToColumn(
  policy: GarbageCollectionPolicy,
): string {
  return String(policy);
}

/**
 * empty means unknown (a row from an export written before the column existed)
 * and stays empty; foreign rows are not validated, so the result is typed
 * number or string
 */
export function garbageCollectionFromColumn(
  column: string,
): number | string {
  return /^\d+$/.test(column) ? Number(column) : column;
}

/**
 * zero-duration strings like 0h would expire data immediately, so they become
 * workflow lifetime
 */
export function normalizeLifetime(lifetime: Lifetime): Lifetime {
  if (typeof lifetime === "string") {
    const match = lifetime.match(/^(\d+)(mo|y|h|m|d|w)$/);
    if (match && parseInt(match[1], 10) === 0) {
      return "workflow";
    }
  }
  return lifetime;
}

export const DataLifecycleSchema = z.enum(["active", "deleted"]);
export type DataLifecycle = z.infer<typeof DataLifecycleSchema>;

/**
 * empty means unknown (a row from an export written before the column existed);
 * foreign rows are not validated, so any other value is unknown too rather than
 * a third state
 */
export function lifecycleFromColumn(column: string): DataLifecycle | "" {
  const parsed = DataLifecycleSchema.safeParse(column);
  return parsed.success ? parsed.data : "";
}

export const OwnerTypes = ["model-method", "workflow-step", "manual"] as const;
export type OwnerType = typeof OwnerTypes[number];

export function canonicalOwnerType(ownerType: string): string {
  return ownerType === BEHAVIOR_OWNER_TYPE ? MODEL_OWNER_TYPE : ownerType;
}

/**
 * definitionHash is retained for backward compatibility with existing data on
 * disk
 */
export const OwnerDefinitionSchema = z.object({
  definitionHash: z.string().min(1).optional(),
  ownerType: z.enum(OwnerTypes),
  ownerRef: z.string().min(1),
  workflowId: z.string().uuid().optional(),
  workflowRunId: z.string().uuid().optional(),
  workflowName: z.string().optional(),
  jobName: z.string().optional(),
  stepName: z.string().optional(),
  source: z.string().optional(),
});

export type OwnerDefinition = z.infer<typeof OwnerDefinitionSchema>;

export const MAX_DATA_TAGS = 10_000;

export const DataMetadataSchema = z.object({
  name: z.string().min(1).refine(
    (name) =>
      !name.includes("..") && !name.includes("/") && !name.includes("\\") &&
      !name.includes("\0"),
    {
      message:
        "Data name must not contain '..', '/', '\\', or null bytes (path traversal)",
    },
  ),
  id: z.string().uuid(),
  version: z.number().int().positive(),
  contentType: z.string().min(1),
  lifetime: LifetimeSchema,
  garbageCollection: GarbageCollectionSchema,
  streaming: z.boolean().default(false),
  // bounded because a datastore commit carries it from a caller; generous
  // because this schema also reads stored versions
  tags: boundedRecord(z.string(), z.string(), MAX_DATA_TAGS).refine(
    (tags) => "type" in tags,
    { message: "tags must include 'type' key" },
  ),
  ownerDefinition: OwnerDefinitionSchema,
  createdAt: z.string().datetime(),
  size: z.number().int().nonnegative().optional(),
  checksum: z.string().optional(),
  lifecycle: DataLifecycleSchema.optional(),
  renamedTo: z.string().min(1).optional(),
});

export type DataMetadata = z.infer<typeof DataMetadataSchema>;
