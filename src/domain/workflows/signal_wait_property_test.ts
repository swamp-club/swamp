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
import type { InputsSchema } from "../definitions/definition.ts";
import {
  parseStoredWait,
  persistedWait,
  RESERVED_PAYLOAD_KEYS,
  SIGNAL_PAYLOAD_MAX_BYTES,
  SignalWait,
} from "./signal_wait.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const OPEN_SCHEMA: InputsSchema = { type: "object" };

const VERDICT: InputsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict"],
  properties: {
    verdict: { type: "string", enum: ["ship", "fix", "abandon"] },
    count: { type: "integer" },
    tags: { type: "array", items: { type: "string" } },
  },
};

/** A key no payload is refused for. */
const arbSafeKey = fc.string({ minLength: 1, maxLength: 8 }).filter((key) =>
  !RESERVED_PAYLOAD_KEYS.includes(key)
);

/** Plain JSON data, shallow enough to stay inside the depth limit. */
const arbJsonValue: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: "small", maxDepth: 4 },
    fc.string({ maxLength: 12 }),
    fc.integer(),
    fc.boolean(),
    fc.array(tie("value"), { maxLength: 3 }),
    fc.dictionary(arbSafeKey, tie("value"), { maxKeys: 3 }),
  ),
})).value;

const arbOpenPayload = fc.dictionary(arbSafeKey, arbJsonValue, { maxKeys: 4 });

const arbValidVerdict = fc.record({
  verdict: fc.constantFrom("ship", "fix", "abandon"),
  count: fc.integer(),
  tags: fc.array(fc.string({ maxLength: 6 }), { maxLength: 3 }),
}, { requiredKeys: ["verdict"] });

Deno.test("SignalWait: any wait survives repeated round-trips unchanged (property)", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 10_000_000 }),
      fc.boolean(),
      fc.string({ minLength: 1, maxLength: 12 }),
      (timeout, settle, submittedBy) => {
        const open = SignalWait.open(VERDICT, timeout, NOW);
        const wait = settle ? open.settle(submittedBy, NOW) : open;

        const once = SignalWait.fromData(wait.toData());
        const twice = SignalWait.fromData(once.toData());

        assertEquals(once.toData(), wait.toData());
        assertEquals(twice.equals(wait), true);
        assertEquals(wait.equals(twice), true);
        const stored = parseStoredWait(wait.toData());
        assert(stored?.kind === "valid");
        assertEquals(persistedWait(stored), wait.toData());
      },
    ),
  );
});

Deno.test("SignalWait.validatePayload: every accepted payload is stored exactly as sent (property)", () => {
  const open = SignalWait.open(OPEN_SCHEMA, 60, NOW);
  const strict = SignalWait.open(VERDICT, 60, NOW);
  fc.assert(
    fc.property(arbOpenPayload, arbValidVerdict, (anything, verdict) => {
      const loose = open.validatePayload(anything);
      assert(loose.valid, JSON.stringify(anything));
      assertEquals(loose.payload, anything);

      const checked = strict.validatePayload(verdict);
      assert(checked.valid, JSON.stringify(verdict));
      // No default is added, no key dropped, nothing coerced.
      assertEquals(checked.payload, verdict);
      assertEquals(
        JSON.stringify(checked.payload),
        JSON.stringify(verdict),
      );
    }),
  );
});

Deno.test("SignalWait.validatePayload: a reserved key anywhere refuses the payload, whatever the schema (property)", () => {
  const open = SignalWait.open(OPEN_SCHEMA, 60, NOW);
  fc.assert(
    fc.property(
      arbOpenPayload,
      fc.constantFrom(...RESERVED_PAYLOAD_KEYS),
      fc.array(arbSafeKey, { maxLength: 4 }),
      arbJsonValue,
      (base, reserved, path, value) => {
        // Bury the reserved key under `path` as an own property, the way
        // JSON.parse produces it.
        let buried: unknown = Object.defineProperty({}, reserved, {
          value,
          enumerable: true,
        });
        for (const key of [...path].reverse()) buried = { [key]: buried };
        const payload = { ...base, planted: buried };

        const result = open.validatePayload(payload);

        assertEquals(result.valid, false);
      },
    ),
  );
});

Deno.test("SignalWait.validatePayload: anything that is not a plain JSON object is refused (property)", () => {
  const open = SignalWait.open(OPEN_SCHEMA, 60, NOW);
  fc.assert(
    fc.property(
      fc.oneof(
        fc.string(),
        fc.integer(),
        fc.boolean(),
        fc.constant(null),
        fc.constant(undefined),
        fc.array(arbJsonValue, { maxLength: 3 }),
      ),
      (payload) => {
        assertEquals(open.validatePayload(payload).valid, false);
      },
    ),
  );
});

Deno.test("SignalWait.validatePayload: a payload the strict schema does not allow is refused (property)", () => {
  const strict = SignalWait.open(VERDICT, 60, NOW);
  fc.assert(
    fc.property(
      arbValidVerdict,
      fc.oneof(
        // A verdict outside the enum.
        fc.string().filter((s) => !["ship", "fix", "abandon"].includes(s)).map(
          (verdict) => ({ verdict }),
        ),
        // An undeclared property.
        arbSafeKey.filter((k) => !["verdict", "count", "tags"].includes(k))
          .map((key) => ({ [key]: 1 })),
        // A wrong type.
        fc.constant({ count: "many" }),
        fc.constant({ tags: [1] }),
      ),
      (valid, breakage) => {
        const result = strict.validatePayload({ ...valid, ...breakage });
        assertEquals(result.valid, false);
      },
    ),
  );
});

Deno.test("SignalWait.validatePayload: size is bounded whatever the content (property)", () => {
  const open = SignalWait.open(OPEN_SCHEMA, 60, NOW);
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: SIGNAL_PAYLOAD_MAX_BYTES * 2 }),
      (length) => {
        const payload = { text: "a".repeat(length) };
        const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
        assertEquals(
          open.validatePayload(payload).valid,
          bytes <= SIGNAL_PAYLOAD_MAX_BYTES,
        );
      },
    ),
  );
});
