// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { join } from "@std/path";
import {
  createRepositoryContext,
  createUnifiedDataRepository,
} from "./repository_factory.ts";
import { CatalogStore } from "./catalog_store.ts";
import {
  createNamespace,
  SOLO_NAMESPACE,
} from "../../domain/data/namespace.ts";

function tempRepoDir(): string {
  return Deno.makeTempDirSync({ prefix: "swamp-factory-test-" });
}

Deno.test("createRepositoryContext: resolves config namespace into the repository", () => {
  const dir = tempRepoDir();
  const ctx = createRepositoryContext({
    repoDir: dir,
    enableIndexing: false,
    namespace: "infra",
  });
  assertEquals(ctx.unifiedDataRepo.namespace, "infra");
  ctx.catalogStore.close();
});

Deno.test("createRepositoryContext: defaults to SOLO_NAMESPACE when no namespace is configured", () => {
  const dir = tempRepoDir();
  const ctx = createRepositoryContext({
    repoDir: dir,
    enableIndexing: false,
  });
  assertEquals(ctx.unifiedDataRepo.namespace, SOLO_NAMESPACE);
  ctx.catalogStore.close();
});

Deno.test("createRepositoryContext: rejects a malformed namespace slug", () => {
  const dir = tempRepoDir();
  assertThrows(
    () =>
      createRepositoryContext({
        repoDir: dir,
        enableIndexing: false,
        namespace: "Not Valid",
      }),
    Error,
    "Namespace must match",
  );
});

Deno.test("createUnifiedDataRepository: passes the namespace through to the repository", () => {
  const dir = tempRepoDir();
  const catalog = new CatalogStore(join(dir, "_catalog.db"));
  const repo = createUnifiedDataRepository(
    dir,
    catalog,
    undefined,
    undefined,
    createNamespace("security"),
  );
  assertEquals(repo.namespace, "security");
  catalog.close();
});

Deno.test("createUnifiedDataRepository: defaults to SOLO_NAMESPACE", () => {
  const dir = tempRepoDir();
  const catalog = new CatalogStore(join(dir, "_catalog.db"));
  const repo = createUnifiedDataRepository(dir, catalog);
  assertEquals(repo.namespace, SOLO_NAMESPACE);
  catalog.close();
});
