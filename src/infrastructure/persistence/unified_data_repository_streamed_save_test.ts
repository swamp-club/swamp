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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { type DataId, generateDataId } from "../../domain/data/data_id.ts";
import type { OpJSON } from "../../domain/datastore_v3/op.ts";
import { MemoryStorage } from "../../domain/datastore_v3/v3_test_helpers.ts";
import { createFileWriterFactory } from "../../domain/models/data_writer.ts";
import type { DataHandle } from "../../domain/models/model.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import {
  contextHook,
  MemorySink,
  unitOptions,
} from "../datastore_v3/commit_log_test_helpers.ts";
import { createCommitLogUnitOfWork } from "../datastore_v3/commit_log_unit_of_work.ts";
import { CatalogStore } from "./catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "./unified_data_repository.ts";
import { runInUnitOfWork } from "./unit_of_work_scope.ts";

const TYPE = ModelType.create("test/streamed");
const MODEL_ID = crypto.randomUUID();
const MODEL_NAME = "streamed";
const FILES = {
  log: {
    contentType: "text/plain",
    lifetime: "infinite" as const,
    garbageCollection: 10,
  },
};

class CountingRepository extends FileSystemUnifiedDataRepository {
  contentReads = 0;
  failFinalize = false;

  protected override readContentForFinalize(
    ...args: Parameters<FileSystemUnifiedDataRepository["getContentPath"]>
  ): Promise<Uint8Array> {
    this.contentReads++;
    return super.readContentForFinalize(...args);
  }

  override finalizeVersion(
    ...args: Parameters<FileSystemUnifiedDataRepository["finalizeVersion"]>
  ): ReturnType<FileSystemUnifiedDataRepository["finalizeVersion"]> {
    if (this.failFinalize) {
      return Promise.reject(new Error("finalize failed"));
    }
    return super.finalizeVersion(...args);
  }

  override finalizeVersionDeferred(
    ...args: Parameters<
      FileSystemUnifiedDataRepository["finalizeVersionDeferred"]
    >
  ): ReturnType<FileSystemUnifiedDataRepository["finalizeVersionDeferred"]> {
    if (this.failFinalize) {
      return Promise.reject(new Error("finalize failed"));
    }
    return super.finalizeVersionDeferred(...args);
  }
}

interface Checkout {
  readonly repo: CountingRepository;
  readonly catalog: CatalogStore;
}

async function withCheckouts(
  fn: (a: Checkout, b: Checkout) => Promise<void>,
): Promise<void> {
  const dirs: string[] = [];
  const opened: Checkout[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const dir = await Deno.makeTempDir({ prefix: "swamp-streamed-save-" });
      dirs.push(dir);
      const catalog = new CatalogStore(join(dir, "_catalog.db"));
      opened.push({
        catalog,
        repo: new CountingRepository(dir, undefined, catalog),
      });
    }
    await fn(opened[0], opened[1]);
  } finally {
    for (const { catalog } of opened) catalog.close();
    for (const dir of dirs) {
      if (Deno.build.os === "windows") {
        await Deno.remove(dir, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(dir, { recursive: true });
      }
    }
  }
}

function writerOf(
  repo: FileSystemUnifiedDataRepository,
  deferred: boolean,
  id?: DataId,
) {
  if (id !== undefined) repo.nextId = () => id;
  const factory = createFileWriterFactory(
    repo,
    TYPE,
    MODEL_ID,
    FILES,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    MODEL_NAME,
    deferred,
  );
  return { factory, writer: factory.createFileWriter("log", "log") };
}

function streamOf(
  content: Uint8Array,
  sliceBytes: number,
  failAfter?: number,
): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (failAfter !== undefined && at >= failAfter) {
        controller.error(new Error("upstream closed"));
        return;
      }
      if (at >= content.length) {
        controller.close();
        return;
      }
      controller.enqueue(content.slice(at, at + sliceBytes));
      at += sliceBytes;
    },
  });
}

function contentOf(lines: number): Uint8Array {
  return new TextEncoder().encode(
    "line é中😀\n".repeat(lines),
  );
}

/** a version's metadata without the time it was written */
async function metadataOf(
  repo: FileSystemUnifiedDataRepository,
): Promise<Record<string, unknown>> {
  const metadata = parseYaml(
    await Deno.readTextFile(repo.getMetadataPath(TYPE, MODEL_ID, "log", 1)),
  ) as Record<string, unknown>;
  delete metadata.createdAt;
  return metadata;
}

function catalogRowOf(catalog: CatalogStore): Record<string, unknown> {
  const row = catalog.findLatestRow(MODEL_NAME, "log");
  assert(row !== null, "the version has a latest catalog row");
  const { created_at: _createdAt, ...rest } = row;
  return rest;
}

/** the ops staged for the version, without the time it was written */
function stagedOf(ops: readonly OpJSON[]): unknown[] {
  return ops.map((op) => {
    if (op.kind === "data-version") {
      const { createdAt: _createdAt, ...metadata } = op.metadata;
      return { ...op, metadata };
    }
    if (op.kind === "put" && op.key.endsWith("metadata.yaml")) {
      const { inline: _inline, blob: _blob, ...rest } = op;
      return rest;
    }
    return op;
  });
}

async function inV3Unit(fn: () => Promise<void>): Promise<OpJSON[]> {
  const sink = new MemorySink();
  const unit = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, new MemoryStorage()),
  );
  try {
    await runInUnitOfWork(unit, fn);
    await unit.commit();
  } catch (error) {
    await unit.abandon();
    throw error;
  }
  return sink.landed.flatMap((commit) => [...commit.toJSON().ops]);
}

async function assertNoVersionLeft(
  repo: FileSystemUnifiedDataRepository,
  catalog: CatalogStore,
): Promise<void> {
  assertEquals(await repo.listVersions(TYPE, MODEL_ID, "log"), []);
  assertEquals(catalog.findLatestRow(MODEL_NAME, "log"), null);
  assertEquals(
    catalog.pendingRows(repo.namespace, TYPE.normalized, MODEL_ID),
    [],
  );
  const left: string[] = [];
  try {
    for await (
      const entry of Deno.readDir(repo.getDataNameDir(TYPE, MODEL_ID, "log"))
    ) {
      left.push(entry.name);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  assertEquals(left.filter((name) => /^\d+$/.test(name)), []);
  assert(!left.some((name) => name.endsWith(".tmp")), `left: ${left}`);
}

for (const deferred of [false, true]) {
  const mode = deferred ? "deferred" : "immediate";

  Deno.test(`DataWriter.writeStream (${mode}): stores what writeAll stores, with the same checksum, size, metadata, catalog row and staged ops`, async () => {
    await withCheckouts(async (saved, streamed) => {
      const content = contentOf(4096);
      const id = generateDataId();
      let savedHandle: DataHandle | undefined;
      let streamedHandle: DataHandle | undefined;

      const savedOps = await inV3Unit(async () => {
        const { factory, writer } = writerOf(saved.repo, deferred, id);
        savedHandle = await writer.writeAll(content);
        if (deferred) {
          await saved.repo.advanceLatestMarkers(factory.getDeferredReceipts());
        }
      });
      const streamedOps = await inV3Unit(async () => {
        const { factory, writer } = writerOf(streamed.repo, deferred, id);
        streamedHandle = await writer.writeStream(streamOf(content, 1000));
        if (deferred) {
          await streamed.repo.advanceLatestMarkers(
            factory.getDeferredReceipts(),
          );
        }
      });

      assertEquals(streamedHandle, savedHandle);
      assertEquals(
        streamedHandle?.sha256 !== undefined,
        !deferred,
        "the handle carries a checksum where writeAll's does",
      );
      assertEquals(
        await Deno.readFile(
          streamed.repo.getContentPath(TYPE, MODEL_ID, "log", 1),
        ),
        content,
      );
      assertEquals(
        await metadataOf(streamed.repo),
        await metadataOf(saved.repo),
      );
      assertEquals(catalogRowOf(streamed.catalog), catalogRowOf(saved.catalog));
      assert(savedOps.length > 0, "the save staged its version");
      assertEquals(stagedOf(streamedOps), stagedOf(savedOps));
    });
  });

  Deno.test(`DataWriter.writeStream (${mode}): finalize takes the size and checksum counted while writing, never reading the content back`, async () => {
    await withCheckouts(async ({ repo }) => {
      const content = contentOf(512);
      const { writer } = writerOf(repo, deferred);
      const handle = await writer.writeStream(streamOf(content, 333));
      assertEquals(repo.contentReads, 0);
      assertEquals(handle.size, content.length);

      const { writer: byPath } = writerOf(repo, deferred);
      await Deno.writeFile(await byPath.getFilePath(), content);
      await byPath.finalize();
      assertEquals(repo.contentReads, 1, "a path writer's content is read");
    });
  });

  Deno.test(`DataWriter.writeStream (${mode}): an error mid-stream leaves no version, no catalog row and no temp file`, async () => {
    await withCheckouts(async ({ repo, catalog }) => {
      const { factory, writer } = writerOf(repo, deferred);
      await assertRejects(
        () => writer.writeStream(streamOf(contentOf(512), 100, 300)),
        Error,
        "upstream closed",
      );
      await assertNoVersionLeft(repo, catalog);
      assertEquals(factory.getDeferredReceipts(), []);
    });
  });

  Deno.test(`DataWriter.writeStream (${mode}): a failed finalize leaves no version`, async () => {
    await withCheckouts(async ({ repo, catalog }) => {
      repo.failFinalize = true;
      const { factory, writer } = writerOf(repo, deferred);
      await assertRejects(
        () => writer.writeStream(streamOf(contentOf(64), 100)),
        Error,
        "finalize failed",
      );
      await assertNoVersionLeft(repo, catalog);
      assertEquals(factory.getDeferredReceipts(), []);
    });
  });
}
