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

import { assertRejects } from "@std/assert";
import { join } from "@std/path";
import { FileSystemUnifiedDataRepository } from "../../../infrastructure/persistence/unified_data_repository.ts";
import { CatalogStore } from "../../../infrastructure/persistence/catalog_store.ts";
import { Data } from "../../data/mod.ts";
import { GRANT_MODEL_TYPE } from "./grant_model.ts";
import { GROUP_MODEL_TYPE } from "./group_model.ts";
import { OwnershipValidationError } from "../../data/repositories.ts";

const modelMethodOwner = {
  ownerType: "model-method" as const,
  ownerRef: "swamp/grant:create",
};

const genericOwner = {
  ownerType: "workflow-step" as const,
  ownerRef: "some-workflow:some-step",
};

function makeModelOwnedData(name: string): Data {
  return Data.create({
    name,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource", specName: "grant" },
    ownerDefinition: modelMethodOwner,
  });
}

function makeGenericData(name: string): Data {
  return Data.create({
    name,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource" },
    ownerDefinition: genericOwner,
  });
}

async function withTempRepo(
  fn: (repo: FileSystemUnifiedDataRepository) => Promise<void>,
): Promise<void> {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    await fn(repo);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
}

const content = new TextEncoder().encode(JSON.stringify({ test: true }));

Deno.test("ownership: generic write to grant data owned by model-method is rejected", async () => {
  await withTempRepo(async (repo) => {
    const modelData = makeModelOwnedData("grant-main");
    await repo.save(GRANT_MODEL_TYPE, "test-grant", modelData, content);

    const intruderData = makeGenericData("grant-main");
    await assertRejects(
      () => repo.save(GRANT_MODEL_TYPE, "test-grant", intruderData, content),
      OwnershipValidationError,
      "does not match",
    );
  });
});

Deno.test("ownership: generic write to group data owned by model-method is rejected", async () => {
  const groupMethodOwner = {
    ownerType: "model-method" as const,
    ownerRef: "swamp/group:create",
  };
  await withTempRepo(async (repo) => {
    const modelData = Data.create({
      name: "group-main",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", specName: "group" },
      ownerDefinition: groupMethodOwner,
    });
    await repo.save(GROUP_MODEL_TYPE, "test-group", modelData, content);

    const intruderData = makeGenericData("group-main");
    await assertRejects(
      () => repo.save(GROUP_MODEL_TYPE, "test-group", intruderData, content),
      OwnershipValidationError,
      "does not match",
    );
  });
});

Deno.test("ownership: same model-method owner can write successive versions", async () => {
  await withTempRepo(async (repo) => {
    const data1 = makeModelOwnedData("grant-main");
    await repo.save(GRANT_MODEL_TYPE, "test-grant", data1, content);

    const data2 = makeModelOwnedData("grant-main");
    const v2Content = new TextEncoder().encode(
      JSON.stringify({ test: true, version: 2 }),
    );
    await repo.save(GRANT_MODEL_TYPE, "test-grant", data2, v2Content);
  });
});

Deno.test("ownership: different model-method ownerRef on same model is rejected", async () => {
  await withTempRepo(async (repo) => {
    const modelData = makeModelOwnedData("grant-main");
    await repo.save(GRANT_MODEL_TYPE, "test-grant", modelData, content);

    const otherMethodData = Data.create({
      name: "grant-main",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource" },
      ownerDefinition: {
        ownerType: "model-method",
        ownerRef: "swamp/grant:revoke",
      },
    });
    await assertRejects(
      () =>
        repo.save(
          GRANT_MODEL_TYPE,
          "test-grant",
          otherMethodData,
          content,
        ),
      OwnershipValidationError,
      "does not match",
    );
  });
});
