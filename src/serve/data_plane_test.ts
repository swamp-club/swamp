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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { z } from "zod";
import { DataPlane } from "./data_plane.ts";
import { type ActiveDispatch, DispatchRegistry } from "./dispatch_registry.ts";
import { BundleRegistry } from "./bundle_registry.ts";
import { ModelType } from "../domain/models/model_type.ts";
import type { ModelDefinition } from "../domain/models/model.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import type { UnifiedDataRepository } from "../domain/data/repositories.ts";
import type { Data } from "../domain/data/data.ts";
import { generateDataId } from "../domain/data/data_id.ts";
import { SOLO_NAMESPACE } from "../domain/data/namespace.ts";

const MODEL_TYPE = ModelType.create("swamp/data-plane-test");

interface StoredEntry {
  content: Uint8Array;
  data: Record<string, unknown>;
  version: number;
}

function createInMemoryRepo(tempDir: string): {
  repo: UnifiedDataRepository;
  stored: Map<string, StoredEntry>;
} {
  const stored = new Map<string, StoredEntry>();
  const pending = new Map<string, { key: string; path: string }>();
  const versionCounters = new Map<string, number>();

  const keyOf = (type: unknown, modelId: string, name: string) =>
    `${String(type)}/${modelId}/${name}`;
  const nextVersion = (key: string) => {
    const v = (versionCounters.get(key) ?? 0) + 1;
    versionCounters.set(key, v);
    return v;
  };

  const repo = {
    namespace: SOLO_NAMESPACE,
    findAllGlobal: () => Promise.resolve([]),
    findByName: (
      type: unknown,
      modelId: string,
      dataName: string,
      _version?: number,
    ) => {
      const entry = stored.get(keyOf(type, modelId, dataName));
      if (!entry) return Promise.resolve(null);
      return Promise.resolve(
        {
          id: entry.data.id,
          name: dataName,
          version: entry.version,
          contentType: "application/octet-stream",
          size: entry.content.length,
          checksum: "test",
        } as unknown as Data,
      );
    },
    findById: () => Promise.resolve(null),
    listVersions: () => Promise.resolve([1]),
    findAllForModel: () => Promise.resolve([]),
    save: (type: unknown, modelId: string, data: Data, content: Uint8Array) => {
      const key = keyOf(type, modelId, data.name);
      const version = nextVersion(key);
      stored.set(key, {
        content,
        data: { id: data.id, name: data.name },
        version,
      });
      return Promise.resolve({ version });
    },
    append: () => Promise.resolve(),
    stream: async function* (
      type: unknown,
      modelId: string,
      dataName: string,
    ) {
      const entry = stored.get(keyOf(type, modelId, dataName));
      if (entry) yield entry.content;
    },
    getContent: () => Promise.resolve(null),
    delete: () => Promise.resolve(),
    removeLatestMarker: () => Promise.resolve(),
    nextId: () => generateDataId(),
    getPath: () => "",
    getContentPath: () => "",
    collectGarbage: () =>
      Promise.resolve({ versionsRemoved: 0, bytesReclaimed: 0 }),
    allocateVersion: async (type: unknown, modelId: string, data: Data) => {
      const key = keyOf(type, modelId, data.name);
      const version = nextVersion(key);
      const path = join(tempDir, `${crypto.randomUUID()}.part`);
      await Deno.writeFile(path, new Uint8Array());
      pending.set(`${key}@${version}`, { key, path });
      return { version, contentPath: path };
    },
    finalizeVersion: async (
      type: unknown,
      modelId: string,
      data: Data,
      version: number,
    ) => {
      const key = keyOf(type, modelId, data.name);
      const entry = pending.get(`${key}@${version}`)!;
      const content = await Deno.readFile(entry.path);
      stored.set(key, {
        content,
        data: { id: data.id, name: data.name },
        version,
      });
      return { size: content.length, checksum: "test" };
    },
    getLatestVersionSync: () => null,
    findByNameSync: () => null,
    listVersionsSync: () => [],
    getContentSync: () => null,
    findAllForModelSync: () => [],
    findAllGlobalSync: () => [],
    rename: () => {
      throw new Error("not implemented");
    },
  } as unknown as UnifiedDataRepository;

  return { repo, stored };
}

const modelDef: ModelDefinition = {
  type: MODEL_TYPE,
  version: "2026.06.09.1",
  resources: {
    "result": {
      description: "test resource",
      schema: z.object({ value: z.string() }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  files: {
    "log": {
      description: "test log",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      streaming: true,
    },
  },
  methods: {},
};

function activeDispatch(workerName = "w1"): ActiveDispatch {
  return {
    workerName,
    dispatchId: "d-1",
    leaseId: "l-1",
    modelDef,
    modelType: MODEL_TYPE,
    modelId: "m-1",
    methodName: "run",
    definitionName: "test-def",
    definitionTags: {},
  };
}

interface Harness {
  plane: DataPlane;
  stored: Map<string, StoredEntry>;
  dispatches: DispatchRegistry;
  bundles: BundleRegistry;
  firstWrites: string[];
  tempDir: string;
}

async function withHarness(
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir({ prefix: "swamp-data-plane-test" });
  try {
    const { repo, stored } = createInMemoryRepo(tempDir);
    const dispatches = new DispatchRegistry();
    const bundles = new BundleRegistry();
    const firstWrites: string[] = [];
    const plane = new DataPlane({
      repoDir: tempDir,
      repoContext: { unifiedDataRepo: repo } as unknown as RepositoryContext,
      sessions: { verify: (c) => (c === "good-credential" ? "w1" : null) },
      dispatches,
      bundles,
      onFirstWrite: (d) => {
        firstWrites.push(d.dispatchId);
        return Promise.resolve();
      },
      // The writer only touches the vault for sensitive-field specs, which
      // these tests do not declare — an empty stub satisfies the wiring.
      createVaultService: () =>
        Promise.resolve(
          {} as unknown as import("../domain/vaults/vault_service.ts").VaultService,
        ),
    });
    await fn({ plane, stored, dispatches, bundles, firstWrites, tempDir });
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
}

function request(
  path: string,
  init?: RequestInit & { credential?: string | null },
): Request {
  const headers = new Headers(init?.headers);
  const credential = init?.credential === undefined
    ? "good-credential"
    : init.credential;
  if (credential !== null) {
    headers.set("authorization", `Bearer ${credential}`);
  }
  return new Request(`http://dataplane${path}`, { ...init, headers });
}

Deno.test("DataPlane: unrelated routes fall through as null", async () => {
  await withHarness(async (h) => {
    assertEquals(await h.plane.handle(request("/health")), null);
    assertEquals(await h.plane.handle(request("/")), null);
  });
});

Deno.test("DataPlane: requests without a valid credential are rejected", async () => {
  await withHarness(async (h) => {
    const noAuth = await h.plane.handle(
      request("/data/x/y/z/1", { credential: null }),
    );
    assertEquals(noAuth?.status, 401);
    const badAuth = await h.plane.handle(
      request("/data/x/y/z/1", { credential: "wrong" }),
    );
    assertEquals(badAuth?.status, 401);
  });
});

Deno.test("DataPlane: artifact read round-trips with a strong ETag", async () => {
  await withHarness(async (h) => {
    const content = new TextEncoder().encode("artifact-bytes");
    h.stored.set(`${MODEL_TYPE.normalized}/m-1/out-main`, {
      content,
      data: { id: "data-1", name: "out-main" },
      version: 3,
    });

    const path = `/data/${
      encodeURIComponent(MODEL_TYPE.normalized)
    }/m-1/out-main/3`;
    const response = await h.plane.handle(request(path));
    assertEquals(response?.status, 200);
    assertEquals(await response?.text(), "artifact-bytes");
    const etag = response?.headers.get("etag");
    assertEquals(etag, '"data-1-v3"');

    const cached = await h.plane.handle(
      request(path, { headers: { "if-none-match": etag! } }),
    );
    assertEquals(cached?.status, 304);
  });
});

Deno.test("DataPlane: reading a missing artifact is a 404", async () => {
  await withHarness(async (h) => {
    const response = await h.plane.handle(
      request(`/data/${encodeURIComponent(MODEL_TYPE.normalized)}/m-1/nope/1`),
    );
    assertEquals(response?.status, 404);
  });
});

Deno.test("DataPlane: writes without an active dispatch are refused", async () => {
  await withHarness(async (h) => {
    const response = await h.plane.handle(
      request("/data/resource", {
        method: "POST",
        body: JSON.stringify({
          specName: "result",
          name: "result",
          data: { value: "x" },
        }),
      }),
    );
    assertEquals(response?.status, 400);
    assertStringIncludes(await response!.text(), "lease-scoped");
  });
});

Deno.test("DataPlane: resource writes flow through declared-spec enforcement", async () => {
  await withHarness(async (h) => {
    h.dispatches.register(activeDispatch());

    const ok = await h.plane.handle(
      request("/data/resource", {
        method: "POST",
        body: JSON.stringify({
          specName: "result",
          name: "result",
          data: { value: "x" },
        }),
      }),
    );
    assertEquals(ok?.status, 200);
    const handle = await ok!.json();
    assertEquals(handle.specName, "result");
    assertEquals(handle.version, 1);
    assertEquals(h.firstWrites, ["d-1"]);

    const undeclared = await h.plane.handle(
      request("/data/resource", {
        method: "POST",
        body: JSON.stringify({
          specName: "sneaky",
          name: "x",
          data: {},
        }),
      }),
    );
    assertEquals(undeclared?.status, 400);
    assertStringIncludes(
      await undeclared!.text(),
      "Undeclared resource spec",
    );
    // onFirstWrite fires once per dispatch, not per write.
    assertEquals(h.firstWrites, ["d-1"]);
  });
});

Deno.test("DataPlane: file writer session — open, durable lines, finalize", async () => {
  await withHarness(async (h) => {
    h.dispatches.register(activeDispatch());

    const open = await h.plane.handle(
      request("/data/writers", {
        method: "POST",
        body: JSON.stringify({ specName: "log", name: "log" }),
      }),
    );
    assertEquals(open?.status, 200);
    const { writerId } = await open!.json();
    assertEquals(h.plane.openWriterCount, 1);

    const lineOne = await h.plane.handle(
      request(`/data/writers/${writerId}/line`, {
        method: "POST",
        body: "first line",
      }),
    );
    assertEquals(lineOne?.status, 200);
    assertEquals(h.firstWrites, ["d-1"]);

    const lineTwo = await h.plane.handle(
      request(`/data/writers/${writerId}/line`, {
        method: "POST",
        body: "second line",
      }),
    );
    assertEquals(lineTwo?.status, 200);

    const finalize = await h.plane.handle(
      request(`/data/writers/${writerId}/finalize`, { method: "POST" }),
    );
    assertEquals(finalize?.status, 200);
    const handle = await finalize!.json();
    assertEquals(handle.kind, "file");
    assertEquals(h.plane.openWriterCount, 0);

    const key = `${MODEL_TYPE.normalized}/m-1/${handle.name}`;
    const storedText = new TextDecoder().decode(h.stored.get(key)!.content);
    assertEquals(storedText, "first line\nsecond line\n");
  });
});

Deno.test("DataPlane: file writer content streams the body and finalizes", async () => {
  await withHarness(async (h) => {
    h.dispatches.register(activeDispatch());

    const open = await h.plane.handle(
      request("/data/writers", {
        method: "POST",
        body: JSON.stringify({ specName: "log", name: "log" }),
      }),
    );
    const { writerId } = await open!.json();

    const content = await h.plane.handle(
      request(`/data/writers/${writerId}/content`, {
        method: "POST",
        body: "streamed payload",
      }),
    );
    assertEquals(content?.status, 200);
    const handle = await content!.json();
    assertEquals(handle.size > 0, true);
    assertEquals(h.plane.openWriterCount, 0);
  });
});

Deno.test("DataPlane: writer sessions are scoped to their dispatch and worker", async () => {
  await withHarness(async (h) => {
    h.dispatches.register(activeDispatch());
    const open = await h.plane.handle(
      request("/data/writers", {
        method: "POST",
        body: JSON.stringify({ specName: "log", name: "log" }),
      }),
    );
    const { writerId } = await open!.json();

    // Dispatch ends: sessions are released, late writes are refused.
    h.plane.releaseDispatch("d-1");
    assertEquals(h.plane.openWriterCount, 0);
    const late = await h.plane.handle(
      request(`/data/writers/${writerId}/line`, {
        method: "POST",
        body: "too late",
      }),
    );
    assertEquals(late?.status, 404);
  });
});

Deno.test("DataPlane: bundles serve by fingerprint with immutable caching", async () => {
  await withHarness(async (h) => {
    h.bundles.register("fp-abc", { js: "export const x = 1;" });
    const response = await h.plane.handle(request("/bundle/fp-abc"));
    assertEquals(response?.status, 200);
    assertEquals(await response?.text(), "export const x = 1;");
    assertEquals(
      response?.headers.get("cache-control"),
      "immutable, max-age=31536000",
    );

    const missing = await h.plane.handle(request("/bundle/fp-unknown"));
    assertEquals(missing?.status, 404);
  });
});

Deno.test("DataPlane: co-located assets serve from the bundle root only", async () => {
  await withHarness(async (h) => {
    const assetsRoot = join(h.tempDir, "assets");
    await Deno.mkdir(join(assetsRoot, "templates"), { recursive: true });
    await Deno.writeTextFile(
      join(assetsRoot, "templates", "report.html"),
      "<html>",
    );
    h.bundles.register("fp-with-files", {
      js: "export {};",
      filesRoot: assetsRoot,
    });

    const asset = await h.plane.handle(
      request("/bundle/fp-with-files/file/templates/report.html"),
    );
    assertEquals(asset?.status, 200);
    assertEquals(await asset?.text(), "<html>");

    const traversal = await h.plane.handle(
      request("/bundle/fp-with-files/file/..%2F..%2Fetc%2Fpasswd"),
    );
    assertEquals(traversal?.status, 400);

    const missing = await h.plane.handle(
      request("/bundle/fp-with-files/file/templates/nope.html"),
    );
    assertEquals(missing?.status, 404);
  });
});

Deno.test("DataPlane: DELETE /data/resource deletes resource and returns 204", async () => {
  await withHarness(async (h) => {
    h.dispatches.register(activeDispatch());

    const resp = await h.plane.handle(
      request("/data/resource", {
        method: "DELETE",
        body: JSON.stringify({ name: "stale-data" }),
        headers: { "content-type": "application/json" },
      }),
    );
    assertEquals(resp?.status, 204);
  });
});

Deno.test("DataPlane: DELETE /data/resource rejects missing name", async () => {
  await withHarness(async (h) => {
    h.dispatches.register(activeDispatch());

    const resp = await h.plane.handle(
      request("/data/resource", {
        method: "DELETE",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      }),
    );
    assertEquals(resp?.status, 400);
  });
});

Deno.test("DataPlane: DELETE /data/resource requires active dispatch", async () => {
  await withHarness(async (h) => {
    const resp = await h.plane.handle(
      request("/data/resource", {
        method: "DELETE",
        body: JSON.stringify({ name: "data" }),
        headers: { "content-type": "application/json" },
      }),
    );
    assertEquals(resp?.status, 400);
  });
});
