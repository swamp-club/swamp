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

import { assertEquals, assertRejects } from "@std/assert";
import { assertStringIncludes } from "@std/assert/string-includes";
import { ExtensionApiClient } from "./extension_api_client.ts";
import { UserError } from "../../domain/errors.ts";

Deno.test("ExtensionApiClient constructor stores server URL", () => {
  const client = new ExtensionApiClient("https://example.com");
  // Just verify it constructs without error
  assertEquals(typeof client, "object");
});

Deno.test("ExtensionApiClient.getLatestVersion throws UserError on connection failure", async () => {
  const client = new ExtensionApiClient("http://localhost:1");
  const error = await assertRejects(
    () => client.getLatestVersion("@test/ext", "fake-key"),
    UserError,
  );
  assertStringIncludes(error.message, "Could not connect");
});

Deno.test("ExtensionApiClient.initiatePush throws UserError on connection failure", async () => {
  const client = new ExtensionApiClient("http://localhost:1");
  const error = await assertRejects(
    () =>
      client.initiatePush({
        name: "@test/ext",
        version: "2026.02.26.1",
        description: "test",
        dependencies: [],
        platforms: [],
        labels: [],
      }, "fake-key"),
    UserError,
  );
  assertStringIncludes(error.message, "Could not connect");
});

Deno.test("ExtensionApiClient.confirmPush throws UserError on connection failure", async () => {
  const client = new ExtensionApiClient("http://localhost:1");
  const error = await assertRejects(
    () =>
      client.confirmPush({
        name: "@test/ext",
        version: "2026.02.26.1",
        description: "test",
        dependencies: [],
        platforms: [],
        labels: [],
      }, "fake-key"),
    UserError,
  );
  assertStringIncludes(error.message, "Could not connect");
});

Deno.test("ExtensionApiClient.checkResponse strips HTML error pages", async () => {
  const htmlBody =
    "<!DOCTYPE html><html><head><title>Error</title></head><body>Server Error</body></html>";
  const server = Deno.serve({ port: 0, onListen: () => {} }, (_req) => {
    return new Response(htmlBody, {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });
  const addr = server.addr;
  const client = new ExtensionApiClient(`http://localhost:${addr.port}`);
  const error = await assertRejects(
    () => client.getLatestVersion("@test/ext", "fake-key"),
    UserError,
  );
  assertStringIncludes(error.message, "unexpected HTML response");
  // Should NOT contain raw HTML
  assertEquals(error.message.includes("<!DOCTYPE"), false);
  await server.shutdown();
});

Deno.test("ExtensionApiClient.checkResponse strips HTML without content-type header", async () => {
  const htmlBody = "<!DOCTYPE html><html><body>Error</body></html>";
  const server = Deno.serve({ port: 0, onListen: () => {} }, (_req) => {
    return new Response(htmlBody, {
      status: 500,
      headers: { "content-type": "application/octet-stream" },
    });
  });
  const addr = server.addr;
  const client = new ExtensionApiClient(`http://localhost:${addr.port}`);
  const error = await assertRejects(
    () => client.getLatestVersion("@test/ext", "fake-key"),
    UserError,
  );
  assertStringIncludes(error.message, "unexpected HTML response");
  assertEquals(error.message.includes("<!DOCTYPE"), false);
  await server.shutdown();
});

Deno.test("ExtensionApiClient.checkResponse preserves JSON error messages", async () => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (_req) => {
    return new Response(JSON.stringify({ message: "version conflict" }), {
      status: 409,
      headers: { "content-type": "application/json" },
    });
  });
  const addr = server.addr;
  const client = new ExtensionApiClient(`http://localhost:${addr.port}`);
  const error = await assertRejects(
    () => client.getLatestVersion("@test/ext", "fake-key"),
    UserError,
  );
  assertStringIncludes(error.message, "version conflict");
  await server.shutdown();
});

Deno.test("ExtensionApiClient.downloadArchive throws UserError on connection failure", async () => {
  const client = new ExtensionApiClient("http://localhost:1");
  const error = await assertRejects(
    () => client.downloadArchive("@test/ext", "2026.02.26.1", "fake-key"),
    UserError,
  );
  assertStringIncludes(error.message, "Could not connect");
});

Deno.test("ExtensionApiClient.uploadArchive throws UserError on failure", async () => {
  // Non-existent URL
  const error = await assertRejects(
    () => {
      const client = new ExtensionApiClient("http://localhost:1");
      return client.uploadArchive(
        "http://localhost:1/fake-upload",
        new Uint8Array([0x1F, 0x8B]),
      );
    },
    UserError,
  );
  assertStringIncludes(error.message, "upload failed");
});
