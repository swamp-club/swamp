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
 * Integration test for reading content of every type through the data query
 * service (swamp-club#2959): items written through the data repository are
 * read back byte for byte by a projection, and a predicate that reads
 * `content` on a binary item fails, unless the caller may not read the item.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { Data } from "../src/domain/data/data.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { DataQueryService } from "../src/domain/data/data_query_service.ts";
import { BinaryContentPredicateError } from "../src/domain/data/binary_content_predicate_error.ts";
import type { DataRecord } from "../src/domain/data/data_record.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-query-binary-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native sqlite handles.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

const type = ModelType.create("test/model");
const owner = { ownerType: "model-method" as const, ownerRef: "test/model:m" };

// Every byte value, so no encoding step can drop or replace one.
const BINARY = Uint8Array.from({ length: 512 }, (_, i) => i % 256);
// Latin-1 "café": 0xe9 alone is not valid UTF-8.
const LATIN1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);

const ITEMS: Array<{ name: string; contentType: string; bytes: Uint8Array }> = [
  { name: "archive", contentType: "application/gzip", bytes: BINARY },
  { name: "latin1", contentType: "text/plain", bytes: LATIN1 },
  {
    name: "notes",
    contentType: "text/markdown",
    bytes: new TextEncoder().encode("# notes\nhello"),
  },
  {
    name: "info",
    contentType: "application/json",
    bytes: new TextEncoder().encode('{"k":1}'),
  },
];

/** Writes ITEMS through the repository, then queries a freshly opened catalog. */
async function withQueryService(
  repoDir: string,
  fn: (service: DataQueryService) => Promise<void>,
): Promise<void> {
  await ensureDir(join(repoDir, ".swamp", "data"));
  const modelId = crypto.randomUUID();
  const dbPath = join(repoDir, ".swamp", "data", "_catalog.db");
  {
    const catalog = new CatalogStore(dbPath);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
    for (const item of ITEMS) {
      await repo.save(
        type,
        modelId,
        Data.create({
          name: item.name,
          contentType: item.contentType,
          lifetime: "infinite",
          garbageCollection: 10,
          tags: { type: "resource", modelName: "ingest", specName: "result" },
          ownerDefinition: owner,
        }),
        item.bytes,
      );
    }
    catalog.close();
  }
  const catalog = new CatalogStore(dbPath);
  try {
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
    await fn(new DataQueryService(catalog, repo));
  } finally {
    catalog.close();
  }
}

/** Decodes a projected content value back into the stored bytes. */
function bytesOf(projected: unknown): Uint8Array {
  const { content, contentEncoding } = projected as {
    content: string;
    contentEncoding: string;
  };
  return contentEncoding === "base64"
    ? Uint8Array.fromBase64(content)
    : new TextEncoder().encode(content);
}

Deno.test("data query: a content projection returns every item's stored bytes", async () => {
  await withTempDir(async (repoDir) => {
    await withQueryService(repoDir, async (service) => {
      for (const item of ITEMS.filter((i) => i.name !== "info")) {
        const [projected] = await service.query(`name == "${item.name}"`, {
          select: '{"content": content, "contentEncoding": contentEncoding}',
        });
        assertEquals(bytesOf(projected), item.bytes, item.name);
      }
      assertEquals(
        await service.query('name == "info"', {
          select: '{"content": content, "contentEncoding": contentEncoding}',
        }),
        [{ content: { k: 1 }, contentEncoding: "utf-8" }],
      );
    });
  });
});

Deno.test("data query: a content predicate fails on a binary item and passes when guarded", async () => {
  await withTempDir(async (repoDir) => {
    await withQueryService(repoDir, async (service) => {
      const error = await assertRejects(
        () => service.query('content.contains("hello")'),
        BinaryContentPredicateError,
      );
      assertEquals(error.item.name, "archive");

      const guarded = await service.query(
        'contentType.startsWith("text/") && content.contains("hello")',
      ) as DataRecord[];
      assertEquals(guarded.map((r) => r.name), ["notes"]);
    });
  });
});

Deno.test("data query: a binary item the caller may not read never fails the query", async () => {
  await withTempDir(async (repoDir) => {
    await withQueryService(repoDir, async (service) => {
      const results = await service.query('content.contains("hello")', {
        include: (record) => Promise.resolve(record.name !== "archive"),
      }) as DataRecord[];
      assertEquals(results.map((r) => r.name), ["notes"]);
    });
  });
});
