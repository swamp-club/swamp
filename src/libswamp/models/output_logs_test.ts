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
import type { DefinitionId } from "../../domain/definitions/definition.ts";
import { ModelOutput } from "../../domain/models/model_output.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  createModelOutputLogsDeps,
  modelOutputLogs,
  type ModelOutputLogsDeps,
  type ModelOutputLogsEvent,
} from "./output_logs.ts";
import { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { catalogDbPath } from "../../infrastructure/persistence/repository_factory.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // best-effort: EBUSY can fire when V8 has not GC'd native sqlite handles
      // yet
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
  "createModelOutputLogsDeps: reuses an injected data repo and opens no new catalog db",
  async () => {
    await withTempDir(async (dir) => {
      const injected = new FileSystemUnifiedDataRepository(
        dir,
        undefined,
        new CatalogStore(":memory:"),
      );
      createModelOutputLogsDeps(dir, undefined, injected);
      assertEquals(await catalogDbExists(dir), false);
    });
  },
);

Deno.test(
  "createModelOutputLogsDeps: opens a file-based catalog db when no repo is injected",
  async () => {
    await withTempDir(async (dir) => {
      createModelOutputLogsDeps(dir);
      assertEquals(await catalogDbExists(dir), true);
    });
  },
);

function makeOutput(
  opts?: { withLogArtifact?: boolean },
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
  if (opts?.withLogArtifact !== false) {
    output.addDataArtifact({
      dataId: crypto.randomUUID(),
      name: "run.log",
      version: 1,
      tags: { type: "log" },
    });
  }
  return output;
}

function makeDeps(
  overrides?: Partial<ModelOutputLogsDeps>,
): ModelOutputLogsDeps {
  const output = makeOutput();
  const modelType = ModelType.create("aws/ec2");
  return {
    isPartialId: () => true,
    matchOutputByPartialId: () =>
      Promise.resolve({
        status: "found" as const,
        match: { output, type: modelType },
      }),
    findDataByName: () => Promise.resolve({}),
    getContent: () =>
      Promise.resolve(new TextEncoder().encode("line1\nline2\n")),
    ...overrides,
  };
}

Deno.test("modelOutputLogs yields log lines", async () => {
  const deps = makeDeps();
  const events = await collect<ModelOutputLogsEvent>(
    modelOutputLogs(createLibSwampContext(), deps, {
      outputIdArg: "out-123",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<
    ModelOutputLogsEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.lines, ["line1", "line2"]);
  assertEquals(completed.data.totalLines, 2);
});

Deno.test("modelOutputLogs reads a log with more lines than fit in a spread call", async () => {
  // push(...lines) throws RangeError on a very large log, so lines must not be
  // spread
  const count = 150_000;
  const text = Array.from({ length: count }, (_, i) => `line${i}`).join("\n");
  const deps = makeDeps({
    getContent: () => Promise.resolve(new TextEncoder().encode(text)),
  });
  const events = await collect<ModelOutputLogsEvent>(
    modelOutputLogs(createLibSwampContext(), deps, {
      outputIdArg: "out-123",
      tail: 1,
    }),
  );

  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<
    ModelOutputLogsEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.totalLines, count);
  assertEquals(completed.data.lines, [`line${count - 1}`]);
});

Deno.test("modelOutputLogs applies tail", async () => {
  const deps = makeDeps();
  const events = await collect<ModelOutputLogsEvent>(
    modelOutputLogs(createLibSwampContext(), deps, {
      outputIdArg: "out-123",
      tail: 1,
    }),
  );

  const completed = events[1] as Extract<
    ModelOutputLogsEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.showingLines, 1);
  assertEquals(completed.data.lines, ["line2"]);
});

Deno.test("modelOutputLogs yields error for invalid ID format", async () => {
  const deps = makeDeps({ isPartialId: () => false });
  const events = await collect<ModelOutputLogsEvent>(
    modelOutputLogs(createLibSwampContext(), deps, {
      outputIdArg: "xx",
    }),
  );

  assertEquals(events[1].kind, "error");
});

Deno.test("modelOutputLogs yields error when no log artifacts", async () => {
  const outputNoLog = makeOutput({ withLogArtifact: false });
  const modelType = ModelType.create("aws/ec2");
  const deps = makeDeps({
    matchOutputByPartialId: () =>
      Promise.resolve({
        status: "found" as const,
        match: { output: outputNoLog, type: modelType },
      }),
  });
  const events = await collect<ModelOutputLogsEvent>(
    modelOutputLogs(createLibSwampContext(), deps, {
      outputIdArg: "out-123",
    }),
  );

  assertEquals(events[1].kind, "error");
});

Deno.test("modelOutputLogs acts on a passed reference without looking the id up", async () => {
  const output = makeOutput();
  const deps = makeDeps({
    isPartialId: () => {
      throw new Error("the id must not be parsed again");
    },
    matchOutputByPartialId: () =>
      Promise.reject(new Error("the id must not be looked up again")),
  });
  const events = await collect<ModelOutputLogsEvent>(
    modelOutputLogs(createLibSwampContext(), deps, {
      outputIdArg: "abc",
      reference: {
        kind: "output",
        match: { output, type: ModelType.create("aws/ec2") },
      },
    }),
  );
  const completed = events[1] as Extract<
    ModelOutputLogsEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.outputId, output.id);
});

Deno.test("modelOutputLogs reports a passed ambiguous reference as today", async () => {
  const events = await collect<ModelOutputLogsEvent>(
    modelOutputLogs(createLibSwampContext(), makeDeps(), {
      outputIdArg: "abc",
      reference: { kind: "ambiguous", ids: ["abc1", "abc2"], matches: [] },
    }),
  );
  const error = events[1] as Extract<ModelOutputLogsEvent, { kind: "error" }>;
  assertEquals(
    error.error.message,
    'Ambiguous ID prefix "abc" matches:\n  abc1\n  abc2',
  );
});

function outputWithLogs(
  logs: { name: string; version: number }[],
): ModelOutput {
  const output = makeOutput({ withLogArtifact: false });
  for (const log of logs) {
    output.addDataArtifact({
      dataId: crypto.randomUUID(),
      name: log.name,
      version: log.version,
      tags: { type: "log" },
    });
  }
  return output;
}

async function runWith(
  output: ModelOutput,
  deps: ModelOutputLogsDeps,
): Promise<ModelOutputLogsEvent> {
  const events = await collect<ModelOutputLogsEvent>(
    modelOutputLogs(createLibSwampContext(), deps, {
      outputIdArg: "abc",
      reference: {
        kind: "output",
        match: { output, type: ModelType.create("aws/ec2") },
      },
    }),
  );
  return events[events.length - 1];
}

Deno.test("modelOutputLogs: reads each log at the version its output recorded", async () => {
  const reads: string[] = [];
  const deps = makeDeps({
    findDataByName: (_type, _id, name, version) => {
      reads.push(`find ${name}@${version}`);
      return Promise.resolve({});
    },
    getContent: (_type, _id, name, version) => {
      reads.push(`content ${name}@${version}`);
      return Promise.resolve(new TextEncoder().encode(`${name} v${version}`));
    },
  });
  const event = await runWith(
    outputWithLogs([{ name: "a.log", version: 3 }, {
      name: "b.log",
      version: 7,
    }]),
    deps,
  );

  assertEquals(reads, [
    "find a.log@3",
    "content a.log@3",
    "find b.log@7",
    "content b.log@7",
  ]);
  const completed = event as Extract<
    ModelOutputLogsEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.lines, ["a.log v3", "b.log v7"]);
});

Deno.test("modelOutputLogs: a log version the check finds unavailable fails with its reason and is not read", async () => {
  let contentReads = 0;
  const deps = makeDeps({
    getContent: () => {
      contentReads++;
      return Promise.resolve(new TextEncoder().encode("another writer"));
    },
    checkArtifact: (_type, _id, ref) =>
      Promise.resolve({
        kind: "unavailable" as const,
        reason: `${ref.name}@${ref.version}: content no longer available`,
      }),
  });
  const event = await runWith(
    outputWithLogs([{ name: "run.log", version: 2 }]),
    deps,
  );

  const error = event as Extract<ModelOutputLogsEvent, { kind: "error" }>;
  assertEquals(error.kind, "error");
  assertEquals(error.error.code, "not_found");
  assertStringIncludes(
    error.error.message,
    "run.log@2: content no longer available",
  );
  assertEquals(contentReads, 0);
});

Deno.test("modelOutputLogs: an available check passes the output as producer and reads the version", async () => {
  const output = outputWithLogs([{ name: "run.log", version: 4 }]);
  const producers: unknown[] = [];
  const reads: (number | undefined)[] = [];
  const deps = makeDeps({
    getContent: (_type, _id, _name, version) => {
      reads.push(version);
      return Promise.resolve(new TextEncoder().encode("mine"));
    },
    checkArtifact: (_type, _id, _ref, producer) => {
      producers.push(producer);
      return Promise.resolve({
        kind: "available" as const,
        metadata: {} as never,
      });
    },
  });
  const event = await runWith(output, deps);

  assertEquals(event.kind, "completed");
  assertEquals(reads, [4]);
  assertEquals(producers, [{
    startedAt: output.startedAt,
    completedAt: output.completedAt,
  }]);
});

Deno.test("modelOutputLogs: a log version that no longer exists fails naming it", async () => {
  const deps = makeDeps({ findDataByName: () => Promise.resolve(null) });
  const event = await runWith(
    outputWithLogs([{ name: "run.log", version: 5 }]),
    deps,
  );

  const error = event as Extract<ModelOutputLogsEvent, { kind: "error" }>;
  assertEquals(error.kind, "error");
  assertEquals(error.error.code, "not_found");
  assertStringIncludes(error.error.message, "run.log@5");
});

Deno.test("createModelOutputLogsDeps: a v2 repo takes no artifact check", async () => {
  await withTempDir((dir) => {
    const injected = new FileSystemUnifiedDataRepository(
      dir,
      undefined,
      new CatalogStore(":memory:"),
    );
    const deps = createModelOutputLogsDeps(dir, undefined, injected);
    assertEquals(deps.checkArtifact, undefined);
    return Promise.resolve();
  });
});
