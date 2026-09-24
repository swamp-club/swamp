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
 * Integration test for the data get content contract (swamp-club#2503).
 *
 * A model writes a PNG and a UTF-8 text file through the real file writer
 * into a real FileSystemUnifiedDataRepository. dataGet, wired with
 * createDataGetDeps, must hand both back without losing a byte: the PNG as
 * base64 whose SHA-256 matches the stored checksum, the text as utf-8. The
 * same DataGetData is what serve's data.get and `data get --server` return.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { createFileWriterFactory } from "../src/domain/models/data_writer.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import {
  collect,
  createDataGetDeps,
  createLibSwampContext,
  dataGet,
  type DataGetData,
  type DataGetEvent,
} from "../src/libswamp/mod.ts";

// A 67-byte 1x1 grayscale PNG. 0x89 and several other bytes are not valid
// UTF-8.
const PNG = Uint8Array.fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR42mP4DwABAQEAHLCMmQAAAABJRU5ErkJggg==",
);
const TEXT = "héllo wörld ✓ — utf-8 text control\n";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-data-get-binary-" });
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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return new Uint8Array(digest).toHex();
}

async function getData(
  repoDir: string,
  dataRepo: FileSystemUnifiedDataRepository,
  definitionRepo: YamlDefinitionRepository,
  dataName: string,
): Promise<DataGetData> {
  const deps = createDataGetDeps(
    repoDir,
    undefined,
    dataRepo,
    undefined,
    definitionRepo,
  );
  const events = await collect<DataGetEvent>(
    dataGet(createLibSwampContext(), deps, {
      modelIdOrName: "binary-writer",
      dataName,
      includeContent: true,
      repoDir,
    }),
  );
  const last = events.at(-1)!;
  if (last.kind !== "completed") {
    throw new Error(`dataGet did not complete: ${JSON.stringify(last)}`);
  }
  return last.data;
}

Deno.test("Integration: data get returns binary and text file artifacts losslessly", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const modelType = ModelType.create("test/binary-writer");
    const definition = Definition.create({ name: "binary-writer" });
    await definitionRepo.save(modelType, definition);

    const { createFileWriter } = createFileWriterFactory(
      dataRepo,
      modelType,
      definition.id,
      {
        logo: {
          contentType: "image/png",
          lifetime: "infinite",
          garbageCollection: 5,
        },
        note: {
          contentType: "text/plain",
          lifetime: "infinite",
          garbageCollection: 5,
        },
      },
    );
    await createFileWriter("logo", "pixel", { contentType: "image/png" })
      .writeAll(PNG);
    await createFileWriter("note", "hello").writeText(TEXT);

    const png = await getData(repoDir, dataRepo, definitionRepo, "pixel");
    assertEquals(png.contentType, "image/png");
    assertEquals(png.contentEncoding, "base64");
    const decoded = Uint8Array.fromBase64(png.content!);
    assertEquals(decoded, PNG);
    assertEquals(png.size, PNG.length);
    assertEquals(await sha256Hex(decoded), png.checksum);

    const note = await getData(repoDir, dataRepo, definitionRepo, "hello");
    assertEquals(note.contentType, "text/plain");
    assertEquals(note.contentEncoding, "utf-8");
    assertEquals(note.content, TEXT);
    assertEquals(
      await sha256Hex(new TextEncoder().encode(note.content!)),
      note.checksum,
    );
  });
});
