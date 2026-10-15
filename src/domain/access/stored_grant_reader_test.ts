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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { Data } from "../data/data.ts";
import type {
  FindAllForTypeOptions,
  UnifiedDataRepository,
} from "../data/repositories.ts";
import { type Grant, GRANT_MODEL_TYPE } from "../models/access/grant_model.ts";
import type { ModelType } from "../models/model_type.ts";
import { readStoredGrants } from "./stored_grant_reader.ts";
import { UnreadableAccessRecordsError } from "./unreadable_access_records.ts";

function makeData(name: string): Data {
  return Data.create({
    name,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "resource", modelName: "g" },
    ownerDefinition: { ownerType: "model-method", ownerRef: "test" },
  });
}

function grant(id: string): Grant {
  return {
    id,
    subject: { kind: "user", name: "adam" },
    effect: "deny",
    actions: ["read"],
    resource: { kind: "workflow", pattern: "*" },
    state: "active",
    source: "file:grants.yaml",
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
  };
}

/**
 * A data repository over grant models, each keeping `grant-main` and
 * optionally a method-summary report. `content` maps `<modelId>/<dataName>`
 * to its bytes, an Error to throw, or null; `skipped` is what
 * findAllForType reports as skipped; `orphanedListing` fails the orphaned
 * type's listing.
 */
function fakeRepo(options: {
  items: Array<{ modelId: string; dataName: string }>;
  content: Record<string, Uint8Array | Error | null>;
  skipped?: Array<{ modelId: string; dataName?: string; error: unknown }>;
  orphanedListing?: Error;
}): UnifiedDataRepository {
  return {
    findAllForType(type: ModelType, findOptions?: FindAllForTypeOptions) {
      if (type.normalized !== GRANT_MODEL_TYPE.normalized) {
        return options.orphanedListing
          ? Promise.reject(options.orphanedListing)
          : Promise.resolve([]);
      }
      for (const skipped of options.skipped ?? []) {
        findOptions?.unreadable?.push({ modelType: type, ...skipped });
      }
      return Promise.resolve(
        options.items.map(({ modelId, dataName }) => ({
          data: makeData(dataName),
          modelType: type,
          modelId,
        })),
      );
    },
    getContent(_type: ModelType, modelId: string, dataName: string) {
      const content = options.content[`${modelId}/${dataName}`];
      if (content instanceof Error) return Promise.reject(content);
      return Promise.resolve(content ?? null);
    },
  } as unknown as UnifiedDataRepository;
}

const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));

Deno.test("readStoredGrants: reads each grant's grant-main and never its other data", async () => {
  const grants = await readStoredGrants(fakeRepo({
    items: [
      { modelId: "g1", dataName: "grant-main" },
      { modelId: "g1", dataName: "report" },
    ],
    content: {
      "g1/grant-main": encode(grant("g1")),
      // A report this process cannot read is not access data.
      "g1/report": new Deno.errors.PermissionDenied("report"),
    },
  }));
  assertEquals(grants.map((stored) => stored.grant.id), ["g1"]);
});

Deno.test("readStoredGrants: refuses before anything is written, naming every grant it cannot load with its cause", async () => {
  const error = await assertRejects(
    () =>
      readStoredGrants(fakeRepo({
        items: [
          { modelId: "ok", dataName: "grant-main" },
          { modelId: "no-access", dataName: "grant-main" },
          { modelId: "bad-json", dataName: "grant-main" },
          { modelId: "invalid", dataName: "grant-main" },
        ],
        content: {
          "ok/grant-main": encode(grant("ok")),
          "no-access/grant-main": new Deno.errors.PermissionDenied("raw"),
          "bad-json/grant-main": new TextEncoder().encode("{bad"),
          "invalid/grant-main": encode({ id: "invalid" }),
        },
        skipped: [
          // The model directory, or its grant-main, could not be listed.
          {
            modelId: "dir",
            error: new Deno.errors.PermissionDenied("dir"),
          },
          {
            modelId: "meta",
            dataName: "grant-main",
            error: new SyntaxError("metadata.yaml is empty"),
          },
          // A report beside a grant does not fail it.
          {
            modelId: "ok",
            dataName: "report",
            error: new SyntaxError("report metadata.yaml is empty"),
          },
          // A version mid-write, its metadata not there yet, is skipped.
          {
            modelId: "mid-write",
            dataName: "grant-main",
            error: new Deno.errors.NotFound("metadata.yaml is missing"),
          },
        ],
      })),
    UnreadableAccessRecordsError,
  );
  assertEquals(
    error.records.map((record) => [record.modelId, record.cause]).sort(),
    [
      ["bad-json", "corrupt"],
      ["dir", "unreadable"],
      ["invalid", "unrecognised"],
      ["meta", "corrupt"],
      ["no-access", "unreadable"],
    ],
  );
  assertStringIncludes(
    error.message,
    "swamp data delete bad-json grant-main -y",
  );
});

Deno.test("readStoredGrants: an orphaned type directory that cannot be listed fails the read, and one missing reads as none", async () => {
  const content = { "g1/grant-main": encode(grant("g1")) };
  const items = [{ modelId: "g1", dataName: "grant-main" }];
  await assertRejects(
    () =>
      readStoredGrants(fakeRepo({
        items,
        content,
        orphanedListing: new Deno.errors.PermissionDenied("@swamp/grant"),
      })),
    Deno.errors.PermissionDenied,
  );
  const grants = await readStoredGrants(fakeRepo({
    items,
    content,
    orphanedListing: new Deno.errors.NotFound("@swamp/grant"),
  }));
  assertEquals(grants.map((stored) => stored.grant.id), ["g1"]);
});
