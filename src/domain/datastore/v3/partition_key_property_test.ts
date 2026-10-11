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
import { ModelType } from "../../models/model_type.ts";
import {
  type AggregateIdentity,
  DEFINITION_KINDS,
  PartitionKey,
  partitionOf,
} from "./partition_key.ts";

/** Letters, digits and every character the key format must survive. */
const CHARS = [
  ..."abcdefghijklmnopqrstuvwxyzABCDEF0123456789",
  "-",
  "--",
  "_",
  "@",
  "/",
  ".",
  ":",
  " ",
  "%",
  "%2F",
  "é",
  "日",
  "İ",
  "😀",
];

const arbText = fc.array(fc.constantFrom(...CHARS), {
  minLength: 1,
  maxLength: 16,
}).map((parts) => parts.join(""));

const arbModelType = arbText.filter((raw) => {
  try {
    ModelType.create(raw);
    return true;
  } catch {
    return false;
  }
}).map((raw) => ModelType.create(raw));

const arbIdentity: fc.Arbitrary<AggregateIdentity> = fc.oneof(
  fc.record({
    kind: fc.constant("model" as const),
    type: arbModelType,
    id: fc.uuid(),
  }),
  fc.record({
    kind: fc.constant("run" as const),
    workflowId: fc.uuid(),
    runId: fc.uuid(),
  }),
  fc.record({
    kind: fc.constant("config" as const),
    definitionKind: fc.constantFrom(...DEFINITION_KINDS),
    name: arbText,
  }),
  fc.constant({ kind: "lockfile" as const }),
  fc.record({ kind: fc.constant("definition" as const), id: fc.uuid() }),
);

Deno.test("PartitionKey.parse: round-trips every key partitionOf builds", () => {
  fc.assert(
    fc.property(arbIdentity, (identity) => {
      const key = partitionOf(identity);
      const parsed = PartitionKey.parse(key.toString());
      assertEquals(parsed.toString(), key.toString());
      assertEquals(parsed.identity, key.identity);
      assert(parsed.equals(key) && key.equals(parsed));
    }),
    { numRuns: 500 },
  );
});

Deno.test("partitionOf: distinct identities give distinct keys", () => {
  fc.assert(
    fc.property(arbIdentity, arbIdentity, (a, b) => {
      const ka = partitionOf(a);
      const kb = partitionOf(b);
      assertEquals(
        ka.equals(kb),
        JSON.stringify(ka.identity) === JSON.stringify(kb.identity),
      );
      assertEquals(ka.equals(kb), kb.equals(ka));
    }),
    { numRuns: 500 },
  );
});

Deno.test("partitionOf: equivalent model type spellings give one key", () => {
  fc.assert(
    fc.property(arbModelType, fc.uuid(), (type, id) => {
      const spellings = [
        type.normalized.toUpperCase(),
        type.normalized.replaceAll("/", "::"),
        type.normalized.replaceAll("/", "."),
        `/${type.normalized}/`,
      ];
      const key = partitionOf({ kind: "model", type, id });
      for (const raw of spellings) {
        let other: ModelType;
        try {
          other = ModelType.create(raw);
        } catch {
          continue;
        }
        if (other.normalized !== type.normalized) continue;
        assert(partitionOf({ kind: "model", type: other, id }).equals(key));
      }
    }),
    { numRuns: 300 },
  );
});

Deno.test("PartitionKey.parse: accepts a string only in its canonical form", () => {
  const arbCandidate = fc.oneof(
    fc.string({ maxLength: 60 }),
    fc.tuple(
      fc.constantFrom("model--", "run--", "config--", "definition--"),
      arbText,
      fc.constantFrom("", "--"),
      fc.uuid(),
    ).map((parts) => parts.join("")),
  );
  fc.assert(
    fc.property(arbCandidate, (candidate) => {
      let parsed: PartitionKey;
      try {
        parsed = PartitionKey.parse(candidate);
      } catch {
        return;
      }
      assertEquals(parsed.toString(), candidate);
    }),
    { numRuns: 1000 },
  );
});
