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

/** the serve process holding a bookkeeping record's in-memory counterpart */
export const OrchestratorOwnerSchema = z.object({
  instanceId: z.string().min(1),
  pid: z.number().int().positive(),
  /** processHostIdentity() of the owner, which places its pid on this kernel */
  host: z.string().optional(),
});

export type OrchestratorOwner = z.infer<typeof OrchestratorOwnerSchema>;

// a malformed owner reads as none, so the record is still readable and is
// settled as an ownerless one
export const RecordOwnerField = OrchestratorOwnerSchema.optional().catch(
  undefined,
);
