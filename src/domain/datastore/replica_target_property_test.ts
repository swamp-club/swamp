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

import { assertEquals } from "@std/assert";
import fc from "fast-check";
import { replicaTargetProblem as testingReplicaTargetProblem } from "../../../packages/testing/replica_target_conformance.ts";
import { replicaTargetProblem } from "./replica_target.ts";

const ALLOWED = {
  s3: ["type", "bucket", "prefix", "region", "endpoint", "forcePathStyle"],
  gcs: ["type", "bucket", "prefix"],
} as const;

const segment = fc.stringMatching(/^[a-z0-9_-]{1,8}$/);
const goodPrefix = fc.oneof(
  fc.constant(""),
  fc.array(segment, { minLength: 1, maxLength: 4 }).map((s) => s.join("/")),
);
const bucket = fc.stringMatching(/^[a-z0-9.-]{1,12}$/);
const type = fc.constantFrom("s3" as const, "gcs" as const);

Deno.test("replicaTargetProblem: a well-formed target is accepted", () => {
  fc.assert(
    fc.property(type, bucket, goodPrefix, (t, b, prefix) => {
      assertEquals(
        replicaTargetProblem({ type: t, bucket: b, prefix }),
        undefined,
      );
    }),
  );
});

Deno.test("replicaTargetProblem: any field outside the type's allowlist is refused, in both copies", () => {
  fc.assert(
    fc.property(
      type,
      bucket,
      goodPrefix,
      fc.string({ minLength: 1, maxLength: 16 }),
      fc.jsonValue(),
      (t, b, prefix, key, value) => {
        fc.pre(!(ALLOWED[t] as readonly string[]).includes(key));
        // `__proto__` as a literal key sets the prototype, not a field.
        fc.pre(key !== "__proto__");
        const target = { type: t, bucket: b, prefix, [key]: value };
        assertEquals(replicaTargetProblem(target) !== undefined, true);
        assertEquals(
          testingReplicaTargetProblem(target),
          replicaTargetProblem(target),
        );
      },
    ),
  );
});

Deno.test("replicaTargetProblem: a prefix with an empty, '.' or '..' segment is refused, in both copies", () => {
  const badSegment = fc.constantFrom("", ".", "..");
  fc.assert(
    fc.property(
      type,
      bucket,
      fc.array(segment, { maxLength: 3 }),
      badSegment,
      fc.array(segment, { maxLength: 3 }),
      (t, b, before, bad, after) => {
        const prefix = [...before, bad, ...after].join("/");
        fc.pre(prefix !== "");
        const target = { type: t, bucket: b, prefix };
        assertEquals(replicaTargetProblem(target) !== undefined, true, prefix);
        assertEquals(
          testingReplicaTargetProblem(target),
          replicaTargetProblem(target),
        );
      },
    ),
  );
});
