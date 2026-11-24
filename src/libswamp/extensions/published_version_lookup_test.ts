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
import type {
  ListVersionsResponse,
  VersionEntry,
} from "../../infrastructure/http/extension_api_client.ts";
import {
  findPublishedVersion,
  findPublishedVersions,
} from "./published_version_lookup.ts";

function fakeClient(pages: ListVersionsResponse[]) {
  const asked: Array<{ channel?: string[]; page?: number }> = [];
  return {
    asked,
    listVersions: (
      _name: string,
      options?: { channel?: string[]; perPage?: number; page?: number },
    ) => {
      asked.push({ channel: options?.channel, page: options?.page });
      return Promise.resolve(pages[(options?.page ?? 1) - 1]);
    },
  };
}

function fakeVersionClient(entries: VersionEntry[]) {
  const asked: Array<{ name: string; version: string; apiKey?: string }> = [];
  return {
    asked,
    getVersion: (name: string, version: string, apiKey?: string) => {
      asked.push({ name, version, apiKey });
      return Promise.resolve(
        entries.find((entry) => entry.version === version) ?? null,
      );
    },
    listVersions: (): Promise<ListVersionsResponse> => {
      throw new Error("findPublishedVersion must not page the listing");
    },
  };
}

Deno.test("findPublishedVersion: asks for the one version and answers with its channel", async () => {
  const client = fakeVersionClient([
    { version: "2026.10.06.1", channel: "beta", publishedAt: "" },
  ]);
  assertEquals(
    await findPublishedVersion(client, "@a/b", "2026.10.06.1", "k"),
    { version: "2026.10.06.1", channel: "beta" },
  );
  assertEquals(client.asked, [
    { name: "@a/b", version: "2026.10.06.1", apiKey: "k" },
  ]);
});

Deno.test("findPublishedVersion: resolves null when the registry does not hold the version", async () => {
  const client = fakeVersionClient([]);
  assertEquals(
    await findPublishedVersion(client, "@a/b", "2026.10.06.1", "k"),
    null,
  );
});

Deno.test("findPublishedVersion: a yanked version still answers, with its yank and reason", async () => {
  const client = fakeVersionClient([{
    version: "2026.10.06.1",
    channel: "beta",
    publishedAt: "",
    yankedAt: "2026-10-07T00:00:00.000Z",
    yankReason: "broken build",
  }]);
  assertEquals(
    await findPublishedVersion(client, "@a/b", "2026.10.06.1", "k"),
    {
      version: "2026.10.06.1",
      channel: "beta",
      yank: { reason: "broken build" },
    },
  );
});

Deno.test("findPublishedVersion: a yank without a reason has a null reason", async () => {
  const client = fakeVersionClient([{
    version: "2026.10.06.1",
    channel: "beta",
    publishedAt: "",
    yankedAt: "2026-10-07T00:00:00.000Z",
  }]);
  assertEquals(
    await findPublishedVersion(client, "@a/b", "2026.10.06.1", "k"),
    { version: "2026.10.06.1", channel: "beta", yank: { reason: null } },
  );
});

Deno.test("findPublishedVersion: a null yankedAt is not a yank", async () => {
  const client = fakeVersionClient([{
    version: "2026.10.06.1",
    channel: "beta",
    publishedAt: "",
    yankedAt: null,
    yankReason: null,
  }]);
  assertEquals(
    await findPublishedVersion(client, "@a/b", "2026.10.06.1", "k"),
    { version: "2026.10.06.1", channel: "beta" },
  );
});

Deno.test("findPublishedVersions: a yanked version in the listing answers with its yank", async () => {
  const client = fakeClient([{
    versions: [{
      version: "2026.10.06.1",
      channel: "beta",
      publishedAt: "",
      yankedAt: "2026-10-07T00:00:00.000Z",
      yankReason: "broken build",
    }],
    meta: { total: 1, page: 1, perPage: 100 },
  }]);
  const found = await findPublishedVersions(client, "@a/b", ["2026.10.06.1"]);
  assertEquals(found.get("2026.10.06.1"), {
    version: "2026.10.06.1",
    channel: "beta",
    yank: { reason: "broken build" },
  });
});

Deno.test("findPublishedVersions: answers several versions in one scan and stops once all are found", async () => {
  const client = fakeClient([
    {
      versions: [{ version: "2026.10.06.1", channel: "beta", publishedAt: "" }],
      meta: { total: 3, page: 1, perPage: 1 },
    },
    {
      versions: [
        { version: "2026.09.23.1", channel: "stable", publishedAt: "" },
      ],
      meta: { total: 3, page: 2, perPage: 1 },
    },
    {
      versions: [
        { version: "2026.09.01.1", channel: "stable", publishedAt: "" },
      ],
      meta: { total: 3, page: 3, perPage: 1 },
    },
  ]);
  const found = await findPublishedVersions(client, "@a/b", [
    "2026.09.23.1",
    "2026.10.06.1",
  ]);
  assertEquals(found.get("2026.10.06.1")?.channel, "beta");
  assertEquals(found.get("2026.09.23.1")?.channel, "stable");
  assertEquals(client.asked.map((a) => a.page), [1, 2]);
});

Deno.test("findPublishedVersions: a version no channel carries is absent", async () => {
  const client = fakeClient([{
    versions: [{ version: "2026.10.01.1", channel: "stable", publishedAt: "" }],
    meta: { total: 1, page: 1, perPage: 100 },
  }]);
  const found = await findPublishedVersions(client, "@a/b", [
    "2026.10.01.1",
    "2026.10.06.1",
  ]);
  assertEquals(found.get("2026.10.01.1")?.channel, "stable");
  assertEquals(found.has("2026.10.06.1"), false);
});

Deno.test("findPublishedVersions: stops at a short page", async () => {
  const client = fakeClient([{
    versions: [{ version: "2026.01.01.1", channel: "stable", publishedAt: "" }],
    meta: { total: 1, page: 1, perPage: 100 },
  }]);
  const found = await findPublishedVersions(client, "@a/b", ["2026.03.22.1"]);
  assertEquals(found.size, 0);
  assertEquals(client.asked.length, 1);
});

Deno.test("findPublishedVersions: does not page a response without paging metadata", async () => {
  const client = fakeClient([{
    versions: Array.from({ length: 100 }, (_, i) => ({
      version: `2026.01.01.${i}`,
      channel: "stable",
      publishedAt: "",
    })),
  } as unknown as ListVersionsResponse]);
  const found = await findPublishedVersions(client, "@a/b", ["2026.03.22.1"]);
  assertEquals(found.size, 0);
  assertEquals(client.asked.length, 1);
});
