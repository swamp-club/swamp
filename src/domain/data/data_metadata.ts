import { z } from "zod";

/**
 * Lifetime determines how long data should be retained.
 * - Duration strings: "1h", "5m", "10d", "2w" (hours, minutes, days, weeks)
 * - "ephemeral": Deleted when the process ends
 * - "infinite": Never automatically deleted
 * - "Job": Lives until the job completes
 * - "Workflow": Lives until the workflow completes
 */
export const LifetimeSchema = z.union([
  z.string().regex(/^\d+[hmdw]$/, {
    message: "Duration must match pattern like '1h', '5m', '10d', '2w'",
  }),
  z.literal("ephemeral"),
  z.literal("infinite"),
  z.literal("Job"),
  z.literal("Workflow"),
]);

export type Lifetime = z.infer<typeof LifetimeSchema>;

/**
 * Garbage collection policy determines version retention.
 * - number: Keep N most recent versions
 * - duration string: Keep versions created within the duration
 */
export const GarbageCollectionSchema = z.union([
  z.number().int().positive(),
  z.string().regex(/^\d+[hmdw]$/, {
    message: "Duration must match pattern like '1h', '5m', '10d', '2w'",
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
 * The definitionHash allows ownership validation on updates.
 */
export const OwnerDefinitionSchema = z.object({
  definitionHash: z.string().min(1),
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

/**
 * Computes a hash of the owner definition for comparison.
 * This is used to verify that updates come from the same owner.
 */
export async function computeDefinitionHash(
  ownerType: OwnerType,
  ownerRef: string,
): Promise<string> {
  const input = `${ownerType}:${ownerRef}`;
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
