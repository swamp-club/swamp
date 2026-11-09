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

import { Ceiling } from "./ceiling.ts";
import {
  recordApproval,
  recordReported,
  startDelegation,
} from "./delegation.ts";
import type { DelegationRecord } from "../models/access/delegation_model.ts";

export const T0 = Date.parse("2026-11-09T00:00:00.000Z");
const HASH = `sha256:${"a".repeat(64)}`;

export function startedRecord(
  overrides: { id?: string; userId?: string; integrationId?: string } = {},
): DelegationRecord {
  return startDelegation({
    id: overrides.id ?? crypto.randomUUID(),
    integrationId: overrides.integrationId ?? "slack-bot",
    external: {
      platform: "Slack",
      teamId: " T1 ",
      userId: overrides.userId ?? "U1",
      display: "Pat",
      workspace: "Acme",
    },
    ceiling: Ceiling.parse({
      version: 1,
      ceiling: [{ actions: ["run", "read"], resource: "workflow:deploy" }],
    }),
    ceilingDigest: "sha256:digest",
    redeemHash: HASH,
    requestId: "req-1",
    consentExpiresAt: new Date(T0 + 600_000).toISOString(),
    pollIntervalSeconds: 5,
  }, T0);
}

export const PERSON = {
  sub: "sub-1",
  username: "pat",
  email: "pat@example.com",
  collectives: ["skunk-ape"],
  groups: [],
};

export function consentedRecord(
  overrides: { id?: string; userId?: string; atMs?: number } = {},
): DelegationRecord {
  const at = overrides.atMs ?? T0;
  return recordReported(
    recordApproval(startedRecord(overrides), PERSON, at),
    "link-1",
    at,
  );
}
