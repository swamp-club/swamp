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
 * The v3 read model against v2 (swamp-club#3239). A v2 repository saves,
 * deletes, renames, expires and garbage-collects data; each step's change to
 * its files becomes one v3 commit, appended straight to `commits.db`. A read
 * model in a second repository then catches up, and its files and v3
 * catalog must equal what v2 wrote.
 *
 * The commits follow the save mapping in "v3 domain model"
 * (`design/enablers/datastores.md`): a save puts the raw content, its
 * `metadata.yaml` and the latest marker, and records a `data-version`; a
 * versioned delete or gc tombstones each file of the version; a rename is
 * one `data.rename` commit. The real repository-to-op mapping belongs to the
 * commit-log unit-of-work issue; this test's mapping is derived from v2's own
 * file changes so it cannot drift from what v2 does.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { Data } from "../src/domain/data/data.ts";
import {
  restoreNamespace,
  SOLO_NAMESPACE,
} from "../src/domain/data/namespace.ts";
import {
  createIntent,
  type Intent,
  modelRef,
} from "../src/domain/datastore_v3/intent.ts";
import {
  dataVersionOp,
  MAX_INLINE_BYTES,
  type Op,
  putOp,
  tombstoneOp,
} from "../src/domain/datastore_v3/op.ts";
import { partitionOf } from "../src/domain/datastore_v3/partition_key.ts";
import { RecordKey } from "../src/domain/datastore_v3/record_key.ts";
import {
  MODEL_ID,
  MODEL_TYPE,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import {
  base64Of,
  catalogV3Path,
  commitOf,
  readCatalog,
  readTree,
  type V3Env,
  withV3Env,
} from "./datastore_v3_read_model_helpers.ts";

const PARTITION = partitionOf({
  kind: "model",
  type: MODEL_TYPE,
  id: MODEL_ID,
});
const MODEL_PREFIX = `data/${MODEL_TYPE.normalized}/${MODEL_ID}/`;

/** The v2 operation a commit stands for, which decides its intents. */
type Action =
  | { kind: "save" }
  | { kind: "delete" | "gc" | "expire" }
  | { kind: "rename"; from: string; to: string };

/** A v2 repository in its own temp repo, and the v3 commits it stands for. */
class V2Oracle {
  readonly repo: FileSystemUnifiedDataRepository;
  readonly catalogPath: string;
  readonly root: string;
  #seq = 0;

  constructor(
    readonly env: V3Env,
    readonly namespace: string,
    readonly repoDir: string,
  ) {
    this.root = namespace === ""
      ? swampPath(repoDir)
      : swampPath(repoDir, namespace);
    this.catalogPath = join(repoDir, "_catalog.db");
    this.repo = new FileSystemUnifiedDataRepository(
      repoDir,
      join(this.root, "data"),
      new CatalogStore(this.catalogPath),
      undefined,
      undefined,
      namespace === "" ? SOLO_NAMESPACE : restoreNamespace(namespace),
    );
  }

  /** Runs a v2 step and appends the commit for the files it changed. */
  async step(action: Action, run: () => Promise<unknown>): Promise<void> {
    const before = await readFiles(this.root);
    await run();
    const after = await readFiles(this.root);
    const tombstones: Op[] = [];
    const puts: Op[] = [];
    const versions: Op[] = [];
    for (const path of before.keys()) {
      if (after.has(path)) continue;
      const { name, version } = parsePath(path);
      const kind = action.kind === "gc" || action.kind === "expire"
        ? "data.gc"
        : "data.delete";
      tombstones.push(tombstoneOp({
        intent: intent(
          version === undefined ? { kind, name } : { kind, name, version },
        ),
        key: RecordKey.create(path),
      }));
    }
    for (const [path, bytes] of after) {
      const old = before.get(path);
      if (old !== undefined && equalBytes(old, bytes)) continue;
      const { name, version } = parsePath(path);
      puts.push(
        await putOp({
          intent: this.#putIntent(action, name, version, bytes),
          key: RecordKey.create(path),
          ...(bytes.length <= MAX_INLINE_BYTES ? { inline: base64Of(bytes) } : {
            blob: await this.env.chunkStore.write(
              this.namespace === ""
                ? SOLO_NAMESPACE
                : restoreNamespace(this.namespace),
              bytes,
              AbortSignal.timeout(10_000),
            ),
          }),
        }),
      );
      if (old === undefined && path.endsWith("/metadata.yaml")) {
        versions.push(dataVersionOp({
          key: RecordKey.create(path),
          metadata: parseYaml(new TextDecoder().decode(bytes)),
        }));
      }
    }
    await this.env.store.append(commitOf({
      seq: ++this.#seq,
      partition: PARTITION,
      namespace: this.namespace,
      ops: [...tombstones, ...puts, ...versions],
    }));
  }

  #putIntent(
    action: Action,
    name: string,
    version: number | undefined,
    bytes: Uint8Array,
  ): Intent {
    switch (action.kind) {
      case "save":
        return intent({
          kind: "data.save",
          name,
          // The latest marker holds the version it points at.
          version: version ?? Number(new TextDecoder().decode(bytes)),
        });
      case "rename":
        return intent({
          kind: "data.rename",
          name: action.from,
          to: action.to,
        });
      default:
        return intent({
          kind: action.kind === "delete" ? "data.delete" : "data.gc",
          name,
        });
    }
  }
}

function intent(fields: Record<string, unknown>): Intent {
  return createIntent({ ...fields, model: modelRef(MODEL_TYPE, MODEL_ID) });
}

/** Splits `data/<type>/<model>/<name>/<version>/<file>` or `.../<name>/latest`. */
function parsePath(path: string): { name: string; version?: number } {
  if (!path.startsWith(MODEL_PREFIX)) {
    throw new Error(`Unexpected path ${path}`);
  }
  const [name, second] = path.slice(MODEL_PREFIX.length).split("/");
  return second === "latest" ? { name } : { name, version: Number(second) };
}

async function readFiles(root: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const path of (await readTree(root)).keys()) {
    files.set(path, await Deno.readFile(join(root, ...path.split("/"))));
  }
  return files;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function data(name: string, garbageCollection = 10): Data {
  return Data.create({
    name,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection,
    tags: { type: "resource", modelName: "vpc", specName: "main" },
    ownerDefinition: { ownerType: "manual", ownerRef: "test" },
  });
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** Content above the inline limit, so it is stored as several chunks. */
function large(seed: string): Uint8Array {
  const bytes = new Uint8Array(20 * 1024);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = (seed.charCodeAt(i % seed.length) + i) % 256;
  }
  return bytes;
}

async function assertMatchesV2(env: V3Env, oracle: V2Oracle): Promise<void> {
  const readModel = env.openReadModel();
  try {
    await readModel.catchUp(AbortSignal.timeout(30_000));
  } finally {
    await readModel.close();
  }
  assertEquals(
    await readTree(env.cacheRoot(oracle.namespace)),
    await readTree(oracle.root),
  );
  assertEquals(
    readCatalog(catalogV3Path(env)),
    readCatalog(oracle.catalogPath),
  );
}

for (const namespace of ["", "infra"]) {
  const label = namespace === "" ? "an unnamespaced" : "a namespaced";
  Deno.test(`read model: matches v2's files and catalog for ${label} datastore`, async () => {
    await withV3Env(async (env) => {
      const oracle = new V2Oracle(env, namespace, join(env.dir, "v2"));
      const { repo } = oracle;
      const type = MODEL_TYPE;
      const save = (name: string, content: Uint8Array, gc?: number) =>
        oracle.step(
          { kind: "save" },
          () => repo.save(type, MODEL_ID, data(name, gc), content),
        );

      await save("a", text("a1"));
      await save("a", text("a2"));
      await save("a", large("a3"));
      await save("b", text("b1"));
      await save("c", text("c1"), 1);
      await save("c", text("c2"), 1);
      await save("c", text("c3"), 1);
      await save("d", text("d1"));
      await assertMatchesV2(env, oracle);

      // A versioned delete below the top.
      await oracle.step(
        { kind: "delete" },
        () => repo.delete(type, MODEL_ID, "a", 1),
      );
      await assertMatchesV2(env, oracle);

      // A rename, a save to the renamed name, and deletes that expose the
      // rename marker and then the version before the rename.
      await oracle.step(
        { kind: "rename", from: "b", to: "e" },
        () => repo.rename(type, MODEL_ID, "b", "e"),
      );
      await assertMatchesV2(env, oracle);
      await save("b", text("b3"));
      await oracle.step(
        { kind: "delete" },
        () => repo.delete(type, MODEL_ID, "b", 3),
      );
      await assertMatchesV2(env, oracle);
      await oracle.step(
        { kind: "delete" },
        () => repo.delete(type, MODEL_ID, "b", 2),
      );
      await assertMatchesV2(env, oracle);

      // Garbage collection keeps one version of c.
      await oracle.step(
        { kind: "gc" },
        () => repo.collectGarbage(type, MODEL_ID),
      );
      await assertMatchesV2(env, oracle);

      // A whole-name delete, then expiry.
      await oracle.step(
        { kind: "delete" },
        () => repo.delete(type, MODEL_ID, "d"),
      );
      await assertMatchesV2(env, oracle);
      await oracle.step(
        { kind: "expire" },
        () => repo.removeLatestMarker(type, MODEL_ID, "e"),
      );
      await assertMatchesV2(env, oracle);
    });
  });
}
