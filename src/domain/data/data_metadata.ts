// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

/**
 * Lifetime determines how long data should be retained.
 * - Duration strings: "1h", "5m", "10d", "2w", "1mo", "10y" (hours, minutes, days, weeks, months, years)
 * - "ephemeral": Deleted when the process ends
 * - "infinite": Never automatically deleted
 * - "job": Lives until the job completes
 * - "workflow": Lives until the workflow completes
 */
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
 * Garbage collection policy determines version retention.
 * - number: Keep N most recent versions
 * - duration string: Keep versions created within the duration
 */
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

/**
 * Normalizes zero-duration lifetime strings to "workflow".
 *
 * Zero-duration strings like "0h", "0d", "00w" produce 0ms when parsed,
 * which would cause data to expire immediately on creation. Instead,
 * we treat them as "workflow" lifetime — the data lives for the
 * duration of the workflow run.
 *
 * @param lifetime - The lifetime value to normalize
 * @returns The normalized lifetime (zero durations become "workflow")
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

/**
 * Lifecycle state of a data entry.
 * - "active": Normal, live data (default)
 * - "deleted": Tombstone marker — the cloud resource was deleted
 */
export const DataLifecycleSchema = z.enum(["active", "deleted"]);
export type DataLifecycle = z.infer<typeof DataLifecycleSchema>;

/**
 * Owner types that can create data.
 */
export const OwnerTypes = ["model-method", "workflow-step", "manual"] as const;
export type OwnerType = typeof OwnerTypes[number];

/**
 * Owner definition tracks who created/owns the data.
 * Ownership is validated by comparing ownerType + ownerRef.
 * definitionHash is retained for backward compatibility with existing data on disk.
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

/**
 * Complete metadata schema for Data entity.
 * Tags must include a 'type' key for categorization.
 */
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
  tags: z.record(z.string(), z.string()).refine(
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
