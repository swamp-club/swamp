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

import { assert } from "@std/assert";
import fc from "fast-check";
import {
  decideAfterCheck,
  decideBeforeCheck,
  FAIL_OPEN_WINDOW_SECONDS,
  type IdentityCheckOutcome,
  type LocalProofVerdict,
} from "./auth_gate_policy.ts";

const arbTime = fc.integer({ min: 0, max: 4_000_000_000 });

const arbProof: fc.Arbitrary<LocalProofVerdict> = fc.oneof(
  fc.record({
    kind: fc.constant("valid" as const),
    source: fc.constantFrom("signin_token" as const, "file" as const),
    issuedAt: arbTime,
  }),
  fc.constant({ kind: "missing" as const }),
  fc.record({ kind: fc.constant("expired" as const), issuedAt: arbTime }),
  fc.record({ kind: fc.constant("invalid" as const), reason: fc.string() }),
);

const arbOutcome: fc.Arbitrary<IdentityCheckOutcome> = fc.oneof(
  fc.record({
    kind: fc.constant("verified" as const),
    freshProof: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant("rejected" as const),
    status: fc.constantFrom(401, 403),
  }),
  fc.record({
    kind: fc.constant("server_error" as const),
    status: fc.integer({ min: 500, max: 599 }),
  }),
  fc.record({
    kind: fc.constant("refused" as const),
    status: fc.constantFrom(403, 429),
  }),
  fc.record({ kind: fc.constant("unreachable" as const), reason: fc.string() }),
);

const arbSince = fc.option(
  fc.oneof(arbTime, fc.constantFrom(NaN, Infinity, -Infinity)),
  { nil: undefined },
);

Deno.test("auth gate property: no credential always blocks", () => {
  fc.assert(
    fc.property(arbProof, arbTime, arbSince, (proof, now, last) => {
      const d = decideBeforeCheck({
        credentialPresent: false,
        proof,
        lastTokenCheckAt: last,
        now,
      });
      return d.kind === "block" && d.reason.kind === "no_credential";
    }),
  );
});

Deno.test("auth gate property: a rejection never passes", () => {
  fc.assert(
    fc.property(
      arbProof,
      fc.constantFrom(401, 403),
      arbSince,
      arbTime,
      (proof, status, since, now) =>
        decideAfterCheck({
          proof,
          outcome: { kind: "rejected", status },
          failOpenSince: since,
          now,
        }).decision.kind === "block",
    ),
  );
});

Deno.test("auth gate property: a non-rejection never blocks a valid proof", () => {
  fc.assert(
    fc.property(
      arbProof.filter((p) => p.kind === "valid"),
      arbOutcome.filter((o) => o.kind !== "rejected"),
      arbSince,
      arbTime,
      (proof, outcome, since, now) =>
        decideAfterCheck({ proof, outcome, failOpenSince: since, now })
          .decision.kind === "pass",
    ),
  );
});

Deno.test("auth gate property: refused or unreachable without a valid proof always blocks", () => {
  fc.assert(
    fc.property(
      arbProof.filter((p) => p.kind !== "valid"),
      arbOutcome.filter((o) =>
        o.kind === "refused" || o.kind === "unreachable"
      ),
      arbSince,
      arbTime,
      (proof, outcome, since, now) =>
        decideAfterCheck({ proof, outcome, failOpenSince: since, now })
          .decision.kind === "block",
    ),
  );
});

Deno.test("auth gate property: fail-open without a proof never outlasts 24 hours", () => {
  fc.assert(
    fc.property(
      arbProof.filter((p) => p.kind !== "valid"),
      arbSince,
      arbTime,
      (proof, since, now) => {
        const { decision, effects } = decideAfterCheck({
          proof,
          outcome: { kind: "server_error", status: 503 },
          failOpenSince: since,
          now,
        });
        if (decision.kind !== "pass") return true;
        // A pass either starts a window at now, or runs inside one that
        // began in the past less than 24 hours ago. A future or non-finite
        // stamp never counts as a running window.
        if (effects.markFailOpen) return true;
        assert(since !== undefined && Number.isFinite(since));
        return since <= now && now - since < FAIL_OPEN_WINDOW_SECONDS;
      },
    ),
  );
});
