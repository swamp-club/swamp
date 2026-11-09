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
import { INTEGRATION_ID_PATTERN } from "../../access/client.ts";
import { ModelType } from "../model_type.ts";
import { defineModel, type ModelDefinition } from "../model.ts";

export const DELEGATION_MODEL_TYPE = ModelType.create("swamp/delegation");

export const DELEGATION_DATA_NAME = "delegation-main";

export function delegationDefinitionName(id: string): string {
  return `delegation-${id}`;
}

const HASH = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const ID = z.string().uuid();

export const DelegationPhaseSchema = z.enum([
  "awaiting_consent",
  "reporting",
  "consented",
  "issued",
  "refused",
  "ended",
]);

export type DelegationPhase = z.infer<typeof DelegationPhaseSchema>;

// swamp-club's own limits, so a request it would refuse is refused here first
export const ExternalIdentitySchema = z.object({
  platform: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  teamId: z.string().min(1).max(128),
  userId: z.string().min(1).max(128),
  display: z.string().min(1).max(80),
  workspace: z.string().min(1).max(80),
  email: z.string().regex(/^[^\s@]+@[^\s@]+$/).max(254).optional(),
});

export type ExternalIdentity = z.infer<typeof ExternalIdentitySchema>;

export const LinkedPersonSchema = z.object({
  sub: z.string().min(1).max(200),
  username: z.string().max(200).optional(),
  email: z.string().max(320),
  collectives: z.array(z.string().max(200)).max(200),
  groups: z.array(z.string().max(200)).max(500),
});

export type LinkedPerson = z.infer<typeof LinkedPersonSchema>;

export const DelegationTokensSchema = z.object({
  accessHash: HASH,
  accessExpiresAt: z.string().datetime(),
  previousAccessHash: HASH.optional(),
  previousAccessExpiresAt: z.string().datetime().optional(),
  // a third access token; an older build reads only the legacy pair
  olderAccess: z.array(z.object({
    hash: HASH,
    expiresAt: z.string().datetime(),
  })).max(1).optional(),
  refreshHash: HASH,
  generation: z.number().int().min(1),
});

export const ClubEndStateSchema = z.enum(["none", "pending", "done"]);

export const DelegationSchema = z.object({
  id: ID,
  integrationId: z.string().regex(INTEGRATION_ID_PATTERN),
  external: ExternalIdentitySchema,
  // loose like an integration's, so a record this build can't read refuses
  // only its delegation
  ceiling: z.unknown(),
  ceilingDigest: z.string(),
  phase: DelegationPhaseSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  redeemHash: HASH,
  club: z.object({
    requestId: z.string().min(1).max(200),
    // what swamp-club bound the consent to; an approval must carry the same
    digest: z.string().min(1).max(200),
    consentExpiresAt: z.string().datetime(),
    pollIntervalSeconds: z.number().int().min(1).max(3600),
    linkId: z.string().min(1).max(200).optional(),
    endState: ClubEndStateSchema,
    endAttempts: z.number().int().min(0),
    nextEndAttemptAt: z.string().datetime().optional(),
    lastEndError: z.string().max(500).optional(),
  }),
  person: LinkedPersonSchema.optional(),
  consentedAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
  tokens: DelegationTokensSchema.optional(),
  refusal: z.object({
    reason: z.string().max(500),
    at: z.string().datetime(),
  }).optional(),
  ended: z.object({
    cause: z.string().max(100),
    at: z.string().datetime(),
  }).optional(),
});

export type DelegationRecord = z.infer<typeof DelegationSchema>;

/**
 * no methods: only serve's link service writes these, by direct record writes
 * under the record's lock, so no model run can mint a token by writing one
 */
export const delegationModel: ModelDefinition = defineModel({
  type: DELEGATION_MODEL_TYPE,
  version: "2026.11.09.1",
  resources: {
    "delegation": {
      description:
        "A person's link to an integration and its token state, stored as hashes only",
      schema: DelegationSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {},
});
