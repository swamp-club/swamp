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
import { assert, assertEquals, assertThrows } from "@std/assert";
import type { InputsSchema } from "../definitions/definition.ts";
import {
  openSignalWaitMessage,
  parseStoredWait,
  persistedWait,
  RESERVED_PAYLOAD_KEYS,
  schemaExpressions,
  SIGNAL_PAYLOAD_MAX_BYTES,
  SIGNAL_PAYLOAD_MAX_DEPTH,
  SIGNAL_WAIT_MAX_TIMEOUT_SECONDS,
  SignalWait,
  unenforcedSchemaKeywords,
} from "./signal_wait.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");

const VERDICT: InputsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict"],
  properties: {
    verdict: { type: "string", enum: ["ship", "fix", "abandon"] },
    note: { type: "string" },
    detail: {
      type: "object",
      additionalProperties: false,
      properties: { count: { type: "integer" } },
    },
  },
};

function nested(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true };
  for (let i = 1; i < depth; i++) value = { inner: value };
  return value;
}

Deno.test("SignalWait.open: a fresh id, the deadline timeout seconds after now, and no receipt", () => {
  const a = SignalWait.open(VERDICT, 90, NOW);
  const b = SignalWait.open(VERDICT, 90, NOW);

  assert(a.id !== b.id);
  assertEquals(a.deadline.toISOString(), "2026-01-01T00:01:30.000Z");
  assertEquals(a.isSettled, false);
  assertEquals(a.receipt, undefined);
});

Deno.test("SignalWait.open: refuses a timeout whose deadline could not be stored", () => {
  for (
    const timeout of [0, -1, NaN, Infinity, SIGNAL_WAIT_MAX_TIMEOUT_SECONDS + 1]
  ) {
    assertThrows(
      () => SignalWait.open(VERDICT, timeout, NOW),
      Error,
      "wait timeout",
      String(timeout),
    );
  }
  const longest = SignalWait.open(
    VERDICT,
    SIGNAL_WAIT_MAX_TIMEOUT_SECONDS,
    NOW,
  );
  assertEquals(
    SignalWait.fromData(longest.toData()).deadline,
    longest.deadline,
  );
});

Deno.test("SignalWait.open: captures the schema, so a later change to the source does not reach the wait", () => {
  const schema: InputsSchema = {
    properties: { verdict: { type: "string", enum: ["ship"] } },
  };
  const wait = SignalWait.open(schema, 60, NOW);
  schema.properties!.verdict.enum = ["ship", "anything"];

  assertEquals(wait.validatePayload({ verdict: "anything" }).valid, false);
});

Deno.test("SignalWait.isExpired: only past the deadline", () => {
  const wait = SignalWait.open(VERDICT, 60, NOW);

  assertEquals(wait.isExpired(NOW), false);
  assertEquals(wait.isExpired(new Date(wait.deadline.getTime())), false);
  assertEquals(wait.isExpired(new Date(wait.deadline.getTime() + 1)), true);
});

Deno.test("SignalWait.validatePayload: accepts a payload the schema allows, exactly as sent", () => {
  const wait = SignalWait.open(VERDICT, 60, NOW);
  const sent = { verdict: "ship", detail: { count: 2 } };

  const result = wait.validatePayload(sent);

  assert(result.valid);
  // Nothing is added for the absent `note`, and nothing is coerced.
  assertEquals(result.payload, sent);
  assert(result.payload !== sent);
});

Deno.test("SignalWait.validatePayload: refuses what the schema does not allow", () => {
  const wait = SignalWait.open(VERDICT, 60, NOW);

  const cases: Array<[unknown, string]> = [
    [{ verdict: "maybe" }, "verdict"],
    [{}, "verdict is required"],
    [{ verdict: "ship", extra: 1 }, "extra"],
    [{ verdict: 3 }, "verdict"],
    [{ verdict: "ship", detail: { count: 1, more: 2 } }, "detail.more"],
    [{ verdict: "ship", detail: { count: "two" } }, "detail.count"],
    [{ verdict: "ship", note: 7 }, "note"],
  ];
  for (const [payload, needle] of cases) {
    const result = wait.validatePayload(payload);
    assert(!result.valid, `accepted ${JSON.stringify(payload)}`);
    assert(
      result.errors.some((error) => error.includes(needle)),
      `${JSON.stringify(result.errors)} does not name ${needle}`,
    );
  }
});

Deno.test("SignalWait.validatePayload: a null value is refused for a declared property, required or not", () => {
  const wait = SignalWait.open(VERDICT, 60, NOW);

  for (
    const payload of [
      { verdict: null },
      { verdict: "ship", note: null },
      { verdict: "ship", detail: { count: null } },
    ]
  ) {
    assertEquals(
      wait.validatePayload(payload).valid,
      false,
      JSON.stringify(payload),
    );
  }
  const items = SignalWait.open(
    {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" } } },
    },
    60,
    NOW,
  );
  assertEquals(items.validatePayload({ tags: ["a", null] }).valid, false);
});

Deno.test("SignalWait.validatePayload: a key the schema allows without declaring is stored unchecked, null included", () => {
  const open = SignalWait.open({ type: "object" }, 60, NOW);
  const sent = { a: null, b: { c: null }, d: [null] };

  const result = open.validatePayload(sent);

  assert(result.valid);
  assertEquals(result.payload, sent);

  // Closing the schema is what rules an undeclared key out.
  const closed = SignalWait.open(
    { type: "object", additionalProperties: false },
    60,
    NOW,
  );
  assertEquals(closed.validatePayload({ a: null }).valid, false);
});

Deno.test("SignalWait.validatePayload: refuses anything that is not a JSON object", () => {
  const wait = SignalWait.open({ type: "object" }, 60, NOW);

  for (const payload of [null, undefined, "ship", 3, true, ["ship"]]) {
    const result = wait.validatePayload(payload);
    assert(!result.valid, `accepted ${JSON.stringify(payload)}`);
    assertEquals(result.errors, ["payload must be a JSON object"]);
  }
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assertEquals(wait.validatePayload(cyclic).valid, false);
});

Deno.test("SignalWait.validatePayload: refuses reserved keys at any depth, whatever the schema allows", () => {
  const open = SignalWait.open({ type: "object" }, 60, NOW);

  for (const key of RESERVED_PAYLOAD_KEYS) {
    const top = JSON.parse(`{"${key}": {"a": 1}}`);
    const deep = JSON.parse(`{"a": [{"b": {"${key}": 1}}]}`);
    for (const payload of [top, deep]) {
      const result = open.validatePayload(payload);
      assert(!result.valid, `accepted ${JSON.stringify(payload)}`);
      assert(
        result.errors.some((error) => error.includes(`reserved key "${key}"`)),
        JSON.stringify(result.errors),
      );
    }
  }
});

Deno.test("SignalWait.validatePayload: refuses nesting past the depth limit and accepts it at the limit", () => {
  const open = SignalWait.open({ type: "object" }, 60, NOW);

  assertEquals(
    open.validatePayload(nested(SIGNAL_PAYLOAD_MAX_DEPTH)).valid,
    true,
  );
  const tooDeep = open.validatePayload(nested(SIGNAL_PAYLOAD_MAX_DEPTH + 1));
  assert(!tooDeep.valid);
  assert(tooDeep.errors[0].includes("nests deeper"));
});

Deno.test("SignalWait.validatePayload: refuses a payload over the size limit and accepts one at it", () => {
  const open = SignalWait.open({ type: "object" }, 60, NOW);
  // {"text":"…"} is 11 bytes of framing around the string.
  const atLimit = { text: "a".repeat(SIGNAL_PAYLOAD_MAX_BYTES - 11) };
  const overLimit = { text: "a".repeat(SIGNAL_PAYLOAD_MAX_BYTES - 10) };

  assertEquals(open.validatePayload(atLimit).valid, true);
  const result = open.validatePayload(overLimit);
  assert(!result.valid);
  assert(result.errors[0].includes("byte limit"));
  // Multi-byte text is measured in bytes, not characters.
  assertEquals(
    open.validatePayload({ text: "é".repeat(SIGNAL_PAYLOAD_MAX_BYTES / 2) })
      .valid,
    false,
  );
});

Deno.test("SignalWait.validatePayload: a schema with no properties does not read its own keywords as property names", () => {
  const open = SignalWait.open({ type: "object", required: [] }, 60, NOW);

  const result = open.validatePayload({ type: "anything", required: 3 });

  assert(result.valid);
  assertEquals(result.payload, { type: "anything", required: 3 });
});

Deno.test("SignalWait.settle: records the receipt and leaves the open wait unchanged", () => {
  const wait = SignalWait.open(VERDICT, 60, NOW);
  const at = new Date("2026-01-01T00:00:30.000Z");

  const settled = wait.settle("ada", at);

  assertEquals(wait.isSettled, false);
  assertEquals(settled.isSettled, true);
  assertEquals(settled.id, wait.id);
  assertEquals(settled.receipt?.waitId, wait.id);
  assertEquals(settled.receipt?.submittedBy, "ada");
  assertEquals(settled.receipt?.receivedAt, at.toISOString());
  assert(settled.receipt!.id !== wait.id);
});

Deno.test("SignalWait: round-trips through its data and compares by value", () => {
  const wait = SignalWait.open(VERDICT, 60, NOW).settle("ada", NOW);

  const copy = SignalWait.fromData(wait.toData());

  assertEquals(copy.toData(), wait.toData());
  assertEquals(copy.equals(wait), true);
  assertEquals(copy.equals(SignalWait.open(VERDICT, 60, NOW)), false);
});

Deno.test("parseStoredWait: absent reads undefined, valid reads the wait, malformed is kept as read", () => {
  const wait = SignalWait.open(VERDICT, 60, NOW);
  assertEquals(parseStoredWait(undefined), undefined);

  const valid = parseStoredWait(wait.toData());
  assert(valid?.kind === "valid");
  assertEquals(valid.wait.equals(wait), true);
  assertEquals(persistedWait(valid), wait.toData());

  for (
    const raw of [null, "wait", 3, {}, { kind: "timer", id: wait.id }, {
      ...wait.toData(),
      id: "not-a-uuid",
    }]
  ) {
    const broken = parseStoredWait(raw);
    assert(broken?.kind === "broken");
    assertEquals(persistedWait(broken), raw);
  }
});

Deno.test("openSignalWaitMessage: names the step, the job and the signal command", () => {
  const message = openSignalWaitMessage({
    jobName: "release",
    stepName: "review",
    wait: { id: "abc" },
  });

  assert(message.includes('Step "review" in job "release"'));
  assert(message.includes("swamp workflow signal abc --payload"));
});

Deno.test("schemaExpressions: finds the expressions in a schema's values, and none in plain data", () => {
  assertEquals(schemaExpressions(VERDICT), []);
  assertEquals(
    schemaExpressions({
      type: "object",
      properties: {
        env: { type: "string", enum: ["${{ self.env }}", "fixed"] },
        note: { type: "string", description: "${{ inputs.note }}" },
      },
    }),
    ["${{ self.env }}", "${{ inputs.note }}"],
  );
  assertEquals(schemaExpressions(undefined), []);
});

Deno.test("SignalWait.validatePayload: a top-level additionalProperties schema is applied to undeclared keys", () => {
  const wait = SignalWait.open(
    {
      type: "object",
      properties: { verdict: { type: "string" } },
      additionalProperties: { type: "integer" },
    },
    60,
    NOW,
  );

  assertEquals(wait.validatePayload({ verdict: "ship", count: 2 }).valid, true);
  const refused = wait.validatePayload({ verdict: "ship", count: "two" });
  assert(!refused.valid);
  assertEquals(refused.errors, ["payload: count must be an integer"]);
});

Deno.test("SignalWait.validatePayload: a key named after an Object.prototype member is treated as any other key", () => {
  const required = SignalWait.open(
    { type: "object", required: ["toString"] },
    60,
    NOW,
  );
  const missing = required.validatePayload({});
  assert(!missing.valid);
  assertEquals(missing.errors, ["payload: toString is required"]);

  const closed = SignalWait.open(
    {
      type: "object",
      additionalProperties: false,
      properties: {
        detail: {
          type: "object",
          additionalProperties: false,
          required: ["valueOf"],
          properties: { valueOf: { type: "integer" as const } },
        },
      },
    },
    60,
    NOW,
  );
  // An inherited member neither satisfies `required` nor declares a key.
  const result = closed.validatePayload({ detail: { toString: "x" } });
  assert(!result.valid);
  assertEquals(result.errors.toSorted(), [
    "payload: detail.toString is not a valid property",
    "payload: detail.valueOf is required",
  ]);
  assertEquals(closed.validatePayload({ toString: 1 }).valid, false);
});

Deno.test("unenforcedSchemaKeywords: a schema using only checked keywords has none", () => {
  assertEquals(unenforcedSchemaKeywords(VERDICT), []);
  assertEquals(
    unenforcedSchemaKeywords({
      properties: {
        tags: {
          type: "array",
          description: "labels",
          minItems: 1,
          maxItems: 3,
          uniqueItems: true,
          items: { type: "string", enum: ["a", "b"] },
        },
        extra: {
          type: "object",
          title: "anything else",
          additionalProperties: { type: "number" },
        },
      },
      required: ["tags"],
      additionalProperties: false,
    }),
    [],
  );
});

Deno.test("unenforcedSchemaKeywords: names every keyword no payload would be checked against, at any depth", () => {
  assertEquals(
    unenforcedSchemaKeywords({
      type: "object",
      minProperties: 1,
      properties: {
        sha: { type: "string", pattern: "^[0-9a-f]{40}$", minLength: 40 },
        count: { type: "integer", minimum: 0 },
        list: { type: "array", items: { type: "string", format: "uri" } },
        other: { type: "object", additionalProperties: { const: 1 } },
      },
    }),
    [
      "schema.minProperties: not a supported keyword",
      "schema.properties.sha.pattern: not a supported keyword",
      "schema.properties.sha.minLength: not a supported keyword",
      "schema.properties.count.minimum: not a supported keyword",
      "schema.properties.list.items.format: not a supported keyword",
      "schema.properties.other.additionalProperties.const: not a supported keyword",
    ],
  );
});

Deno.test("unenforcedSchemaKeywords: a keyword read only beside its type is named when the type is absent", () => {
  assertEquals(
    unenforcedSchemaKeywords({
      // The root is checked as an object whether or not it says so.
      required: ["detail"],
      properties: {
        detail: { required: ["a"], properties: { a: { type: "string" } } },
        list: { items: { type: "string" }, minItems: 1 },
      },
    }),
    [
      'schema.properties.detail.required: only checked beside "type: object"',
      'schema.properties.detail.properties: only checked beside "type: object"',
      'schema.properties.list.items: only checked beside "type: array"',
      'schema.properties.list.minItems: only checked beside "type: array"',
    ],
  );
});

Deno.test("unenforcedSchemaKeywords: a default and an empty enum are named, as neither is applied to a payload", () => {
  assertEquals(
    unenforcedSchemaKeywords({
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["ship", "fix"], default: "fix" },
        anything: { type: "string", enum: [] },
        list: { type: "array", items: { type: "integer", default: 0 } },
      },
    }),
    [
      "schema.properties.verdict.default: a default is never applied to a payload",
      "schema.properties.anything.enum: an empty enum is not checked",
      "schema.properties.list.items.default: a default is never applied to a payload",
    ],
  );
});

Deno.test("SignalWait.validatePayload: additionalProperties false closes an object at any depth, with or without properties", () => {
  const wait = SignalWait.open(
    {
      type: "object",
      additionalProperties: false,
      properties: {
        meta: { type: "object", additionalProperties: false },
        list: {
          type: "array",
          items: { type: "object", additionalProperties: false },
        },
        extra: {
          type: "object",
          additionalProperties: { type: "object", additionalProperties: false },
        },
      },
    },
    60,
    NOW,
  );

  assertEquals(
    wait.validatePayload({ meta: {}, list: [{}], extra: { a: {} } }).valid,
    true,
  );
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ meta: { x: 1 } }, "payload: meta.x is not a valid property"],
    [{ list: [{}, { x: 1 }] }, "payload: list[1].x is not a valid property"],
    [{ extra: { a: { x: 1 } } }, "payload: extra.a.x is not a valid property"],
  ];
  for (const [payload, expected] of cases) {
    const result = wait.validatePayload(payload);
    assert(!result.valid, JSON.stringify(payload));
    assertEquals(result.errors, [expected]);
  }
  // Validating does not change the schema the wait captured.
  assertEquals(
    "properties" in (wait.schema.properties!.meta as Record<string, unknown>),
    false,
  );
});
