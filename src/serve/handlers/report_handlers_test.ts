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
import { handleReportGet, handleReportSearch } from "./report_handlers.ts";
import type { ConnectionContext } from "./shared.ts";
import { Data } from "../../domain/data/data.ts";
import { Definition } from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { DataQueryService } from "../../domain/data/data_query_service.ts";
import { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";

const TYPE = ModelType.create("command/shell");

function createMockSocket(): WebSocket & { sent: string[] } {
  const sent: string[] = [];
  return {
    readyState: WebSocket.OPEN,
    send(data: string) {
      sent.push(data);
    },
    sent,
    close() {},
  } as unknown as WebSocket & { sent: string[] };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

interface ReportFixture {
  ctx: ConnectionContext;
  /** Data names whose metadata the handler read. */
  reads: string[];
  close(): void;
}

/**
 * A serve connection context over a temp repo holding one model ("alpha")
 * with one stored report beside ten non-report data items. The data
 * repository the handlers see refuses to walk, so a handler that walks fails.
 */
async function createReportFixture(dir: string): Promise<ReportFixture> {
  const definitionRepo = new YamlDefinitionRepository(dir);
  const definition = Definition.create({ name: "alpha", globalArguments: {} });
  await definitionRepo.save(TYPE, definition);

  const catalog = new CatalogStore(":memory:");
  const dataRepo = new FileSystemUnifiedDataRepository(dir, undefined, catalog);
  const save = (name: string, tags: Record<string, string>, type: string) =>
    dataRepo.save(
      TYPE,
      definition.id,
      Data.create({
        name,
        contentType: type,
        lifetime: "infinite",
        garbageCollection: 5,
        tags: { ...tags, modelName: "alpha" },
        ownerDefinition: {
          ownerType: "model-method",
          ownerRef: "command/shell:execute",
        },
      }),
      new TextEncoder().encode("# Summary\n"),
    );
  await save(
    "report-summary",
    { type: "report", reportName: "@test/summary", reportScope: "method" },
    "text/markdown",
  );
  for (let i = 0; i < 10; i++) {
    await save(`result-${i}`, { type: "resource" }, "application/json");
  }

  const reads: string[] = [];
  const refuse = () => {
    throw new Error("report reads must not walk every data item");
  };
  const unifiedDataRepo = {
    namespace: dataRepo.namespace,
    findByName: (
      type: ModelType,
      modelId: string,
      dataName: string,
      version?: number,
    ) => {
      reads.push(dataName);
      return dataRepo.findByName(type, modelId, dataName, version);
    },
    getContent: (
      type: ModelType,
      modelId: string,
      dataName: string,
      version?: number,
    ) => dataRepo.getContent(type, modelId, dataName, version),
    findAllGlobal: refuse,
    findAllForModel: refuse,
  };

  const ctx = {
    repoDir: dir,
    repoContext: {
      definitionRepo,
      unifiedDataRepo,
      catalogStore: catalog,
      dataQueryService: new DataQueryService(catalog, dataRepo),
      workflowRepo: {
        findByName: () => Promise.resolve(null),
        findAll: () => Promise.resolve([]),
      },
    } as unknown as ConnectionContext["repoContext"],
    authConfig: {
      mode: "none" as const,
      admins: [],
      allowedCollectives: [],
      allowedUsers: [],
      oauthProvider: "",
      groupsField: "collectives",
      restrictedModelTypes: [],
      restrictedCommands: [],
      approveRequiresExplicitGrant: false,
    },
  } as unknown as ConnectionContext;

  return { ctx, reads, close: () => catalog.close() };
}

Deno.test("handleReportSearch: answers from the catalog, reading only report metadata (swamp-club#4075)", async () => {
  await withTempDir(async (dir) => {
    const { ctx, reads, close } = await createReportFixture(dir);
    try {
      const socket = createMockSocket();

      await handleReportSearch(
        socket,
        ctx,
        "req-search",
        new AbortController(),
        null,
        {},
      );

      const reply = JSON.parse(socket.sent[0]);
      assertEquals(reply.type, "report.search");
      assertEquals(
        reply.payload.data.reports.map((
          r: { dataName: string; modelName: string },
        ) => [r.modelName, r.dataName]),
        [["alpha", "report-summary"]],
      );
      assertEquals(reads, ["report-summary"]);
    } finally {
      close();
    }
  });
});

Deno.test("handleReportGet: finds the report from the catalog without walking data (swamp-club#4075)", async () => {
  await withTempDir(async (dir) => {
    const { ctx, reads, close } = await createReportFixture(dir);
    try {
      const socket = createMockSocket();

      await handleReportGet(
        socket,
        ctx,
        "req-get",
        { reportName: "@test/summary", model: "alpha" },
        new AbortController(),
        null,
      );

      const reply = JSON.parse(socket.sent[0]);
      assertEquals(reply.type, "report.get");
      assertEquals(reply.payload.data.markdown, "# Summary\n");
      assertEquals(reads.includes("report-summary"), true);
      assertEquals(reads.some((name) => name.startsWith("result-")), false);
    } finally {
      close();
    }
  });
});

Deno.test("handleReportSearch: a cancelled request reads nothing and replies cancelled", async () => {
  await withTempDir(async (dir) => {
    const { ctx, reads, close } = await createReportFixture(dir);
    try {
      const socket = createMockSocket();
      const controller = new AbortController();
      controller.abort();

      await handleReportSearch(socket, ctx, "req-cancel", controller, null, {});

      const reply = JSON.parse(socket.sent[0]);
      assertEquals(reply.type, "error");
      assertEquals(reply.error.code, "cancelled");
      assertEquals(reads, []);
    } finally {
      close();
    }
  });
});

Deno.test("handleReportGet: a cancelled request reads nothing and replies cancelled", async () => {
  await withTempDir(async (dir) => {
    const { ctx, reads, close } = await createReportFixture(dir);
    try {
      const socket = createMockSocket();
      const controller = new AbortController();
      controller.abort();

      await handleReportGet(
        socket,
        ctx,
        "req-get-cancel",
        { reportName: "@test/summary", model: "alpha" },
        controller,
        null,
      );

      const reply = JSON.parse(socket.sent[0]);
      assertEquals(reply.type, "error");
      assertEquals(reply.error.code, "cancelled");
      assertEquals(reads, []);
    } finally {
      close();
    }
  });
});
