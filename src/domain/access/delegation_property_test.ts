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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import {
  delegationStanding,
  endDelegation,
  issueDelegationTokens,
  recordApproval,
  recordReported,
  refreshDelegation,
  refuseDelegation,
  supersessionOf,
} from "./delegation.ts";
import { consentedRecord, startedRecord } from "./delegation_test_helpers.ts";
import type { DelegationRecord } from "../models/access/delegation_model.ts";

const T0 = Date.parse("2026-11-09T00:00:00.000Z");
const PERSON = { sub: "s", email: "e@x", collectives: [], groups: [] };

type Op =
  | "approve"
  | "report"
  | "refuse"
  | "issue"
  | "refresh"
  | "wrong_refresh"
  | "end";

Deno.test("delegation lifecycle: tokens exist only while issued, a refresh never ends or changes the refresh token, and an ended delegation never stands again", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.constantFrom<Op>(
          "approve",
          "report",
          "refuse",
          "issue",
          "refresh",
          "wrong_refresh",
          "end",
        ),
        { maxLength: 12 },
      ),
      async (ops) => {
        let record: DelegationRecord = startedRecord();
        let refresh: string | undefined;
        let refreshHash: string | undefined;
        const stranger = (await issueDelegationTokens(consentedRecord(), T0))
          .tokens.refresh.value;
        let wasEnded = false;
        let issuedCount = 0;
        let now = T0;
        for (const op of ops) {
          now += 1000;
          try {
            if (op === "approve") record = recordApproval(record, PERSON, now);
            if (op === "report") record = recordReported(record, "l", now);
            if (op === "refuse") record = refuseDelegation(record, "r", now);
            if (op === "issue") {
              const out = await issueDelegationTokens(record, now);
              record = out.record;
              refresh = out.tokens.refresh.value;
              refreshHash = out.record.tokens?.refreshHash;
              issuedCount++;
            }
            if (op === "end") record = endDelegation(record, "operator", now);
            if (
              (op === "refresh" || op === "wrong_refresh") &&
              refresh !== undefined
            ) {
              const before = record;
              const out = await refreshDelegation(
                record,
                op === "wrong_refresh" ? stranger : refresh,
                now,
                delegationStanding(record, now, undefined),
              );
              if (out.kind === "refreshed") {
                assert(op === "refresh");
                record = out.record;
              } else {
                assert(record === before);
              }
            }
          } catch (error) {
            if (
              !(error instanceof Error &&
                error.name === "DelegationTransitionError")
            ) {
              throw error;
            }
          }
          assert((record.tokens !== undefined) === (record.phase === "issued"));
          assert(issuedCount <= 1);
          if (record.tokens !== undefined) {
            assertEquals(record.tokens.refreshHash, refreshHash);
            assert((record.tokens.olderAccess?.length ?? 0) <= 1);
          }
          if (record.phase === "ended" || record.phase === "refused") {
            wasEnded = true;
          }
          if (wasEnded) {
            assert(record.phase === "ended" || record.phase === "refused");
            assert(
              delegationStanding(record, now, undefined).kind !== "standing",
            );
          }
        }
      },
    ),
    { numRuns: 300 },
  );
});

Deno.test("supersession: ending or removing records never gives a superseded delegation standing back", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({
          user: fc.constantFrom("U1", "u1", "U2"),
          offset: fc.integer({ min: 0, max: 5 }),
        }),
        { minLength: 1, maxLength: 6 },
      ),
      fc.array(fc.nat(), { maxLength: 6 }),
      async (specs, removals) => {
        const records: DelegationRecord[] = [];
        for (const spec of specs) {
          const consented = consentedRecord({
            userId: spec.user,
            atMs: T0 + spec.offset * 1000,
          });
          records.push((await issueDelegationTokens(consented, T0)).record);
        }
        const initially = supersessionOf(records);
        let current = [...records];
        for (const pick of removals) {
          if (current.length === 0) break;
          const index = pick % current.length;
          const target = current[index];
          if (target.phase !== "ended") {
            current[index] = endDelegation(target, "operator", T0);
            continue;
          }
          // retention: only once everything it superseded has a written end
          const map = supersessionOf(current);
          const covers = current.filter((r) => map.get(r.id) === target.id);
          if (covers.every((r) => r.phase === "ended")) {
            current = current.filter((_, i) => i !== index);
          }
        }
        const after = supersessionOf(current);
        for (const record of current) {
          if (!initially.has(record.id)) continue;
          assert(
            delegationStanding(record, T0 + 10, after.get(record.id)).kind !==
              "standing",
          );
        }
      },
    ),
    { numRuns: 300 },
  );
});
