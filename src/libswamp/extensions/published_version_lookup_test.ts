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
import type { ListVersionsResponse } from "../../infrastructure/http/extension_api_client.ts";
import { findPublishedVersion } from "./published_version_lookup.ts";

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

Deno.test("findPublishedVersion: answers with the channel the version is on", async () => {
  const client = fakeClient([{
    versions: [
      { version: "2026.10.01.1", channel: "stable", publishedAt: "" },
      { version: "2026.10.06.1", channel: "beta", publishedAt: "" },
    ],
    meta: { total: 2, page: 1, perPage: 100 },
  }]);
  assertEquals(
    await findPublishedVersion(client, "@a/b", "2026.10.06.1", "k"),
    { version: "2026.10.06.1", channel: "beta" },
  );
  assertEquals(client.asked, [{ channel: ["stable", "rc", "beta"], page: 1 }]);
});

Deno.test("findPublishedVersion: resolves null when no channel carries the version", async () => {
  const client = fakeClient([{
    versions: [{ version: "2026.10.01.1", channel: "stable", publishedAt: "" }],
    meta: { total: 1, page: 1, perPage: 100 },
  }]);
  assertEquals(
    await findPublishedVersion(client, "@a/b", "2026.10.06.1", "k"),
    null,
  );
});

Deno.test("findPublishedVersion: a yanked version still answers, with its yank and reason", async () => {
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
  const client = fakeClient([{
    versions: [{
      version: "2026.10.06.1",
      channel: "beta",
      publishedAt: "",
      yankedAt: "2026-10-07T00:00:00.000Z",
    }],
    meta: { total: 1, page: 1, perPage: 100 },
  }]);
  assertEquals(
    await findPublishedVersion(client, "@a/b", "2026.10.06.1", "k"),
    { version: "2026.10.06.1", channel: "beta", yank: { reason: null } },
  );
});

Deno.test("findPublishedVersion: a null yankedAt is not a yank", async () => {
  const client = fakeClient([{
    versions: [{
      version: "2026.10.06.1",
      channel: "beta",
      publishedAt: "",
      yankedAt: null,
      yankReason: null,
    }],
    meta: { total: 1, page: 1, perPage: 100 },
  }]);
  assertEquals(
    await findPublishedVersion(client, "@a/b", "2026.10.06.1", "k"),
    { version: "2026.10.06.1", channel: "beta" },
  );
});
