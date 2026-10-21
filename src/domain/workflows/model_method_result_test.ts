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
import { Data } from "../data/data.ts";
import type { UnifiedDataRepository } from "../data/repositories.ts";
import { ModelType } from "../models/model_type.ts";
import { storedResourceRecord } from "./model_method_result.ts";

const TYPE = ModelType.create("test/method-result");
const REFERENCE = "${{ vault.get('prod', 'P') }}";

function repo(
  data: Data | null,
  content: string,
): { repo: UnifiedDataRepository; calls: string[] } {
  const calls: string[] = [];
  const repo = {
    namespace: "ns",
    findByName: (_type: ModelType, _modelId: string, name: string) => {
      calls.push(`findByName:${name}`);
      return Promise.resolve(data);
    },
    ensureContentLocal: (_type: ModelType, _modelId: string, name: string) => {
      calls.push(`ensureContentLocal:${name}`);
      return Promise.resolve("current");
    },
    getContent: (_type: ModelType, _modelId: string, name: string) => {
      calls.push(`getContent:${name}`);
      return Promise.resolve(new TextEncoder().encode(content));
    },
  } as unknown as UnifiedDataRepository;
  return { repo, calls };
}

function data(contentType: string): Data {
  return Data.create({
    name: "creds",
    contentType,
    lifetime: "infinite",
    garbageCollection: 10,
    tags: {
      type: "resource",
      specName: "creds",
      modelName: "db",
      "_swamp.sensitiveFields": JSON.stringify(["password"]),
    },
    ownerDefinition: { ownerType: "model-method", ownerRef: "test" },
  });
}

Deno.test("storedResourceRecord: a JSON resource is read as stored, tags and references intact, with no vault read", async () => {
  const { repo: dataRepo, calls } = repo(
    data("application/json"),
    JSON.stringify({ password: REFERENCE, host: "h" }),
  );
  const record = await storedResourceRecord(
    dataRepo,
    TYPE,
    "id-1",
    "creds",
    "db",
  );
  assertEquals(record?.attributes, { password: REFERENCE, host: "h" });
  assertEquals(
    record?.tags["_swamp.sensitiveFields"],
    JSON.stringify(["password"]),
  );
  assertEquals(record?.namespace, "ns");
  assertEquals(record?.modelName, "db");
  assertEquals(record?.isLatest, true);
  assertEquals(calls, [
    "findByName:creds",
    "ensureContentLocal:creds",
    "getContent:creds",
  ]);
});

Deno.test("storedResourceRecord: nothing written, or a non-JSON resource, answers null so the untyped shape is kept", async () => {
  const missing = repo(null, "");
  assertEquals(
    await storedResourceRecord(missing.repo, TYPE, "id-1", "creds", "db"),
    null,
  );
  assertEquals(missing.calls, ["findByName:creds"]);
  const text = repo(data("text/plain"), "plain text");
  assertEquals(
    await storedResourceRecord(text.repo, TYPE, "id-1", "creds", "db"),
    null,
  );
  assertEquals(text.calls, ["findByName:creds"]);
});
