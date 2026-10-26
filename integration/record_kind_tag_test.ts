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
 * The writers stamp every record with `_swamp.kind`, and readResource's
 * schema fallback serves only records without it (swamp-club#3684). These
 * tests write through the real writers into a file-system repository and
 * read back through createResourceReader, so the stamp must survive
 * persistence and the catalog.
 */
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { z } from "zod";
import { ModelType } from "../src/domain/models/model_type.ts";
import type { ResourceOutputSpec } from "../src/domain/models/model.ts";
import {
  createFileWriterFactory,
  createResourceReader,
  createResourceWriter,
  RECORD_KIND_TAG,
} from "../src/domain/models/data_writer.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-record-kind-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

const modelType = ModelType.create("test/record-kind");
const modelId = crypto.randomUUID();
const REFERENCE = "${{ vault.get('test-vault', 'db-password') }}";

/** A sensitiveOutput resource spec and a plain one. */
const RESOURCES: Record<string, ResourceOutputSpec> = {
  creds: {
    schema: z.object({ value: z.string() }),
    sensitiveOutput: true,
    lifetime: "infinite",
    garbageCollection: 5,
  },
  plain: {
    schema: z.object({ value: z.string() }),
    lifetime: "infinite",
    garbageCollection: 5,
  },
};

/** A file spec that shares the sensitive resource spec's name. */
const FILES = {
  creds: {
    contentType: "application/json",
    lifetime: "infinite" as const,
    garbageCollection: 5,
  },
};

async function fixture(repoDir: string) {
  const repo = new FileSystemUnifiedDataRepository(
    repoDir,
    undefined,
    new CatalogStore(join(repoDir, "_catalog.db")),
  );
  const vault = new VaultService();
  vault.registerVault({ name: "test-vault", type: "mock", config: {} });
  await vault.put("test-vault", "db-password", "hunter2");
  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    RESOURCES,
    undefined,
    undefined,
    undefined,
    undefined,
    "kind-def",
    vault,
    "run",
  );
  const { createFileWriter } = createFileWriterFactory(
    repo,
    modelType,
    modelId,
    FILES,
  );
  const readResource = createResourceReader(
    repo,
    modelType,
    modelId,
    vault,
    undefined,
    RESOURCES,
  );
  return { repo, writeResource, createFileWriter, readResource };
}

Deno.test("record kind: a file record under a file spec named like a sensitive resource spec reads back unresolved", async () => {
  await withTempDir(async (repoDir) => {
    const f = await fixture(repoDir);
    const handle = await f.createFileWriter("creds", "fetched").writeText(
      JSON.stringify({ value: REFERENCE }),
    );
    assertEquals(handle.tags[RECORD_KIND_TAG], "file");

    const stored = await f.repo.findByName(modelType, modelId, "fetched");
    assertEquals(stored?.tags[RECORD_KIND_TAG], "file");
    assertEquals(await f.readResource("fetched"), { value: REFERENCE });
  });
});

Deno.test("record kind: reference text in a plain resource reads back unresolved", async () => {
  await withTempDir(async (repoDir) => {
    const f = await fixture(repoDir);
    await f.writeResource("plain", "response", { value: REFERENCE });

    const stored = await f.repo.findByName(modelType, modelId, "response");
    assertEquals(stored?.tags[RECORD_KIND_TAG], "resource");
    assertEquals(await f.readResource("response"), { value: REFERENCE });
  });
});

Deno.test("record kind: a vaulted resource still resolves", async () => {
  await withTempDir(async (repoDir) => {
    const f = await fixture(repoDir);
    await f.writeResource("creds", "main", { value: "s3cret" });

    const stored = await f.repo.findByName(modelType, modelId, "main");
    assertEquals(stored?.tags[RECORD_KIND_TAG], "resource");
    assertEquals(await f.readResource("main"), { value: "s3cret" });
  });
});
