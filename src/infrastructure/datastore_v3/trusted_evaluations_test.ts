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

import { assertEquals, assertRejects } from "@std/assert";
import { stringify as stringifyYaml } from "@std/yaml";
import { Definition } from "../../domain/definitions/definition.ts";
import { BlobRef } from "../../domain/datastore_v3/blob_ref.ts";
import { UserError } from "../../domain/errors.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import type { LiveRecordWriter } from "./read_model_state.ts";
import { v3EvaluationTrust } from "./trusted_evaluations.ts";
import type { V3Datastore } from "./v3_datastore.ts";

const TYPE = ModelType.create("acme/web");

/** A trust over one stored evaluation of `web`, written by `writer`. */
function trustOver(
  writer: string | null,
  options: { stored?: Definition; size?: number } = {},
) {
  const definition = Definition.create({
    name: "web",
    type: TYPE.normalized,
    globalArguments: {},
  });
  const stored = options.stored ?? definition;
  const bytes = new TextEncoder().encode(
    stringifyYaml(JSON.parse(JSON.stringify(stored.toData()))),
  );
  const record: LiveRecordWriter = {
    sha256: "a".repeat(64),
    writer,
    ...(options.size === undefined ? {} : {
      blob: BlobRef.create({ sha256: "b".repeat(64), size: options.size }),
    }),
  };
  const caughtUp: string[] = [];
  const v3 = {
    namespace: "",
    readModel: {
      catchUpPartition: (_ns: string, partition: { toString(): string }) => {
        caughtUp.push(partition.toString());
        return Promise.resolve({ applied: 0, cursor: 0 });
      },
      liveRecord: (_ns: string, _p: unknown, key: string) =>
        Promise.resolve(
          key === `definitions-evaluated/${TYPE.normalized}/web.yaml`
            ? record
            : undefined,
        ),
      recordBytes: () => Promise.resolve({ record, bytes }),
    },
  } as unknown as Pick<V3Datastore, "namespace" | "readModel">;
  const trust = v3EvaluationTrust(v3, {
    definitionRepo: { findByName: () => Promise.resolve(definition) },
    workflowRepo: { findByName: () => Promise.resolve(null) },
  });
  return { trust, caughtUp, definition };
}

Deno.test("v3EvaluationTrust: serve's own evaluation is read after catching its partition up", async () => {
  const { trust, caughtUp, definition } = trustOver("");
  const cache = await trust.definition(TYPE, "web");
  assertEquals(cache?.definition.id, definition.id);
  assertEquals(caughtUp.length, 1);
});

Deno.test("v3EvaluationTrust: an evaluation a forwarded commit wrote, or of unknown writer, is refused", async () => {
  for (const writer of ["user:ana", null]) {
    await assertRejects(
      () => trustOver(writer).trust.definition(TYPE, "web"),
      UserError,
      "not made on this server",
    );
  }
});

Deno.test("v3EvaluationTrust: an evaluation past the size serve runs is refused as too large", async () => {
  await assertRejects(
    () =>
      trustOver("", { size: 32 * 1024 * 1024 }).trust.definition(TYPE, "web"),
    UserError,
    "larger than serve runs",
  );
});

Deno.test("v3EvaluationTrust: a file of the behavior's name holding another behavior's evaluation is not it", async () => {
  const other = Definition.create({
    name: "web",
    type: TYPE.normalized,
    globalArguments: {},
  });
  assertEquals(
    await trustOver("", { stored: other }).trust.definition(TYPE, "web"),
    null,
  );
});
