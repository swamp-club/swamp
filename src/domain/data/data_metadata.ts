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
  }),
]);

export type GarbageCollectionPolicy = z.infer<typeof GarbageCollectionSchema>;

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
});

export type OwnerDefinition = z.infer<typeof OwnerDefinitionSchema>;

/**
 * Complete metadata schema for Data entity.
 * Tags must include a 'type' key for categorization.
 */
export const DataMetadataSchema = z.object({
  name: z.string().min(1),
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
});

export type DataMetadata = z.infer<typeof DataMetadataSchema>;
