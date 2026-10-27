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

/**
 * Fitness tests for parsing untrusted input (swamp-club#3862):
 *
 *   1. In serve's ingress files, every zod parse of request input goes
 *      through `parseUntrusted` / `parseUntrustedOrThrow`, which stop each
 *      container at its first failure.
 *   2. Every record a client or worker can send whose values can fail is a
 *      `boundedRecord`: zod records ignore `abortEarly`, so an unbounded one
 *      builds one issue per entry.
 *   3. Run-argument schemas take `argumentParseContext()`, so serve's
 *      untrusted policy reaches them; the literal `reportInput` option
 *      appears only where it is pinned.
 *
 * Static and in-process — no subprocesses.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { z } from "zod";
import {
  assertPinnedSet,
  isCommentLine,
  productionSourceFiles,
  repoRelative,
  ROOT,
  SRC_DIR,
  topLevelOwners,
} from "./arch_fitness_helpers.ts";
import {
  boundedRecord,
  isBoundedRecordGuard,
} from "../src/domain/untrusted_parse.ts";
import { serverRequestSchemas } from "../src/serve/connection.ts";
import {
  DeleteDataParamsSchema,
  DispatchResultSchema,
  EnrollParamsSchema,
  GetDataParamsSchema,
  ListVersionsParamsSchema,
  PutSecretParamsSchema,
  QueryDataParamsSchema,
  ReadDefinitionParamsSchema,
  ReadOutputParamsSchema,
  ResolveModelParamsSchema,
  ResolveSecretParamsSchema,
} from "../src/domain/remote/protocol.ts";
import {
  FileWriterOverridesSchema,
  ResourceWriteOverridesSchema,
} from "../src/domain/models/model.ts";
import { DataMetadataSchema } from "../src/domain/data/data_metadata.ts";

// ── 1. Ingress parses go through the helper ────────────────────────────

const INGRESS_FILES = [
  "src/serve/connection.ts",
  "src/serve/worker_gateway.ts",
  "src/serve/capability_service.ts",
  "src/serve/data_plane.ts",
];

/** A `<receiver>.parse(` or `<receiver>.safeParse(` call. */
const ZOD_PARSE_CALL = /\b(\w+)\.(safeParse|parse)\(/g;

/** Receivers whose `parse` is not zod's. */
const NOT_ZOD = new Set(["JSON", "Date"]);

/**
 * Raw parses in the ingress files that read swamp's own stored records, not
 * request input. Format: `<file>: <receiver>.<method>`.
 */
const PINNED_RAW_INGRESS_PARSES = [
  // An enrollment token record read back from the datastore.
  "src/serve/worker_gateway.ts: EnrollmentTokenSchema.safeParse",
];

Deno.test("serve ingress files parse request input only through parseUntrusted", async () => {
  const found = new Set<string>();
  for (const rel of INGRESS_FILES) {
    const lines = (await Deno.readTextFile(join(ROOT, rel))).split(
      "\n",
    );
    for (const line of lines) {
      if (isCommentLine(line)) continue;
      for (const match of line.matchAll(ZOD_PARSE_CALL)) {
        if (NOT_ZOD.has(match[1])) continue;
        found.add(`${rel}: ${match[1]}.${match[2]}`);
      }
    }
  }
  assertPinnedSet(
    [...found].sort(),
    PINNED_RAW_INGRESS_PARSES,
    "Raw zod parses in serve ingress files",
    "Parse request input with parseUntrusted or parseUntrustedOrThrow from " +
      "src/domain/untrusted_parse.ts, so a refusal stops at the first " +
      "failure instead of building one issue per element. Pin a call here " +
      "only if it reads a record swamp stored itself.",
  );
});

// ── 2. Typed-value records are bounded ─────────────────────────────────

interface ZodDef {
  type: string;
  [key: string]: unknown;
}

function defOf(schema: unknown): ZodDef {
  return (schema as { _zod: { def: ZodDef } })._zod.def;
}

/** Value types that accept every entry, so a record of them cannot amplify. */
const ACCEPTS_ANY = new Set(["unknown", "any"]);

/**
 * The paths of records under `schema` whose values can fail and that no
 * `boundedRecord` guard wraps.
 */
function unboundedRecords(
  schema: unknown,
  path: string,
  seen: Set<unknown> = new Set(),
  guarded = false,
): string[] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const def = defOf(schema);
  const child = (s: unknown, p: string, g = false) =>
    unboundedRecords(s, p, seen, g);
  switch (def.type) {
    case "record": {
      const own = !guarded && !ACCEPTS_ANY.has(defOf(def.valueType).type)
        ? [path]
        : [];
      return [...own, ...child(def.valueType, `${path}.*`)];
    }
    case "pipe":
      return [
        ...child(def.in, path),
        ...child(def.out, path, isBoundedRecordGuard(def.in)),
      ];
    case "object":
      return Object.entries(def.shape as Record<string, unknown>).flatMap((
        [key, value],
      ) => child(value, `${path}.${key}`));
    case "array":
      return child(def.element, `${path}[]`);
    case "union":
      return (def.options as unknown[]).flatMap((o) => child(o, path));
    case "intersection":
      return [...child(def.left, path), ...child(def.right, path)];
    case "tuple":
      return [
        ...(def.items as unknown[]).flatMap((s, i) =>
          child(s, `${path}[${i}]`)
        ),
        ...(def.rest ? child(def.rest, `${path}[]`) : []),
      ];
    case "lazy":
      return child((def.getter as () => unknown)(), path, guarded);
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "catch":
    case "readonly":
    case "nonoptional":
      return child(def.innerType, path, guarded);
    default:
      return [];
  }
}

function requestLabel(schema: z.ZodType): string {
  const shape = defOf(schema).shape as Record<string, unknown>;
  return String(defOf(shape.type).values ?? "request");
}

Deno.test("every typed-value record a client or worker can send is a boundedRecord", () => {
  const ingress: [string, unknown][] = [
    ...serverRequestSchemas().map((s): [string, unknown] => [
      requestLabel(s),
      s,
    ]),
    ["EnrollParams", EnrollParamsSchema],
    ["DispatchResult", DispatchResultSchema],
    ["GetDataParams", GetDataParamsSchema],
    ["QueryDataParams", QueryDataParamsSchema],
    ["ListVersionsParams", ListVersionsParamsSchema],
    ["DeleteDataParams", DeleteDataParamsSchema],
    ["ResolveSecretParams", ResolveSecretParamsSchema],
    ["PutSecretParams", PutSecretParamsSchema],
    ["ReadDefinitionParams", ReadDefinitionParamsSchema],
    ["ReadOutputParams", ReadOutputParamsSchema],
    ["ResolveModelParams", ResolveModelParamsSchema],
    ["ResourceWriteOverrides", ResourceWriteOverridesSchema],
    ["FileWriterOverrides", FileWriterOverridesSchema],
    ["DataMetadata", DataMetadataSchema],
  ];
  const offenders = ingress.flatMap(([label, schema]) =>
    unboundedRecords(schema, label)
  );
  assertEquals(
    offenders,
    [],
    "wrap these records in boundedRecord from src/domain/untrusted_parse.ts: " +
      "zod records ignore abortEarly, so an unbounded one builds one issue " +
      "per failing entry",
  );
});

Deno.test("the record walker flags a bare typed-value record and passes a bounded one", () => {
  assertEquals(
    unboundedRecords(
      z.object({ tags: z.record(z.string(), z.string()).optional() }),
      "s",
    ),
    ["s.tags"],
  );
  assertEquals(
    unboundedRecords(
      z.object({ tags: z.lazy(() => z.record(z.string(), z.string())) }),
      "s",
    ),
    ["s.tags"],
  );
  assertEquals(
    unboundedRecords(
      z.object({
        tags: boundedRecord(z.string(), z.string()).optional(),
        inputs: z.record(z.string(), z.unknown()),
      }),
      "s",
    ),
    [],
  );
});

// ── 3. reportInput only where pinned ───────────────────────────────────

const REPORT_INPUT_OPTION = /\breportInput\s*:/;

/**
 * Where the literal `reportInput` option may appear. Format:
 * `<file>: <top-level declaration>`.
 */
const PINNED_REPORT_INPUT = [
  // The two argument parse contexts themselves.
  "src/domain/untrusted_parse.ts: TRUSTED_ARGUMENTS",
  "src/domain/untrusted_parse.ts: UNTRUSTED_ARGUMENTS",
  // Drops issues at absent keys after the parse, so abortEarly could hide a
  // failing present key; it runs only once every field has passed its own
  // parse, so its full parse cannot grow with the input.
  "src/domain/models/zod_type_coercion.ts: objectRefinementIssues",
];

Deno.test("run-argument schemas take argumentParseContext, not a literal reportInput", async () => {
  const found = new Set<string>();
  for await (const path of productionSourceFiles(SRC_DIR)) {
    const lines = (await Deno.readTextFile(path)).split("\n");
    const owners = topLevelOwners(lines);
    lines.forEach((line, i) => {
      if (isCommentLine(line) || !REPORT_INPUT_OPTION.test(line)) return;
      found.add(`${repoRelative(path)}: ${owners[i]}`);
    });
  }
  assertPinnedSet(
    [...found].sort(),
    PINNED_REPORT_INPUT,
    "Literal reportInput parse options",
    "Pass argumentParseContext() from src/domain/untrusted_parse.ts, so " +
      "serve's untrusted policy stops the parse at the first failure.",
  );
});
