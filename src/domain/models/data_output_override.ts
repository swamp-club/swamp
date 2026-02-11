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
