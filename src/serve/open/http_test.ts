// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assert, assertEquals } from "@std/assert";
import { handleOpenRequest, type OpenServerState } from "./http.ts";
import type { ExtensionApiClient } from "../../infrastructure/http/extension_api_client.ts";

function stubState(): OpenServerState {
  const extClient = {
    // Return undefined for all methods; endpoints that exercise the client
    // are guarded by `requireRepo` so they never run in these tests.
  } as unknown as ExtensionApiClient;

  return {
    repoDir: null,
    repoContext: null,
    datastoreConfig: null,
    extClient,
    version: "test-version",
    initializeRepo: () => Promise.resolve(),
    installExtension: () => Promise.resolve(),
    createDefinition: () =>
      Promise.resolve({ id: "test", name: "test", type: "test" }),
    listDefinitionsByType: () => Promise.resolve([]),
  };
}

Deno.test("handleOpenRequest: GET / serves the HTML UI", async () => {
  const state = stubState();
  const res = await handleOpenRequest(
    new Request("http://127.0.0.1:9191/"),
    state,
  );
  assertEquals(res.status, 200);
  assertEquals(
    res.headers.get("content-type"),
    "text/html; charset=utf-8",
  );
  const body = await res.text();
  assert(
    body.includes("<!doctype html>"),
    "response body should contain the UI HTML",
  );
});

Deno.test("handleOpenRequest: GET /favicon.svg serves an SVG", async () => {
  const state = stubState();
  const res = await handleOpenRequest(
    new Request("http://127.0.0.1:9191/favicon.svg"),
    state,
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "image/svg+xml");
  const body = await res.text();
  assert(body.startsWith("<svg"), "favicon body should be SVG");
});

Deno.test("handleOpenRequest: GET /api/repo/status reports uninitialized", async () => {
  const state = stubState();
  const res = await handleOpenRequest(
    new Request("http://127.0.0.1:9191/api/repo/status"),
    state,
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.initialized, false);
  assertEquals(body.path, null);
});

Deno.test("handleOpenRequest: repo-gated endpoint 412s when no repo is loaded", async () => {
  const state = stubState();
  const res = await handleOpenRequest(
    new Request("http://127.0.0.1:9191/api/extensions/installed"),
    state,
  );
  assertEquals(res.status, 412);
  const body = await res.json();
  assertEquals(body.error.message, "Repository not initialized");
});

Deno.test("handleOpenRequest: unknown route returns 404", async () => {
  const state = stubState();
  const res = await handleOpenRequest(
    new Request("http://127.0.0.1:9191/nope"),
    state,
  );
  assertEquals(res.status, 404);
});

Deno.test("handleOpenRequest: /api/fs/list returns directory listing", async () => {
  const state = stubState();
  const tmp = await Deno.makeTempDir({ prefix: "swamp_open_test_" });
  try {
    await Deno.mkdir(tmp + "/alpha");
    await Deno.writeTextFile(tmp + "/readme.txt", "hi");
    const url = "http://127.0.0.1:9191/api/fs/list?path=" +
      encodeURIComponent(tmp);
    const res = await handleOpenRequest(new Request(url), state);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.path, tmp);
    // Non-directory entries are filtered out of the listing.
    const names = body.entries.map((e: { name: string }) => e.name);
    assert(names.includes("alpha"));
    assertEquals(body.isSwamp, false);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("handleOpenRequest: cross-origin request is rejected with 403", async () => {
  const state = stubState();
  const res = await handleOpenRequest(
    new Request("http://127.0.0.1:9191/api/repo/status", {
      headers: { origin: "http://evil.example.com" },
    }),
    state,
  );
  assertEquals(res.status, 403);
  const body = await res.json();
  assertEquals(body.error.message, "Cross-origin request rejected");
});

Deno.test("handleOpenRequest: same-origin request with Origin header passes", async () => {
  const state = stubState();
  const res = await handleOpenRequest(
    new Request("http://127.0.0.1:9191/api/repo/status", {
      headers: { origin: "http://127.0.0.1:9191" },
    }),
    state,
  );
  assertEquals(res.status, 200);
});

Deno.test("handleOpenRequest: /api/repo/meta requires absolute path", async () => {
  const state = stubState();
  const res = await handleOpenRequest(
    new Request("http://127.0.0.1:9191/api/repo/meta", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "relative/path" }),
    }),
    state,
  );
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error.message, "Absolute path required");
});
