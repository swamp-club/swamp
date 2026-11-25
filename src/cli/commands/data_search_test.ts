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

import { assertEquals, assertThrows } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { parseDuration, parseTags } from "../../libswamp/data/search.ts";

import "../../domain/models/models.ts";

await initializeLogging({});

Deno.test("dataSearchCommand module loads", async () => {
  const { dataSearchCommand } = await import("./data_search.ts");
  assertEquals(dataSearchCommand.getName(), "search");
});

Deno.test("dataSearchCommand has correct description", async () => {
  const { dataSearchCommand } = await import("./data_search.ts");
  assertEquals(
    dataSearchCommand.getDescription(),
    "Search for data across all behaviors",
  );
});

Deno.test("dataSearchCommand is registered as subcommand of dataCommand", async () => {
  const { createDataCommand } = await import("./data.ts");
  const dataCommand = await createDataCommand();
  const commands = dataCommand.getCommands();
  const searchCmd = commands.find((c) => c.getName() === "search");
  assertEquals(searchCmd !== undefined, true);
});

Deno.test("parseDuration parses hours", () => {
  assertEquals(parseDuration("1h"), 60 * 60 * 1000);
  assertEquals(parseDuration("24h"), 24 * 60 * 60 * 1000);
});

Deno.test("parseDuration parses days", () => {
  assertEquals(parseDuration("1d"), 24 * 60 * 60 * 1000);
  assertEquals(parseDuration("7d"), 7 * 24 * 60 * 60 * 1000);
});

Deno.test("parseDuration parses weeks", () => {
  assertEquals(parseDuration("1w"), 7 * 24 * 60 * 60 * 1000);
});

Deno.test("parseDuration parses months", () => {
  assertEquals(parseDuration("1mo"), 30 * 24 * 60 * 60 * 1000);
});

Deno.test("parseDuration throws on invalid format", () => {
  let threw = false;
  try {
    parseDuration("invalid");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("parseTags parses single KEY=VALUE", () => {
  const result = parseTags(["env=prod"]);
  assertEquals(result, { env: "prod" });
});

Deno.test("parseTags parses multiple KEY=VALUE entries", () => {
  const result = parseTags(["env=prod", "team=platform", "region=us-east-1"]);
  assertEquals(result, {
    env: "prod",
    team: "platform",
    region: "us-east-1",
  });
});

Deno.test("parseTags preserves value containing equals sign", () => {
  const result = parseTags(["expr=a=b=c"]);
  assertEquals(result, { expr: "a=b=c" });
});

Deno.test("parseTags throws on missing equals sign", () => {
  assertThrows(
    () => parseTags(["badformat"]),
    Error,
    'Invalid tag format: "badformat". Expected KEY=VALUE',
  );
});

Deno.test("parseTags throws on empty key (=value)", () => {
  assertThrows(
    () => parseTags(["=value"]),
    Error,
    'Invalid tag format: "=value". Expected KEY=VALUE',
  );
});

Deno.test("parseTags allows empty value (key=)", () => {
  const result = parseTags(["key="]);
  assertEquals(result, { key: "" });
});

Deno.test("parseTags last value wins for duplicate keys", () => {
  const result = parseTags(["env=prod", "env=dev"]);
  assertEquals(result, { env: "dev" });
});

function previewRepo(
  read: (maxBytes: number) => Promise<Uint8Array | null>,
): { repo: never; requested: number[] } {
  const requested: number[] = [];
  const repo = {
    getContentPath: () => "/repo/.swamp/data/test/model/m/notes/1/raw",
    getContentPrefix: (
      _type: unknown,
      _modelId: string,
      _name: string,
      _version: number,
      maxBytes: number,
    ) => {
      requested.push(maxBytes);
      return read(maxBytes);
    },
  } as never;
  return { repo, requested };
}

function previewItem(size: number): never {
  return {
    modelType: "test/model",
    modelId: "m",
    name: "notes",
    version: 1,
    contentType: "text/plain",
    size,
  } as never;
}

Deno.test("createDataFetchPreview: asks the repository for only the start of a body and marks a long one truncated", async () => {
  const { createDataFetchPreview } = await import("./data_search.ts");
  const body = new TextEncoder().encode("x".repeat(100 * 1024));
  const { repo, requested } = previewRepo((max) =>
    Promise.resolve(body.subarray(0, max))
  );
  const detail = await createDataFetchPreview(repo, "/repo")(
    previewItem(body.length),
  );
  assertEquals(requested, [64 * 1024 + 1]);
  assertEquals(detail.content?.length, 64 * 1024);
  assertEquals(detail.truncatedFrom, body.length);

  const short = previewRepo(() =>
    Promise.resolve(new TextEncoder().encode("hello\n"))
  );
  const whole = await createDataFetchPreview(short.repo, "/repo")(
    previewItem(6),
  );
  assertEquals(whole.content, "hello\n");
  assertEquals(whole.truncatedFrom, undefined);
});

Deno.test("createDataFetchPreview: a body the repository refuses, such as a content symlink out of its model, shows no content", async () => {
  const { createDataFetchPreview } = await import("./data_search.ts");
  const { repo } = previewRepo(() =>
    Promise.reject(new Error("Path traversal detected"))
  );
  const detail = await createDataFetchPreview(repo, "/repo")(previewItem(10));
  assertEquals(detail.content, undefined);
});
