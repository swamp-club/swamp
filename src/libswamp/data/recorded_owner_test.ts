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
import { Definition } from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import {
  type DataOwnerLookupDeps,
  type RecordedDataOwner,
  resolveDataOwner,
} from "./recorded_owner.ts";

const DEFINITION = Definition.create({
  id: "00000000-0000-4000-8000-000000000001",
  name: "live",
  version: 1,
});

const ORPHAN_A: RecordedDataOwner = {
  modelType: "command/shell",
  modelId: "00000000-0000-4000-8000-00000000000a",
  modelName: "orphan",
};
const ORPHAN_B: RecordedDataOwner = {
  ...ORPHAN_A,
  modelId: "00000000-0000-4000-8000-00000000000b",
};

function depsWith(
  owners: readonly RecordedDataOwner[],
  calls: Array<{ idOrName: string; dataName?: string }> = [],
): DataOwnerLookupDeps {
  return {
    lookupDefinition: (idOrName) =>
      Promise.resolve(
        idOrName === "live"
          ? { definition: DEFINITION, type: ModelType.create("model/type") }
          : null,
      ),
    lookupDefinitionById: () => Promise.resolve(null),
    findRecordedOwners: (idOrName, dataName) => {
      calls.push({ idOrName, dataName });
      return Promise.resolve(owners);
    },
  };
}

Deno.test("resolveDataOwner: a definition that exists wins over a recorded owner", async () => {
  const calls: Array<{ idOrName: string }> = [];
  const result = await resolveDataOwner(
    "data get",
    depsWith([ORPHAN_A], calls),
    {
      modelIdOrName: "live",
    },
  );
  assertEquals(result.kind === "found" ? result.modelId : null, DEFINITION.id);
  assertEquals(calls, []);
});

Deno.test("resolveDataOwner: a missing definition reads its one recorded owner", async () => {
  const calls: Array<{ idOrName: string; dataName?: string }> = [];
  const result = await resolveDataOwner(
    "data get",
    depsWith([ORPHAN_A], calls),
    {
      modelIdOrName: "orphan",
      dataName: "result",
    },
  );
  assertEquals(result.kind, "found");
  if (result.kind !== "found") return;
  assertEquals(result.modelId, ORPHAN_A.modelId);
  assertEquals(result.modelName, "orphan");
  assertEquals(result.modelType.normalized, "command/shell");
  assertEquals(calls, [{ idOrName: "orphan", dataName: "result" }]);
});

Deno.test("resolveDataOwner: no definition and no recorded owner is behavior not found", async () => {
  const result = await resolveDataOwner("data get", depsWith([]), {
    modelIdOrName: "orphan",
  });
  assertEquals(result.kind === "error" ? result.error.code : null, "not_found");
});

Deno.test("resolveDataOwner: several recorded owners are refused, naming each id", async () => {
  const result = await resolveDataOwner(
    "data get",
    depsWith([ORPHAN_A, ORPHAN_B]),
    { modelIdOrName: "orphan" },
  );
  assertEquals(result.kind, "error");
  if (result.kind !== "error") return;
  assertEquals(result.error.code, "validation_failed");
  assertEquals(
    result.error.message,
    "No behavior definition is named orphan, and its data is recorded under " +
      `2 behavior ids: ${ORPHAN_A.modelId} (command/shell), ` +
      `${ORPHAN_B.modelId} (command/shell). Pass one of the ids instead of ` +
      "the name.",
  );
});

Deno.test("resolveDataOwner: a by-id read never falls back to a recorded owner", async () => {
  const calls: Array<{ idOrName: string }> = [];
  const result = await resolveDataOwner(
    "data get",
    depsWith([ORPHAN_A], calls),
    {
      modelIdOrName: "orphan",
      byId: true,
    },
  );
  assertEquals(result.kind === "error" ? result.error.code : null, "not_found");
  assertEquals(calls, []);
});

Deno.test("resolveDataOwner: a given recorded owner is read without any lookup", async () => {
  const deps: DataOwnerLookupDeps = {
    lookupDefinition: () => Promise.reject(new Error("looked up")),
    findRecordedOwners: () => Promise.reject(new Error("looked up")),
  };
  const result = await resolveDataOwner("data get", deps, {
    modelIdOrName: "orphan",
    byId: true,
    recordedOwner: ORPHAN_B,
  });
  assertEquals(
    result.kind === "found" ? result.modelId : null,
    ORPHAN_B.modelId,
  );
});

Deno.test("resolveDataOwner: without a recorded-owner lookup a miss stays not found", async () => {
  const deps: DataOwnerLookupDeps = {
    lookupDefinition: () => Promise.resolve(null),
  };
  const result = await resolveDataOwner("data get", deps, {
    modelIdOrName: "orphan",
  });
  assertEquals(result.kind === "error" ? result.error.code : null, "not_found");
  await assertRejects(() =>
    resolveDataOwner("data get", deps, { modelIdOrName: "x", byId: true })
  );
});
