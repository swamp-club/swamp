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

import { assertEquals } from "@std/assert";
import type { DefinitionId } from "../../domain/definitions/definition.ts";
import { ModelOutput } from "../../domain/models/model_output.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  createModelOutputDataDeps,
  modelOutputData,
  type ModelOutputDataDeps,
  type ModelOutputDataEvent,
} from "./output_data.ts";
import { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { catalogDbPath } from "../../infrastructure/persistence/repository_factory.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native sqlite handles
      // yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function catalogDbExists(repoDir: string): Promise<boolean> {
  try {
    await Deno.lstat(catalogDbPath(repoDir));
    return true;
  } catch {
    return false;
  }
}

Deno.test(
  "createModelOutputDataDeps: reuses an injected data repo and opens no new catalog db",
  async () => {
    await withTempDir(async (dir) => {
      const injected = new FileSystemUnifiedDataRepository(
        dir,
        undefined,
        new CatalogStore(":memory:"),
      );
      createModelOutputDataDeps(dir, undefined, injected);
      assertEquals(await catalogDbExists(dir), false);
    });
  },
);

Deno.test(
  "createModelOutputDataDeps: opens a file-based catalog db when no repo is injected",
  async () => {
    await withTempDir(async (dir) => {
      createModelOutputDataDeps(dir);
      assertEquals(await catalogDbExists(dir), true);
    });
  },
);

function makeOutput(
  opts?: { withDataArtifact?: boolean },
): ModelOutput {
  const output = ModelOutput.create({
    definitionId: "00000000-0000-4000-8000-000000000001" as DefinitionId,
    methodName: "start",
    provenance: {
      definitionHash: "abc",
      modelVersion: "1",
      triggeredBy: "manual",
    },
  });
  output.markRunning();
  output.markSucceeded();
  if (opts?.withDataArtifact !== false) {
    output.addDataArtifact({
      dataId: crypto.randomUUID(),
      name: "output",
      version: 1,
      tags: { type: "data" },
    });
  }
  return output;
}

function makeDeps(
  overrides?: Partial<ModelOutputDataDeps>,
): ModelOutputDataDeps {
  const output = makeOutput();
  const modelType = ModelType.create("aws/ec2");
  return {
    isPartialId: () => true,
    matchOutputByPartialId: () =>
      Promise.resolve({
        status: "found" as const,
        match: { output, type: modelType },
      }),
    findDefinition: () =>
      Promise.resolve({
        id: "00000000-0000-4000-8000-000000000001",
        name: "my-model",
      }),
    findDataByName: () =>
      Promise.resolve({
        id: "data-1",
        name: "output",
        version: 1,
        contentType: "application/json",
      }),
    getContent: () =>
      Promise.resolve(
        new TextEncoder().encode(JSON.stringify({ key: "value" })),
      ),
    ...overrides,
  };
}

Deno.test("modelOutputData yields completed with data", async () => {
  const deps = makeDeps();
  const events = await collect<ModelOutputDataEvent>(
    modelOutputData(createLibSwampContext(), deps, {
      outputIdArg: "out-123",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<
    ModelOutputDataEvent,
    { kind: "completed" }
  >;
  assertEquals(typeof completed.data.outputId, "string");
  assertEquals(completed.data.data, { key: "value" });
  assertEquals(completed.data.field, null);
});

Deno.test("modelOutputData extracts field from JSON", async () => {
  const deps = makeDeps();
  const events = await collect<ModelOutputDataEvent>(
    modelOutputData(createLibSwampContext(), deps, {
      outputIdArg: "out-123",
      field: "key",
    }),
  );

  const completed = events[1] as Extract<
    ModelOutputDataEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.data, "value");
  assertEquals(completed.data.field, "key");
});

Deno.test("modelOutputData yields error for missing field", async () => {
  const deps = makeDeps();
  const events = await collect<ModelOutputDataEvent>(
    modelOutputData(createLibSwampContext(), deps, {
      outputIdArg: "out-123",
      field: "nonexistent",
    }),
  );

  assertEquals(events[1].kind, "error");
});

Deno.test("modelOutputData yields error when no data artifacts", async () => {
  const outputNoData = makeOutput({ withDataArtifact: false });
  const modelType = ModelType.create("aws/ec2");
  const deps = makeDeps({
    matchOutputByPartialId: () =>
      Promise.resolve({
        status: "found" as const,
        match: { output: outputNoData, type: modelType },
      }),
  });
  const events = await collect<ModelOutputDataEvent>(
    modelOutputData(createLibSwampContext(), deps, {
      outputIdArg: "out-123",
    }),
  );

  assertEquals(events[1].kind, "error");
});

// The 8-byte PNG signature: 0x89 is not valid UTF-8.
const PNG_SIGNATURE = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
]);

function depsWithContent(
  contentType: string,
  bytes: Uint8Array,
): ModelOutputDataDeps {
  return makeDeps({
    findDataByName: () =>
      Promise.resolve({
        id: "data-1",
        name: "output",
        version: 1,
        contentType,
      }),
    getContent: () => Promise.resolve(bytes),
  });
}

async function runOutputData(deps: ModelOutputDataDeps, field?: string) {
  return await collect<ModelOutputDataEvent>(
    modelOutputData(createLibSwampContext(), deps, {
      outputIdArg: "out-123",
      field,
    }),
  );
}

function completedOf(events: ModelOutputDataEvent[]) {
  const completed = events.at(-1) as Extract<
    ModelOutputDataEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  return completed.data;
}

Deno.test("modelOutputData: binary content is base64 and lossless", async () => {
  const data = completedOf(
    await runOutputData(depsWithContent("image/png", PNG_SIGNATURE)),
  );
  assertEquals(data.contentEncoding, "base64");
  assertEquals(Uint8Array.fromBase64(data.data as string), PNG_SIGNATURE);
});

Deno.test("modelOutputData: UTF-8 text content is utf-8 text", async () => {
  const text = "héllo wörld ✓\n";
  const data = completedOf(
    await runOutputData(
      depsWithContent("text/plain", new TextEncoder().encode(text)),
    ),
  );
  assertEquals(data.contentEncoding, "utf-8");
  assertEquals(data.data, text);
});

Deno.test("modelOutputData: parsed JSON has no contentEncoding", async () => {
  const data = completedOf(await runOutputData(makeDeps()));
  assertEquals(data.data, { key: "value" });
  assertEquals("contentEncoding" in data, false);
});

Deno.test("modelOutputData: JSON that fails to parse is returned as utf-8 text", async () => {
  const data = completedOf(
    await runOutputData(
      depsWithContent(
        "application/json",
        new TextEncoder().encode("{not json"),
      ),
    ),
  );
  assertEquals(data.contentEncoding, "utf-8");
  assertEquals(data.data, "{not json");
});

Deno.test("modelOutputData: application/json with invalid UTF-8 is base64, not parsed", async () => {
  // {"a":"<0xff>"} parses after a lenient decode, with U+FFFD in the string.
  const bytes = new Uint8Array([
    ...new TextEncoder().encode('{"a":"'),
    0xff,
    ...new TextEncoder().encode('"}'),
  ]);
  const data = completedOf(
    await runOutputData(depsWithContent("application/json", bytes)),
  );
  assertEquals(data.contentEncoding, "base64");
  assertEquals(Uint8Array.fromBase64(data.data as string), bytes);
});

Deno.test("modelOutputData: --field on binary content fails as not a JSON object", async () => {
  const events = await runOutputData(
    depsWithContent("image/png", PNG_SIGNATURE),
    "key",
  );
  const last = events.at(-1)!;
  assertEquals(last.kind, "error");
  if (last.kind === "error") {
    assertEquals(last.error.message.includes("not a JSON object"), true);
  }
});
