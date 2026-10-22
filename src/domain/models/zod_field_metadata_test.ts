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
import { z } from "zod";
import {
  codeAroundMetadata,
  extractFieldsWithMetadata,
  type FieldMetadata,
  findFieldMetadata,
  findFieldsWhere,
  findValuesWithMetadata,
  schemaHoldsMetadata,
} from "./zod_field_metadata.ts";

const isMarked = (meta: FieldMetadata) => meta.marked === true;

Deno.test("findValuesWithMetadata: raw inputs to marked pipe outputs are reported without running transforms", () => {
  const output = z.object({ token: z.string().meta({ marked: true }) });
  const transform = (): { token: string } => {
    throw new Error("must not execute");
  };
  for (
    const schema of [
      z.preprocess(transform, output),
      z.object({ alias: z.string() }).transform(transform).pipe(output),
    ]
  ) {
    const raw = { alias: "secret" };
    assertEquals(
      findValuesWithMetadata(schema, raw, isMarked, { rawInputs: true })
        .map(({ keys, value }) => ({ keys, value })),
      [{ keys: [], value: raw }, { keys: ["alias"], value: "secret" }],
    );
    assertEquals(
      findValuesWithMetadata(
        z.object({ credentials: schema }),
        { credentials: raw },
        isMarked,
        { rawInputs: true },
      )
        .map(({ keys, value }) => ({ keys, value })),
      [{ keys: ["credentials"], value: raw }],
    );
  }
});

Deno.test("findValuesWithMetadata: with rawInputs, a pipe whose input side holds no code reports what its output marks exactly, while a preprocess nested on the input side still reports the raw input (swamp-club#3751)", () => {
  const marked = z.string().meta({ marked: true });
  const reported = (
    schema: z.ZodTypeAny,
    value: unknown,
  ) =>
    findValuesWithMetadata(schema, value, isMarked, { rawInputs: true })
      .map(({ keys, value, rawInput }) => ({ keys, value, rawInput }));
  assertEquals(
    reported(z.object({ key: z.string().pipe(marked) }), { key: "secret" }),
    [{ keys: ["key"], value: "secret", rawInput: undefined }],
  );
  assertEquals(
    reported(z.object({ token: marked }).pipe(z.object({ token: marked })), {
      token: "secret",
    }),
    [{ keys: ["token"], value: "secret", rawInput: undefined }],
  );
  const raw = { alias: "secret" };
  assertEquals(
    reported(
      z.preprocess(() => {
        throw new Error("must not execute");
      }, z.object({ token: z.string() })).pipe(z.object({ token: marked })),
      raw,
    ),
    [
      { keys: [], value: raw, rawInput: true },
      { keys: ["alias"], value: "secret", rawInput: true },
    ],
  );
});

Deno.test("findValuesWithMetadata: with rawInputs, under a pipe whose input side reshapes the value, a field either side marks itself, or the output marks beside a sibling's own transform, is reported exactly, whichever member the walk reaches first (swamp-club#3751)", () => {
  const marked = z.string().meta({ marked: true });
  const reported = (schema: z.ZodTypeAny, value: unknown) =>
    findValuesWithMetadata(schema, value, isMarked, { rawInputs: true })
      .map(({ keys, rawInput }) => ({ keys, rawInput }));
  const transform = (): { token: string } => {
    throw new Error("must not execute");
  };
  // Both sides mark `token`; only the input side marks `bearer`.
  assertEquals(
    reported(
      z.object({ token: marked, alias: z.string() }).transform(transform).pipe(
        z.object({ token: marked }),
      ),
      { token: "secret", alias: "a" },
    ),
    [
      { keys: [], rawInput: true },
      { keys: ["token"], rawInput: undefined },
      { keys: ["alias"], rawInput: true },
    ],
  );
  assertEquals(
    reported(
      z.object({ bearer: marked, alias: z.string() }).transform(transform).pipe(
        z.object({ token: marked }),
      ),
      { bearer: "secret", alias: "a" },
    ),
    [
      { keys: [], rawInput: true },
      { keys: ["bearer"], rawInput: undefined },
      { keys: ["alias"], rawInput: true },
    ],
  );
  // A transform on a sibling's own chain leaves `token` exact.
  assertEquals(
    reported(
      z.object({ token: z.string(), n: z.string().transform(Number) }).pipe(
        z.object({ token: marked, n: z.number() }),
      ),
      { token: "secret", n: "1" },
    ),
    [
      { keys: [], rawInput: true },
      { keys: ["token"], rawInput: undefined },
      { keys: ["n"], rawInput: true },
    ],
  );
  const piped = z.object({ alias: z.string() }).transform(transform).pipe(
    z.object({ token: marked }),
  );
  const direct = z.object({ alias: marked });
  for (const members of [[piped, direct], [direct, piped]] as const) {
    assertEquals(
      reported(z.union(members), { alias: "secret" }).find(({ keys }) =>
        keys[0] === "alias"
      ),
      { keys: ["alias"], rawInput: undefined },
    );
  }
});

Deno.test("findFieldMetadata: returns metadata set directly on the field", () => {
  const meta = findFieldMetadata(
    z.string().meta({ marked: true, note: "x" }),
    isMarked,
  );
  assertEquals(meta, { marked: true, note: "x" });
});

Deno.test("findFieldMetadata: finds metadata under optional, nullable and default wrappers", () => {
  for (
    const schema of [
      z.string().meta({ marked: true }).optional(),
      z.string().meta({ marked: true }).nullable(),
      z.string().meta({ marked: true }).default("a"),
      z.string().meta({ marked: true }).optional().nullable(),
    ]
  ) {
    assertEquals(findFieldMetadata(schema, isMarked)?.marked, true);
  }
});

Deno.test("findFieldMetadata: finds metadata set on the wrapper", () => {
  const meta = findFieldMetadata(
    z.string().optional().meta({ marked: true }),
    isMarked,
  );
  assertEquals(meta?.marked, true);
});

Deno.test("findFieldMetadata: keeps metadata across describe and min in either order", () => {
  for (
    const schema of [
      z.string().meta({ marked: true }).describe("body"),
      z.string().describe("body").meta({ marked: true }),
      z.string().meta({ marked: true }).min(1),
      z.string().min(1).meta({ marked: true }),
    ]
  ) {
    assertEquals(findFieldMetadata(schema, isMarked)?.marked, true);
  }
});

Deno.test("findFieldMetadata: returns undefined when no metadata matches", () => {
  assertEquals(findFieldMetadata(z.string(), isMarked), undefined);
  assertEquals(
    findFieldMetadata(z.string().meta({ other: true }), isMarked),
    undefined,
  );
});

Deno.test("findFieldMetadata: does not see metadata placed before a transform", () => {
  const schema = z.string().meta({ marked: true }).transform((s) => s.trim());
  assertEquals(findFieldMetadata(schema, isMarked), undefined);
});

Deno.test("extractFieldsWithMetadata: returns matching top-level fields with their metadata", () => {
  const schema = z.object({
    a: z.string().meta({ marked: true }),
    b: z.string(),
    c: z.number().meta({ marked: true, extra: 1 }).optional(),
  });
  assertEquals(extractFieldsWithMetadata(schema, isMarked), [
    { path: "a", meta: { marked: true } },
    { path: "c", meta: { marked: true, extra: 1 } },
  ]);
});

Deno.test("extractFieldsWithMetadata: walks nested objects with dot paths", () => {
  const schema = z.object({
    outer: z.object({
      inner: z.string().meta({ marked: true }),
      deeper: z.object({ leaf: z.string().meta({ marked: true }) }).optional(),
    }),
  });
  const paths = extractFieldsWithMetadata(schema, isMarked).map((f) => f.path);
  assertEquals(paths, ["outer.inner", "outer.deeper.leaf"]);
});

Deno.test("extractFieldsWithMetadata: reports a marked object field and its marked children", () => {
  const schema = z.object({
    block: z.object({ leaf: z.string().meta({ marked: true }) }).meta({
      marked: true,
    }),
  });
  const paths = extractFieldsWithMetadata(schema, isMarked).map((f) => f.path);
  assertEquals(paths, ["block", "block.leaf"]);
});

Deno.test("extractFieldsWithMetadata: applies the prefix to every path", () => {
  const schema = z.object({ a: z.string().meta({ marked: true }) });
  const paths = extractFieldsWithMetadata(schema, isMarked, "root").map((f) =>
    f.path
  );
  assertEquals(paths, ["root.a"]);
});

Deno.test("extractFieldsWithMetadata: returns nothing for non-object schemas", () => {
  assertEquals(
    extractFieldsWithMetadata(z.string().meta({ marked: true }), isMarked),
    [],
  );
  assertEquals(
    extractFieldsWithMetadata(
      z.record(z.string(), z.string().meta({ marked: true })),
      isMarked,
    ),
    [],
  );
});

Deno.test("extractFieldsWithMetadata: does not visit fields inside arrays", () => {
  const schema = z.object({
    items: z.array(z.object({ leaf: z.string().meta({ marked: true }) })),
  });
  assertEquals(extractFieldsWithMetadata(schema, isMarked), []);
});

const markedPaths = (schema: z.ZodTypeAny, value: unknown) =>
  findValuesWithMetadata(schema, value, isMarked).map((f) => f.path);

Deno.test("findValuesWithMetadata: returns top-level and object-nested values with dot paths", () => {
  const schema = z.object({
    a: z.string().meta({ marked: true, note: "x" }),
    b: z.string(),
    outer: z.object({ inner: z.string().meta({ marked: true }) }),
  });
  assertEquals(
    findValuesWithMetadata(schema, {
      a: "1",
      b: "2",
      outer: { inner: "3" },
    }, isMarked),
    [
      {
        path: "a",
        keys: ["a"],
        value: "1",
        meta: { marked: true, note: "x" },
        perElement: false,
      },
      {
        path: "outer.inner",
        keys: ["outer", "inner"],
        value: "3",
        meta: { marked: true },
        perElement: false,
      },
    ],
  );
});

Deno.test("findValuesWithMetadata: reaches a field inside each array element", () => {
  const schema = z.object({
    users: z.array(z.object({
      id: z.string(),
      password: z.string().meta({ marked: true }),
    })).default([]),
  });
  assertEquals(
    markedPaths(schema, {
      users: [{ id: "a", password: "p0" }, { id: "b", password: "p1" }],
    }),
    ["users[0].password", "users[1].password"],
  );
});

Deno.test("findValuesWithMetadata: reaches marked array elements and nested arrays", () => {
  const schema = z.object({
    tokens: z.array(z.string().meta({ marked: true })),
    grid: z.array(z.array(z.object({ k: z.string().meta({ marked: true }) }))),
  });
  assertEquals(
    markedPaths(schema, { tokens: ["a", "b"], grid: [[{ k: "x" }]] }),
    ["tokens[0]", "tokens[1]", "grid[0][0].k"],
  );
});

Deno.test("findValuesWithMetadata: reaches tuple items and the tuple rest", () => {
  const schema = z.object({
    pair: z.tuple([z.string(), z.string().meta({ marked: true })]).rest(
      z.object({ k: z.string().meta({ marked: true }) }),
    ),
  });
  assertEquals(
    markedPaths(schema, { pair: ["user", "pass", { k: "x" }] }),
    ["pair[1]", "pair[2].k"],
  );
});

Deno.test("findValuesWithMetadata: reaches record values, quoting a key that is not a plain segment", () => {
  const schema = z.object({
    accounts: z.record(
      z.string(),
      z.object({ token: z.string().meta({ marked: true }) }),
    ),
  });
  assertEquals(
    markedPaths(schema, {
      accounts: { prod: { token: "a" }, "eu.west": { token: "b" } },
    }),
    ["accounts.prod.token", 'accounts["eu.west"].token'],
  );
});

Deno.test("findValuesWithMetadata: visits every member of a plain union", () => {
  const schema = z.object({
    auth: z.union([
      z.object({ password: z.string().meta({ marked: true }) }),
      z.object({ password: z.string(), note: z.string() }),
      z.string().meta({ marked: true }),
    ]),
  });
  assertEquals(markedPaths(schema, { auth: { password: "p", note: "n" } }), [
    "auth.password",
  ]);
  assertEquals(markedPaths(schema, { auth: "bare" }), ["auth"]);
});

Deno.test("findValuesWithMetadata: narrows a discriminated union by its discriminator", () => {
  const schema = z.object({
    auth: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("token"),
        value: z.string().meta({ marked: true }),
      }),
      z.object({ kind: z.literal("plain"), value: z.string() }),
    ]),
  });
  assertEquals(markedPaths(schema, { auth: { kind: "token", value: "v" } }), [
    "auth.value",
  ]);
  assertEquals(
    markedPaths(schema, { auth: { kind: "plain", value: "v" } }),
    [],
  );
});

Deno.test("findValuesWithMetadata: visits every discriminated member when the discriminator names none", () => {
  const schema = z.object({
    auth: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("token"),
        value: z.string().meta({ marked: true }),
      }),
      z.object({ kind: z.literal("plain"), value: z.string() }),
    ]),
  });
  for (const kind of ["${{ inputs.kind }}", undefined, 7]) {
    assertEquals(markedPaths(schema, { auth: { kind, value: "v" } }), [
      "auth.value",
    ]);
  }
});

Deno.test("findValuesWithMetadata: visits both sides of an intersection", () => {
  const schema = z.object({
    both: z.intersection(
      z.object({ a: z.string().meta({ marked: true }) }),
      z.object({ b: z.string().meta({ marked: true }) }),
    ),
  });
  assertEquals(markedPaths(schema, { both: { a: "1", b: "2" } }), [
    "both.a",
    "both.b",
  ]);
});

Deno.test("findValuesWithMetadata: sees through readonly, transform, preprocess and lazy", () => {
  const item = z.object({ k: z.string().meta({ marked: true }) });
  const schema = z.object({
    ro: z.array(item).readonly(),
    tr: z.array(item).transform((v) => v),
    pre: z.preprocess((v) => v, z.array(item)),
    lazy: z.lazy(() => z.array(item)),
    opt: z.array(item).optional().nullable(),
  });
  const value = [{ k: "x" }];
  assertEquals(
    markedPaths(schema, {
      ro: value,
      tr: value,
      pre: value,
      lazy: value,
      opt: value,
    }),
    ["ro[0].k", "tr[0].k", "pre[0].k", "lazy[0].k", "opt[0].k"],
  );
});

Deno.test("findValuesWithMetadata: ends on a recursive schema", () => {
  type Node = { secret: string; children?: Node[] };
  const node: z.ZodType<Node> = z.lazy(() =>
    z.object({
      secret: z.string().meta({ marked: true }),
      children: z.array(node).optional(),
    })
  );
  const schema = z.object({ root: node });
  assertEquals(
    markedPaths(schema, {
      root: { secret: "a", children: [{ secret: "b", children: [] }] },
    }),
    ["root.secret", "root.children[0].secret"],
  );
});

Deno.test("findValuesWithMetadata: reports a marked container once and still visits its children", () => {
  const schema = z.object({
    block: z.array(z.object({ leaf: z.string().meta({ marked: true }) })).meta({
      marked: true,
    }),
  });
  assertEquals(markedPaths(schema, { block: [{ leaf: "x" }] }), [
    "block",
    "block[0].leaf",
  ]);
});

Deno.test("findValuesWithMetadata: skips absent values and reports values of the wrong shape whole", () => {
  const schema = z.object({
    a: z.string().meta({ marked: true }).optional(),
    users: z.array(z.object({ password: z.string().meta({ marked: true }) })),
    rec: z.record(z.string(), z.string().meta({ marked: true })),
  });
  assertEquals(markedPaths(schema, {}), []);
  assertEquals(
    markedPaths(schema, { a: null, users: null, rec: undefined }),
    [],
  );
  assertEquals(
    markedPaths(schema, { users: "not-an-array", rec: ["not", "a", "record"] }),
    ["users", "rec"],
  );
  assertEquals(markedPaths(schema, { users: [null, "x", {}] }), ["users[1]"]);
});

Deno.test("findValuesWithMetadata: does not report metadata on the root schema", () => {
  const schema = z.object({ a: z.string() }).meta({ marked: true });
  assertEquals(markedPaths(schema, { a: "x" }), []);
});

Deno.test("findValuesWithMetadata: returns nothing for a schema this Zod did not build", () => {
  // The shape of a Zod v3 schema: `typeName` in place of `type`, a function
  // for `shape`, and no registry entry.
  const v3Like = {
    _def: {
      typeName: "ZodObject",
      shape: () => ({ a: { _def: { typeName: "ZodString" } } }),
    },
  } as unknown as z.ZodTypeAny;
  assertEquals(markedPaths(v3Like, { a: "x" }), []);

  const v4WithForeignField = z.object({
    a: { _def: { typeName: "ZodString" } } as unknown as z.ZodTypeAny,
    b: z.string().meta({ marked: true }),
  });
  assertEquals(markedPaths(v4WithForeignField, { a: "x", b: "y" }), ["b"]);
});

Deno.test("findValuesWithMetadata: gives values under dotted record keys distinct paths", () => {
  const schema = z.object({
    users: z.record(
      z.string(),
      z.record(z.string(), z.string().meta({ marked: true })),
    ),
  });
  const found = findValuesWithMetadata(schema, {
    users: { a: { "b.c": "first" }, "a.b": { c: "second" } },
  }, isMarked);
  assertEquals(found.map((f) => [f.path, f.value]), [
    ['users.a["b.c"]', "first"],
    ['users["a.b"].c', "second"],
  ]);
});

Deno.test("findValuesWithMetadata: marks values inside arrays, tuples and records as per element", () => {
  const leaf = z.object({ k: z.string().meta({ marked: true }) });
  const schema = z.object({
    once: z.union([leaf, z.string()]),
    wrapped: leaf.readonly(),
    list: z.array(leaf),
    pair: z.tuple([leaf]),
    map: z.record(z.string(), leaf),
    deep: z.array(z.object({ inner: leaf })),
  });
  const v = { k: "x" };
  const found = findValuesWithMetadata(schema, {
    once: v,
    wrapped: v,
    list: [v],
    pair: [v],
    map: { a: v },
    deep: [{ inner: v }],
  }, isMarked);
  assertEquals(found.map((f) => [f.path, f.perElement]), [
    ["once.k", false],
    ["wrapped.k", false],
    ["list[0].k", true],
    ["pair[0].k", true],
    ["map.a.k", true],
    ["deep[0].inner.k", true],
  ]);
});

Deno.test("findValuesWithMetadata: does not enter a value that contains itself", () => {
  type Node = { secret: string; children?: Node[] };
  const node: z.ZodType<Node> = z.lazy(() =>
    z.object({
      secret: z.string().meta({ marked: true }),
      children: z.array(node).optional(),
    })
  );
  const root: Node = { secret: "a", children: [] };
  root.children!.push(root);
  assertEquals(markedPaths(z.object({ root: node }), { root }), [
    "root.secret",
  ]);
});

Deno.test("findValuesWithMetadata: visits a value an alias repeats in two places", () => {
  const schema = z.object({
    a: z.object({ k: z.string().meta({ marked: true }) }),
    b: z.object({ k: z.string().meta({ marked: true }) }),
  });
  const shared = { k: "x" };
  assertEquals(markedPaths(schema, { a: shared, b: shared }), ["a.k", "b.k"]);
});

Deno.test("findValuesWithMetadata: a record key cannot spell an array index, nesting or a control sequence", () => {
  const schema = z.object({
    rec: z.record(z.string(), z.string().meta({ marked: true })),
    "dotted.field": z.string().meta({ marked: true }),
  });
  assertEquals(
    markedPaths(schema, {
      rec: {
        "0": "a",
        "[0]": "b",
        "eu[1]": "c",
        "": "d",
        'q"uote': "e",
        "\u001b[31mred": "f",
        "plain-key_1": "g",
      },
      "dotted.field": "h",
    }),
    [
      "rec.0",
      'rec["[0]"]',
      'rec["eu[1]"]',
      'rec[""]',
      'rec["q\\"uote"]',
      'rec["\\u001b[31mred"]',
      "rec.plain-key_1",
      '["dotted.field"]',
    ],
  );
});

Deno.test("findValuesWithMetadata: reports a value several union members mark once", () => {
  const member = () => z.object({ k: z.string().meta({ marked: true }) });
  const schema = z.object({
    list: z.array(z.union([member(), member(), member()])),
  });
  const list = Array.from({ length: 50 }, (_, i) => ({ k: `v${i}` }));
  const found = findValuesWithMetadata(schema, { list }, isMarked);
  assertEquals(found.length, 50);
  assertEquals(found[49].path, "list[49].k");
});

Deno.test("findValuesWithMetadata: resolves a lazy schema's getter once", () => {
  let calls = 0;
  const item = z.lazy(() => {
    calls++;
    return z.object({ k: z.string().meta({ marked: true }) });
  });
  const schema = z.object({ list: z.array(item) });
  const paths = markedPaths(schema, {
    list: [{ k: "a" }, { k: "b" }, { k: "c" }],
  });
  assertEquals(paths, ["list[0].k", "list[1].k", "list[2].k"]);
  assertEquals(calls, 1);
});

Deno.test("findValuesWithMetadata: walks a recursive schema with overlapping union members once per node", () => {
  // Both members accept every node, so walking each member's children
  // separately would visit a node at depth d 2^d times.
  type Node = { secret?: string; children?: Node[] };
  let visits = 0;
  const node: z.ZodType<Node> = z.lazy(() =>
    z.union([
      z.object({
        secret: z.string().meta({ marked: true }).optional(),
        children: z.array(node).optional(),
      }),
      z.object({ children: z.array(node).optional() }),
    ])
  );
  const depth = 60;
  let chain: Node = { secret: "leaf" };
  for (let i = 0; i < depth; i++) {
    chain = { secret: `s${i}`, children: [chain] };
  }
  const found = findValuesWithMetadata(
    z.object({ root: node }),
    { root: chain },
    (meta) => {
      visits++;
      return isMarked(meta);
    },
  );
  assertEquals(found.length, depth + 1);
  assertEquals(found.at(-1)?.value, "leaf");
  assertEquals(visits, depth + 1);
});

Deno.test("findValuesWithMetadata: reaches keys accepted by a catchall", () => {
  const schema = z.object({
    extra: z.object({ name: z.string() }).catchall(
      z.string().meta({ marked: true }),
    ),
  });
  const found = findValuesWithMetadata(schema, {
    extra: { name: "n", token: "t", "api key": "k" },
  }, isMarked);
  assertEquals(found.map((f) => [f.path, f.perElement]), [
    ["extra.token", true],
    ['extra["api key"]', true],
  ]);
});

Deno.test("findValuesWithMetadata: keeps a union member behind a preprocess for a value of any shape", () => {
  const schema = z.object({
    auth: z.union([
      z.preprocess(
        (v) => JSON.stringify(v),
        z.string().meta({ marked: true }),
      ),
      z.object({ user: z.string() }),
    ]),
  });
  assertEquals(markedPaths(schema, { auth: { user: "u" } }), ["auth"]);
});

Deno.test("findValuesWithMetadata: keeps a coerced scalar union member for a value of any shape", () => {
  // Zod tries the coerced member first and accepts an array by converting it.
  const schema = z.object({
    pw: z.union([
      z.coerce.string().meta({ marked: true }),
      z.array(z.string()),
    ]),
    n: z.union([
      z.coerce.number().meta({ marked: true }),
      z.object({ v: z.string() }),
    ]),
    plain: z.union([z.string().meta({ marked: true }), z.array(z.string())]),
  });
  assertEquals(
    markedPaths(schema, { pw: ["hunter2"], n: { v: "1" }, plain: ["x"] }),
    ["pw", "n"],
  );
});

Deno.test("findValuesWithMetadata: escapes control and bidirectional characters in a key", () => {
  const schema = z.object({
    rec: z.record(z.string(), z.string().meta({ marked: true })),
  });
  const keys = [
    "del\u007f",
    "csi\u009b2J",
    "rtl\u202eevil",
    "ls\u2028ps\u2029",
    "iso\u2066\u2069",
    "mark\u200e\u200f",
    "esc\u001b[31m",
  ];
  const paths = markedPaths(schema, {
    rec: Object.fromEntries(keys.map((k) => [k, "v"])),
  });
  assertEquals(paths, [
    'rec["del\\u007f"]',
    'rec["csi\\u009b2J"]',
    'rec["rtl\\u202eevil"]',
    'rec["ls\\u2028ps\\u2029"]',
    'rec["iso\\u2066\\u2069"]',
    'rec["mark\\u200e\\u200f"]',
    'rec["esc\\u001b[31m"]',
  ]);
  for (const path of paths) {
    // Nothing outside printable ASCII is left in the path.
    assertEquals(/^[\x20-\x7e]+$/.test(path), true);
  }
});

Deno.test("findValuesWithMetadata: leaves printable non-ASCII characters in a key as they are", () => {
  const schema = z.object({
    rec: z.record(z.string(), z.string().meta({ marked: true })),
  });
  assertEquals(markedPaths(schema, { rec: { "clé-日本": "v" } }), [
    'rec["clé-日本"]',
  ]);
});

Deno.test("findValuesWithMetadata: gives the keys and indexes that lead to each value", () => {
  const schema = z.object({
    users: z.array(z.object({ password: z.string().meta({ marked: true }) })),
    rec: z.record(z.string(), z.string().meta({ marked: true })),
  });
  assertEquals(
    findValuesWithMetadata(schema, {
      users: [{ password: "a" }, { password: "b" }],
      rec: { "eu.west": "c" },
    }, isMarked).map((f) => [f.path, f.keys]),
    [
      ["users[0].password", ["users", 0, "password"]],
      ["users[1].password", ["users", 1, "password"]],
      ['rec["eu.west"]', ["rec", "eu.west"]],
    ],
  );
});

Deno.test("findValuesWithMetadata: a union member that accepts only an absent value does not hide a marked one", () => {
  for (const absent of [z.null(), z.undefined(), z.void(), z.never()]) {
    const schema = z.object({
      pin: z.union([z.string().meta({ marked: true }), absent]),
    });
    assertEquals(markedPaths(schema, { pin: 123456 }), ["pin"]);
    assertEquals(markedPaths(schema, { pin: "123456" }), ["pin"]);
  }
});

Deno.test("findValuesWithMetadata: a date member takes a date, and a number falls to no member", () => {
  const schema = z.object({
    at: z.union([z.string().meta({ marked: true }), z.date()]),
  });
  // No member accepts a number, so every member is kept.
  assertEquals(markedPaths(schema, { at: 5 }), ["at"]);
  assertEquals(markedPaths(schema, { at: "text" }), ["at"]);
});

Deno.test("findValuesWithMetadata: reports a scalar stored where an array of marked elements is declared", () => {
  const schema = z.object({
    tokens: z.array(z.string().meta({ marked: true })),
  });
  assertEquals(
    findValuesWithMetadata(schema, { tokens: "hunter2" }, isMarked),
    [{
      path: "tokens",
      keys: ["tokens"],
      value: "hunter2",
      meta: { marked: true },
      perElement: true,
    }],
  );
});

Deno.test("findValuesWithMetadata: reports a value of the wrong shape for any container that marks something", () => {
  const leaf = z.string().meta({ marked: true });
  const schema = z.object({
    obj: z.object({ deep: z.object({ leaf }) }).optional(),
    rec: z.record(z.string(), leaf).optional(),
    tup: z.tuple([z.string(), leaf]).optional(),
    arr: z.array(z.object({ leaf })).optional(),
    plain: z.array(z.string()).optional(),
  });
  assertEquals(markedPaths(schema, { obj: ["x"] }), ["obj"]);
  assertEquals(markedPaths(schema, { rec: "x" }), ["rec"]);
  assertEquals(markedPaths(schema, { tup: { a: "x" } }), ["tup"]);
  assertEquals(markedPaths(schema, { arr: 7 }), ["arr"]);
  // A container that marks nothing has nothing to report.
  assertEquals(markedPaths(schema, { plain: "x" }), []);
});

Deno.test("findValuesWithMetadata: a wrong-shaped value under a recursive schema ends and is reported", () => {
  type Node = { secret?: string; next?: Node };
  const node: z.ZodType<Node> = z.lazy(() =>
    z.object({
      secret: z.string().meta({ marked: true }).optional(),
      next: node.optional(),
    })
  );
  const plain: z.ZodType<unknown> = z.lazy(() =>
    z.object({ next: plain.optional() })
  );
  const schema = z.object({ node, plain });
  assertEquals(markedPaths(schema, { node: { next: "x" } }), ["node.next"]);
  assertEquals(markedPaths(schema, { plain: { next: "x" } }), []);
});

Deno.test("findValuesWithMetadata: reads metadata on the output side of a pipe", () => {
  const schema = z.object({
    direct: z.string().pipe(z.string().meta({ marked: true })),
    wrapped: z.string().pipe(z.string().meta({ marked: true }).readonly()),
    nested: z.object({ a: z.string() }).pipe(
      z.object({ a: z.string().meta({ marked: true }) }),
    ),
  });
  assertEquals(
    markedPaths(schema, { direct: "x", wrapped: "y", nested: { a: "z" } }),
    ["direct", "wrapped", "nested.a"],
  );
});

Deno.test("findValuesWithMetadata: a transform before a pipe reports the stored value whole", () => {
  const schema = z.object({
    csv: z.string().transform((s) => s.split(",")).pipe(
      z.array(z.string().meta({ marked: true })),
    ),
  });
  assertEquals(markedPaths(schema, { csv: "a,b" }), ["csv"]);
});

Deno.test("findValuesWithMetadata: a declared key the value lacks is not read from the prototype", () => {
  const schema = z.object({
    toString: z.string().meta({ marked: true }).optional(),
    constructor: z.string().meta({ marked: true }).optional(),
    region: z.string(),
  });
  assertEquals(markedPaths(schema, { region: "x" }), []);
  assertEquals(markedPaths(schema, { region: "x", toString: "s" }), [
    "toString",
  ]);
});

Deno.test("findValuesWithMetadata: a coerced date member is kept for a value of any kind", () => {
  const schema = z.object({
    at: z.union([z.coerce.date().meta({ marked: true }), z.number()]),
  });
  assertEquals(markedPaths(schema, { at: 1700000000 }), ["at"]);
});

Deno.test("schemaHoldsMetadata: finds a mark anywhere the value walk can report", () => {
  const leaf = () => z.string().meta({ marked: true });
  const holders: z.ZodTypeAny[] = [
    z.object({ a: leaf() }),
    z.object({ a: z.object({ b: leaf().optional() }) }),
    z.array(z.object({ a: leaf() })),
    z.record(z.string(), leaf()),
    z.tuple([z.string(), leaf()]),
    z.tuple([z.string()]).rest(leaf()),
    z.object({}).catchall(leaf()),
    z.union([z.number(), z.object({ a: leaf() })]),
    z.intersection(z.object({ a: z.string() }), z.object({ b: leaf() })),
    z.string().pipe(leaf()),
    z.lazy(() => z.object({ a: leaf() })),
    z.object({ a: z.string().transform((v) => v).meta({ marked: true }) }),
  ];
  for (const schema of holders) {
    assertEquals(schemaHoldsMetadata(schema, isMarked), true);
  }
});

Deno.test("schemaHoldsMetadata: answers false for a schema that marks nothing, recursive or not", () => {
  type Node = { next?: Node };
  const node: z.ZodType<Node> = z.lazy(() =>
    z.object({ next: node.optional() })
  );
  const plain = z.object({
    a: z.string().meta({ note: "x" }),
    list: z.array(z.object({ b: z.number() })),
    node,
  });
  assertEquals(schemaHoldsMetadata(plain, isMarked), false);
});

Deno.test("schemaHoldsMetadata: searches a schema once per matches function", () => {
  const schema = z.object({ a: z.string().meta({ marked: true }) });
  let calls = 0;
  const counting = (meta: Record<string, unknown>) => {
    calls++;
    return Boolean(meta.marked);
  };
  assertEquals(schemaHoldsMetadata(schema, counting), true);
  const afterFirst = calls;
  assertEquals(schemaHoldsMetadata(schema, counting), true);
  assertEquals(calls, afterFirst);
  // Another function gets its own answer.
  assertEquals(schemaHoldsMetadata(schema, () => false), false);
});

Deno.test("findFieldsWhere: reads a field's metadata across its wrapper chain and enters containers, unions and pipes", () => {
  const marked = (chain: readonly FieldMetadata[]) =>
    chain.some((meta) => meta.marked === true);
  const both = (chain: readonly FieldMetadata[]) =>
    chain.some((meta) => meta.a === true) &&
    chain.some((meta) => meta.b === true);
  const schema = z.object({
    plain: z.string(),
    direct: z.string().meta({ marked: true }),
    inner: z.string().meta({ marked: true }).optional(),
    outer: z.string().optional().meta({ marked: true }),
    nested: z.object({ deep: z.string().meta({ marked: true }) }),
    list: z.array(z.string().meta({ marked: true })),
    tuple: z.tuple(
      [z.string(), z.string().meta({ marked: true })],
      z.string().meta({ marked: true }),
    ),
    record: z.record(z.string(), z.string().meta({ marked: true })),
    union: z.union([
      z.object({ u: z.string().meta({ marked: true }) }),
      z.string(),
    ]),
    piped: z.string().meta({ a: true }).pipe(z.string().meta({ b: true })),
    split: z.string().meta({ a: true }).optional().meta({ b: true }),
  });
  assertEquals(findFieldsWhere(schema, marked), [
    "direct",
    "inner",
    "outer",
    "nested.deep",
    "list[]",
    "tuple[1]",
    "tuple[]",
    "record[*]",
    "union.u",
  ]);
  assertEquals(findFieldsWhere(schema, both), ["piped", "split"]);
  // Metadata on the root schema itself is not a field.
  assertEquals(
    findFieldsWhere(z.object({ x: z.string() }).meta({ marked: true }), marked),
    [],
  );
});

Deno.test("findFieldsWhere: a recursive schema is visited once", () => {
  interface Node {
    name: string;
    children: Node[];
  }
  const node: z.ZodType<Node> = z.lazy(() =>
    z.object({
      name: z.string().meta({ marked: true }),
      children: z.array(node),
    })
  );
  assertEquals(
    findFieldsWhere(
      z.object({ root: node }),
      (chain) => chain.some((meta) => meta.marked === true),
    ),
    ["root.name"],
  );
});

Deno.test("findFieldsWhere: metadata on a union and on one of its members are read as one chain", () => {
  const both = (chain: readonly FieldMetadata[]) =>
    chain.some((meta) => meta.a === true) &&
    chain.some((meta) => meta.b === true);
  const schema = z.object({
    choice: z.union([z.string().meta({ b: true }), z.number()]).meta({
      a: true,
    }),
    apart: z.union([z.string().meta({ b: true }), z.number()]),
    nested: z.union([z.object({ x: z.string().meta({ b: true }) }), z.number()])
      .meta({ a: true }),
  });
  // The chain continues into a member, which describes the same field, not
  // into a member's own fields, which are fields of their own.
  assertEquals(findFieldsWhere(schema, both), ["choice"]);
});

Deno.test("findFieldsWhere: a schema two fields share is read under each of them", () => {
  const shared = z.string().meta({ b: true });
  const schema = z.object({
    a: shared,
    b: z.union([shared, z.number()]).meta({ a: true }),
  });
  const both = (chain: readonly FieldMetadata[]) =>
    chain.some((meta) => meta.a === true) &&
    chain.some((meta) => meta.b === true);
  assertEquals(findFieldsWhere(schema, both), ["b"]);
  // Under the union's chain the shared schema is read again, so both fields
  // report it.
  assertEquals(
    findFieldsWhere(schema, (chain) => chain.some((meta) => meta.b === true)),
    ["a", "b"],
  );
});

Deno.test("findFieldsWhere: a DAG-shaped schema costs one visit per node and chain, not one per path", () => {
  // Thirty levels, each with two fields referencing the same sub-schema:
  // a billion paths, a few dozen distinct nodes.
  let level: z.ZodTypeAny = z.string().meta({ marked: true });
  for (let i = 0; i < 30; i++) {
    level = z.object({ left: level, right: level });
  }
  let asked = 0;
  const marked = (chain: readonly FieldMetadata[]) => {
    asked++;
    return chain.some((meta) => meta.marked === true);
  };
  assertEquals(findFieldsWhere(level, marked), [
    Array(30).fill("left").join("."),
  ]);
  // Only a node with metadata is asked, and the shared leaf is read once
  // under its first path: one question, not a billion.
  assertEquals(asked, 1);
});

Deno.test("findValuesWithMetadata: with reportRoot, a match on the root schema's own chain reports the root value whole, and is still left out without it (swamp-club#3681)", () => {
  const made = z.object({ raw: z.string() }).transform((x) => x.raw).pipe(
    z.string().meta({ marked: true }),
  );
  assertEquals(
    findValuesWithMetadata(made, "MADE", isMarked, { reportRoot: true }).map(
      (found) => [found.path, found.keys, found.value],
    ),
    [["", [], "MADE"]],
  );
  assertEquals(findValuesWithMetadata(made, "MADE", isMarked), []);
  const whole = z.object({ a: z.string() }).meta({ marked: true }).optional();
  assertEquals(
    findValuesWithMetadata(whole, { a: "x" }, isMarked, { reportRoot: true })
      .map((found) => found.path),
    [""],
  );
  assertEquals(findValuesWithMetadata(whole, { a: "x" }, isMarked), []);
  // A marked field under an unmarked root is reported the same either way.
  const under = z.object({ a: z.string().meta({ marked: true }) });
  assertEquals(
    findValuesWithMetadata(under, { a: "x" }, isMarked, { reportRoot: true })
      .map((found) => found.path),
    ["a"],
  );
});

Deno.test("findValuesWithMetadata: with transformed, what a transform, codec, overwrite or catch enclosing a marked field delivered is reported whole, as is what a union or intersection with such a member delivered, while a preprocess and a transform beside the field are walked precisely (swamp-club#3681)", () => {
  const marked = z.string().meta({ marked: true });
  const inner = z.object({ secret: marked, label: z.string() });
  const delivered = { token: "SECRET", label: "x" };
  const whole = (schema: z.ZodTypeAny, value: unknown) =>
    findValuesWithMetadata(schema, value, isMarked, {
      reportRoot: true,
      transformed: true,
    }).map(({ keys, value, rawInput }) => ({ keys, value, rawInput }));
  for (
    const schema of [
      inner.transform((v) => ({ token: v.secret, label: v.label })),
      z.codec(inner, z.object({ token: z.string(), label: z.string() }), {
        decode: (v) => ({ token: v.secret, label: v.label }),
        encode: (v) => ({ secret: v.token, label: v.label }),
      }),
      inner.overwrite((v) => ({ secret: v.secret, label: v.label })),
      inner.catch({ secret: "", label: "" }),
      z.intersection(inner, z.any().transform((v) => v)),
      z.union([z.string(), inner.transform((v) => v)]),
    ]
  ) {
    assertEquals(whole(schema, delivered), [{
      keys: [],
      value: delivered,
      rawInput: true,
    }]);
  }
  assertEquals(
    whole(
      z.object({
        creds: inner.transform((v) => ({ k: v.secret })),
        other: z.string(),
      }),
      { creds: { k: "SECRET" }, other: "x" },
    ),
    [{ keys: ["creds"], value: { k: "SECRET" }, rawInput: true }],
  );
  // Read as stored, the delivered shape is walked against the input shape
  // and holds nothing the schema can name.
  assertEquals(
    findValuesWithMetadata(inner.transform((v) => v), delivered, isMarked, {
      reportRoot: true,
    }),
    [],
  );
  // What a preprocess delivers conforms to the schema behind it.
  assertEquals(
    whole(z.preprocess((v) => v, inner), { secret: "s", label: "x" }),
    [{ keys: ["secret"], value: "s", rawInput: undefined }],
  );
  // A transform beside the field cannot reach it.
  assertEquals(
    whole(
      z.object({ secret: marked, other: z.string().transform((s) => s) }),
      { secret: "s", other: "o" },
    ),
    [{ keys: ["secret"], value: "s", rawInput: undefined }],
  );
  // A transform enclosing nothing marked delivers nothing marked.
  assertEquals(
    whole(z.object({ a: z.string() }).transform((v) => v), { a: "x" }),
    [],
  );
});

Deno.test("codeAroundMetadata: a refinement, a node-level error map or a pipe on a node enclosing a marked field, or on a union or intersection member beside one, writes messages; only a superRefine, a check or a pipe at or above the field adds issues; built-in checks, and code on the field itself or beside it, write nothing above (swamp-club#3681)", () => {
  const marked = z.string().meta({ marked: true });
  const code = (schema: z.ZodTypeAny) => codeAroundMetadata(schema, isMarked);
  const none = { messages: false, issues: false };
  const messages = { messages: true, issues: false };
  const both = { messages: true, issues: true };
  assertEquals(code(z.object({ a: marked })), none);
  assertEquals(
    code(
      z.object({ a: marked.min(3, "short").refine(() => true, "no") }),
    ),
    none,
  );
  assertEquals(
    code(z.object({
      a: marked,
      b: z.string().transform((s) => s).refine(() => true, "no"),
    })),
    none,
  );
  assertEquals(code(z.array(marked).min(1, "one at least")), none);
  assertEquals(
    code(z.object({ a: marked }).refine(() => true, "static")),
    messages,
  );
  assertEquals(
    code(z.object({ a: marked }).refine(() => true, { path: ["b"] })),
    messages,
  );
  assertEquals(
    code(z.object({ a: marked }).optional().refine(() => true)),
    messages,
  );
  assertEquals(
    code(z.discriminatedUnion("k", [
      z.object({ k: z.literal("a"), a: marked }),
      z.object({ k: z.literal("b") }),
    ], { error: "pick one" })),
    messages,
  );
  assertEquals(
    code(z.union([
      z.object({ a: marked }),
      z.object({ b: z.string() }).refine(() => true, "no"),
    ])),
    messages,
  );
  assertEquals(code(z.object({ a: marked }).superRefine(() => {})), both);
  assertEquals(code(z.object({ a: marked }).check(() => {})), both);
  assertEquals(code(z.object({ a: marked }).transform((v) => v)), both);
  assertEquals(code(z.preprocess((v) => v, z.object({ a: marked }))), both);
  assertEquals(
    code(z.object({ creds: z.object({ a: marked }).superRefine(() => {}) })),
    both,
  );
  assertEquals(
    code(
      z.intersection(z.object({ a: marked }), z.any().superRefine(() => {})),
    ),
    both,
  );
  // Code on the marked node itself adds issues at its own position only.
  assertEquals(code(z.object({ a: marked.superRefine(() => {}) })), {
    messages: false,
    issues: true,
  });
  assertEquals(code(z.object({ a: marked.transform((s) => s) })), {
    messages: false,
    issues: true,
  });
  // A schema that contains itself is entered once.
  type Node = { a: string; next?: Node | undefined };
  const node: z.ZodType<Node> = z.lazy(() =>
    z.object({ a: marked, next: node.optional() }).refine(() => true, "no")
  );
  assertEquals(code(node), messages);
  // The answer is kept per schema.
  const kept = z.object({ a: marked }).superRefine(() => {});
  assertEquals(code(kept), code(kept));
});
