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

import { assertEquals, assertThrows } from "@std/assert";
import { Data, RECORD_KIND_TAG } from "./data.ts";
import {
  assertKindContinues,
  type DataKind,
  DataKindConflictError,
  dataKindOf,
} from "./data_kind.ts";
import { UserError } from "../errors.ts";

const owner = { ownerType: "model-method" as const, ownerRef: "t:m" };

function version(
  props: {
    kind?: DataKind;
    type?: string;
    spec?: string;
    version?: number;
    modelName?: string;
  },
): Data {
  const tags: Record<string, string> = { type: props.type ?? "resource" };
  if (props.spec !== undefined) tags["specName"] = props.spec;
  if (props.modelName !== undefined) tags["modelName"] = props.modelName;
  if (props.kind !== undefined) tags[RECORD_KIND_TAG] = props.kind;
  return Data.create({
    name: "x",
    version: props.version ?? 1,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags,
    ownerDefinition: owner,
  });
}

Deno.test("dataKindOf: the stamped kind wins over the type tag", () => {
  assertEquals(
    dataKindOf(version({ kind: "file", type: "agent-session" })),
    "file",
  );
});

Deno.test("dataKindOf: an unstamped version falls back to a type tag naming a kind", () => {
  assertEquals(dataKindOf(version({ type: "file" })), "file");
  assertEquals(dataKindOf(version({ type: "resource" })), "resource");
});

Deno.test("dataKindOf: an unstamped version with any other type tag is unknown", () => {
  assertEquals(dataKindOf(version({ type: "agent-session" })), undefined);
});

Deno.test("assertKindContinues: refuses a resource after a file, naming the version, spec and model", () => {
  const prior = version({
    kind: "file",
    type: "file",
    spec: "blob",
    modelName: "fwd",
  });
  const error = assertThrows(
    () => assertKindContinues(prior, version({ kind: "resource" }), "id-1"),
    DataKindConflictError,
  );
  assertEquals(
    error.message,
    "Duplicate data instance name 'x' (version 1 was written as file 'blob'; delete it with swamp data delete fwd x before writing it as a resource)",
  );
  assertEquals(error instanceof UserError, true);
});

Deno.test("assertKindContinues: refuses a file after a resource, and names the model id without a modelName tag", () => {
  const error = assertThrows(
    () =>
      assertKindContinues(
        version({ kind: "resource", spec: "meta", version: 3 }),
        version({ kind: "file", type: "file" }),
        "id-1",
      ),
    DataKindConflictError,
  );
  assertEquals(
    error.message,
    "Duplicate data instance name 'x' (version 3 was written as resource 'meta'; delete it with swamp data delete id-1 x before writing it as a file)",
  );
});

Deno.test("assertKindContinues: a legacy version is checked through its type tag", () => {
  assertThrows(
    () =>
      assertKindContinues(
        version({ type: "file" }),
        version({ kind: "resource" }),
        "id",
      ),
    DataKindConflictError,
  );
});

Deno.test("assertKindContinues: allows the same kind under another spec", () => {
  assertKindContinues(
    version({ kind: "resource", spec: "a" }),
    version({ kind: "resource", spec: "b" }),
    "id",
  );
});

Deno.test("assertKindContinues: allows any kind after a delete or rename marker", () => {
  const prior = version({ kind: "file", type: "file" });
  assertKindContinues(
    prior.withDeletionMarker({ version: 2 }),
    version({ kind: "resource" }),
    "id",
  );
  assertKindContinues(
    prior.withRenameMarker({ version: 2, renamedTo: "y" }),
    version({ kind: "resource" }),
    "id",
  );
});

Deno.test("assertKindContinues: a marker written over another kind is not refused", () => {
  assertKindContinues(
    version({ kind: "resource" }),
    version({ kind: "file", type: "file" }).withDeletionMarker({ version: 2 }),
    "id",
  );
});

Deno.test("assertKindContinues: nothing to compare when there is no prior version or a kind is unknown", () => {
  assertKindContinues(null, version({ kind: "file", type: "file" }), "id");
  assertKindContinues(
    version({ type: "agent-session" }),
    version({ kind: "file", type: "file" }),
    "id",
  );
});
