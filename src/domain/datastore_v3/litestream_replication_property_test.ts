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

import fc from "fast-check";
import { assert, assertEquals } from "@std/assert";
import { isReplicated, syncCoverage } from "./litestream_replication.ts";

Deno.test("syncCoverage: never confirms below the target, and agrees with isReplicated without one", () => {
  const txid = fc.oneof(
    fc.integer({ min: 0, max: 2 ** 40 }),
    fc.bigInt({ min: 0n, max: 2n ** 63n }).map((n) =>
      n.toString(16).padStart(16, "0")
    ),
  );
  const asBig = (value: number | string) =>
    typeof value === "number" ? BigInt(value) : BigInt(`0x${value}`);
  fc.assert(
    fc.property(
      fc.constantFrom("synced", "no_change"),
      txid,
      txid,
      fc.option(fc.bigInt({ min: 0n, max: 2n ** 63n }), { nil: undefined }),
      (status, local, remote, target) => {
        const response = { status, txid: local, replicated_txid: remote };
        const coverage = syncCoverage(response, target);
        const goal = target ?? asBig(local);
        if (coverage.kind === "confirmed") assert(asBig(remote) >= goal);
        else assertEquals(coverage, { kind: "short", target: goal });
        if (target === undefined) {
          assertEquals(coverage.kind === "confirmed", isReplicated(response));
        }
      },
    ),
  );
});
