import { z } from "zod";
import {
  type GarbageCollectionPolicy,
  GarbageCollectionSchema,
  type Lifetime,
  LifetimeSchema,
} from "../data/mod.ts";

/**
 * Override for data output specification.
 * Value object - immutable.
 */
export interface DataOutputOverride {
  /** The spec name to override */
  specName: string;

  /** Override lifetime */
  lifetime?: Lifetime;

  /** Override garbage collection */
  garbageCollection?: GarbageCollectionPolicy;

  /** Additional tags to merge */
  tags?: Record<string, string>;
}

export const DataOutputOverrideSchema = z.object({
  specName: z.string().min(1),
  lifetime: LifetimeSchema.optional(),
  garbageCollection: GarbageCollectionSchema.optional(),
  tags: z.record(z.string(), z.string()).optional(),
});
