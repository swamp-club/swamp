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
import { fromData, fromRow } from "./data_record_mapper.ts";
import type { CatalogRow } from "../../infrastructure/persistence/catalog_store.ts";
import type { UnifiedDataRepository } from "./repositories.ts";
import { Data } from "./data.ts";
import { ModelType } from "../models/model_type.ts";

const encoder = new TextEncoder();

function createRow(overrides?: Partial<CatalogRow>): CatalogRow {
  return {
    namespace: "",
    type_normalized: "test/model",
    model_id: "model-123",
    data_name: "test-data",
    id: "data-id-1",
    version: 1,
    is_latest: 1,
    model_name: "test-model",
    spec_name: "test-spec",
    data_type: "resource",
    content_type: "application/json",
    lifetime: "infinite",
    owner_type: "model-method",
    streaming: 0,
    size: 100,
    created_at: "2026-01-01T00:00:00.000Z",
    tags: '{"env":"prod"}',
    owner_ref: "ref-1",
    workflow_run_id: "run-1",
    workflow_name: "wf-1",
    job_name: "job-1",
    step_name: "step-1",
    source: "test",
    ...overrides,
  };
}

function stubRepo(
  syncContent?: Uint8Array | null,
  asyncContent?: Uint8Array | null,
): UnifiedDataRepository {
  return {
    namespace: "",
    getContentSync: () => syncContent ?? null,
    getContent: () => Promise.resolve(asyncContent ?? syncContent ?? null),
  } as unknown as UnifiedDataRepository;
}

// ============================================================================
// fromRow — synchronous CatalogRow → DataRecord
// ============================================================================

Deno.test("fromRow: parses JSON attributes when loadAttributes is true", () => {
  const json = { host: "db.example.com", port: 5432 };
  const repo = stubRepo(encoder.encode(JSON.stringify(json)));
  const record = fromRow(createRow(), repo, true, false);

  assertEquals(record.attributes, json);
  assertEquals(record.content, "");
});

Deno.test("fromRow: loads text content when loadContent is true", () => {
  const json = { key: "value" };
  const bytes = encoder.encode(JSON.stringify(json));
  const repo = stubRepo(bytes);
  const record = fromRow(createRow(), repo, false, true);

  assertEquals(record.content, JSON.stringify(json));
  assertEquals(record.attributes, {});
});

Deno.test("fromRow: loads both attributes and content together", () => {
  const json = { key: "value" };
  const bytes = encoder.encode(JSON.stringify(json));
  const repo = stubRepo(bytes);
  const record = fromRow(createRow(), repo, true, true);

  assertEquals(record.attributes, json);
  assertEquals(record.content, JSON.stringify(json));
});

Deno.test("fromRow: skips content loading when both flags are false", () => {
  const repo = stubRepo(encoder.encode("should not load"));
  const record = fromRow(createRow(), repo, false, false);

  assertEquals(record.attributes, {});
  assertEquals(record.content, "");
});

Deno.test("fromRow: handles invalid JSON content gracefully", () => {
  const repo = stubRepo(encoder.encode("not-json{"));
  const record = fromRow(createRow(), repo, true, false);

  assertEquals(record.attributes, {});
});

Deno.test("fromRow: handles invalid tags JSON gracefully", () => {
  const repo = stubRepo(null);
  const record = fromRow(createRow({ tags: "bad-json" }), repo, false, false);

  assertEquals(record.tags, {});
});

Deno.test("fromRow: parses valid tags JSON", () => {
  const repo = stubRepo(null);
  const record = fromRow(
    createRow({ tags: '{"env":"prod","region":"us-east-1"}' }),
    repo,
    false,
    false,
  );

  assertEquals(record.tags, { env: "prod", region: "us-east-1" });
});

Deno.test("fromRow: maps all catalog row fields to DataRecord", () => {
  const repo = stubRepo(null);
  const row = createRow();
  const record = fromRow(row, repo, false, false);

  assertEquals(record.id, "data-id-1");
  assertEquals(record.name, "test-data");
  assertEquals(record.version, 1);
  assertEquals(record.createdAt, "2026-01-01T00:00:00.000Z");
  assertEquals(record.modelName, "test-model");
  assertEquals(record.modelType, "test/model");
  assertEquals(record.specName, "test-spec");
  assertEquals(record.dataType, "resource");
  assertEquals(record.contentType, "application/json");
  assertEquals(record.lifetime, "infinite");
  assertEquals(record.ownerType, "model-method");
  assertEquals(record.streaming, false);
  assertEquals(record.size, 100);
  assertEquals(record.ownerRef, "ref-1");
  assertEquals(record.workflowRunId, "run-1");
  assertEquals(record.workflowName, "wf-1");
  assertEquals(record.jobName, "job-1");
  assertEquals(record.stepName, "step-1");
  assertEquals(record.source, "test");
  assertEquals(record.namespace, "");
});

Deno.test("fromRow: maps the namespace column to DataRecord.namespace", () => {
  const repo = stubRepo(null);
  const record = fromRow(createRow({ namespace: "infra" }), repo, false, false);
  assertEquals(record.namespace, "infra");
});

Deno.test("fromRow: converts streaming integer to boolean", () => {
  const repo = stubRepo(null);

  const streamingRecord = fromRow(
    createRow({ streaming: 1 }),
    repo,
    false,
    false,
  );
  assertEquals(streamingRecord.streaming, true);

  const nonStreamingRecord = fromRow(
    createRow({ streaming: 0 }),
    repo,
    false,
    false,
  );
  assertEquals(nonStreamingRecord.streaming, false);
});

Deno.test("fromRow: skips bytes for non-text content types", () => {
  let loadCalled = false;
  const repo = {
    getContentSync: () => {
      loadCalled = true;
      return null;
    },
  } as unknown as UnifiedDataRepository;

  fromRow(
    createRow({ content_type: "application/octet-stream" }),
    repo,
    true,
    true,
  );
  assertEquals(loadCalled, false);
});

Deno.test("fromRow: loads content for text/ content types", () => {
  const text = "hello world";
  const repo = stubRepo(encoder.encode(text));
  const record = fromRow(
    createRow({ content_type: "text/plain" }),
    repo,
    false,
    true,
  );

  assertEquals(record.content, text);
});

// ============================================================================
// fromData — async Data entity → DataRecord
// ============================================================================

const owner = {
  ownerType: "model-method" as const,
  ownerRef: "test/model:test",
};

Deno.test("fromData: parses JSON content and resolves attributes", async () => {
  const json = { host: "db.example.com", port: 5432 };
  const bytes = encoder.encode(JSON.stringify(json));
  const data = Data.create({
    name: "my-data",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource", modelName: "my-model", specName: "my-spec" },
    ownerDefinition: owner,
  });

  const repo = stubRepo(null, bytes);
  const record = await fromData(
    data,
    ModelType.create("test/model"),
    "model-123",
    repo,
  );

  assertEquals(record!.attributes, json);
  assertEquals(record!.content, JSON.stringify(json));
  assertEquals(record!.name, "my-data");
  assertEquals(record!.modelType, "test/model");
  assertEquals(record!.specName, "my-spec");
  assertEquals(record!.modelName, "my-model");
  assertEquals(record!.namespace, "");
});

Deno.test("fromData: stamps the repository namespace onto the record", async () => {
  const data = Data.create({
    name: "my-data",
    contentType: "application/octet-stream",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource" },
    ownerDefinition: owner,
  });

  // Repo configured with a non-solo namespace — the record must report it.
  const repo = {
    namespace: "infra",
    getContentSync: () => null,
    getContent: () => Promise.resolve(null),
  } as unknown as UnifiedDataRepository;

  const record = await fromData(
    data,
    ModelType.create("test/model"),
    "model-123",
    repo,
  );

  assertEquals(record!.namespace, "infra");
});

Deno.test("fromData: returns empty attributes for non-text content", async () => {
  const data = Data.create({
    name: "binary-data",
    contentType: "application/octet-stream",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource" },
    ownerDefinition: owner,
  });

  const repo = stubRepo(null, encoder.encode("binary"));
  const record = await fromData(
    data,
    ModelType.create("test/model"),
    "model-123",
    repo,
  );

  assertEquals(record!.attributes, {});
  assertEquals(record!.content, "");
});

Deno.test("fromData: uses option overrides for modelName and version", async () => {
  const data = Data.create({
    name: "versioned-data",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource" },
    ownerDefinition: owner,
  });

  const json = { v: 2 };
  const repo = stubRepo(null, encoder.encode(JSON.stringify(json)));
  const record = await fromData(
    data,
    ModelType.create("test/model"),
    "model-123",
    repo,
    { modelName: "override-model", version: 42 },
  );

  assertEquals(record!.modelName, "override-model");
  assertEquals(record!.version, 42);
});

Deno.test("fromData: maps provenance fields from ownerDefinition", async () => {
  const data = Data.create({
    name: "provenance-data",
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource" },
    ownerDefinition: owner,
  });

  const repo = stubRepo(null, encoder.encode("content"));
  const record = await fromData(
    data,
    ModelType.create("test/model"),
    "model-123",
    repo,
  );

  assertEquals(record!.ownerType, "model-method");
  assertEquals(record!.ownerRef, "test/model:test");
  // Unset optional provenance fields default to empty string
  assertEquals(record!.workflowRunId, "");
  assertEquals(record!.workflowName, "");
  assertEquals(record!.jobName, "");
  assertEquals(record!.stepName, "");
  assertEquals(record!.source, "");
});

Deno.test("fromData: handles null content bytes", async () => {
  const data = Data.create({
    name: "empty-data",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource" },
    ownerDefinition: owner,
  });

  const repo = stubRepo(null, null);
  const record = await fromData(
    data,
    ModelType.create("test/model"),
    "model-123",
    repo,
  );

  assertEquals(record!.attributes, {});
  assertEquals(record!.content, "");
});
