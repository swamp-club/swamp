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

import { assertEquals, assertRejects } from "@std/assert";
import { assertStringIncludes } from "@std/assert/string-includes";
import {
  ExtensionApiClient,
  MAX_REGISTRY_WARNING_LENGTH,
  MAX_REGISTRY_WARNINGS,
  REGISTRY_FORBIDDEN_CODE,
  REGISTRY_TOKEN_SCOPE_CODE,
} from "./extension_api_client.ts";
import { UserError } from "../../domain/errors.ts";
import { MAX_EXTENSION_ARCHIVE_BYTES } from "../../domain/extensions/extension_archive_limits.ts";

for (
  const visibility of [undefined, "public", "private", null, "PRIVATE", true]
) {
  Deno.test(`ExtensionApiClient.confirmPush: validates applied visibility ${visibility}`, async () => {
    const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
      const body = await req.json();
      assertEquals(body.visibility, "private");
      return Response.json({
        name: body.name,
        version: body.version,
        extensionId: "ext-123",
        visibility,
      });
    });
    try {
      const client = new ExtensionApiClient(
        `http://localhost:${server.addr.port}`,
      );
      const confirm = () =>
        client.confirmPush({
          name: "@test/ext",
          version: "2026.09.16.1",
          description: "",
          dependencies: [],
          platforms: [],
          labels: [],
          visibility: "private",
        }, "test-key");
      if (
        visibility === undefined || visibility === "public" ||
        visibility === "private"
      ) {
        assertEquals((await confirm()).visibility, visibility);
      } else {
        await assertRejects(
          confirm,
          UserError,
          "invalid publication visibility",
        );
      }
    } finally {
      await server.shutdown();
    }
  });
}

/** Confirms a push against a registry whose response carries `warnings`. */
async function confirmWithWarnings(warnings: unknown) {
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    const body = await req.json();
    return Response.json({
      name: body.name,
      version: body.version,
      extensionId: "ext-123",
      ...(warnings !== undefined ? { warnings } : {}),
    }, { status: 201 });
  });
  try {
    const client = new ExtensionApiClient(
      `http://localhost:${server.addr.port}`,
    );
    return await client.confirmPush({
      name: "@test/ext",
      version: "2026.09.16.1",
      description: "",
      dependencies: [],
      platforms: [],
      labels: [],
    }, "test-key");
  } finally {
    await server.shutdown();
  }
}

Deno.test("ExtensionApiClient.confirmPush: returns the registry's warnings", async () => {
  const warning =
    "contentMetadata was rejected (too many methods); the registry listing was extracted from the archive instead";
  const result = await confirmWithWarnings([warning]);
  assertEquals(result.warnings, { messages: [warning], omitted: 0 });
  assertEquals(result.extensionId, "ext-123");
});

for (
  const [name, warnings] of [
    ["absent", undefined],
    ["empty", []],
    ["a string", "rejected"],
    ["an object", { message: "rejected" }],
    ["null", null],
    ["only non-strings and blanks", [1, null, { a: 1 }, "", "  \n "]],
  ] as const
) {
  Deno.test(`ExtensionApiClient.confirmPush: omits warnings when the field is ${name}`, async () => {
    const result = await confirmWithWarnings(warnings);
    assertEquals("warnings" in result, false);
    assertEquals(result.extensionId, "ext-123");
  });
}

Deno.test("ExtensionApiClient.confirmPush: keeps only the string warnings", async () => {
  const result = await confirmWithWarnings(["first", 2, null, "second"]);
  assertEquals(result.warnings?.messages, ["first", "second"]);
});

Deno.test("ExtensionApiClient.confirmPush: replaces control and bidi characters in a warning with spaces", async () => {
  const result = await confirmWithWarnings([
    "red\x1b[31m\r\nline two\u202e reversed\u2066\x9b",
  ]);
  assertEquals(result.warnings?.messages, ["red [31m  line two  reversed"]);
});

Deno.test("ExtensionApiClient.confirmPush: replaces invisible format characters and line separators in a warning with spaces", async () => {
  const result = await confirmWithWarnings([
    "a\u2028b\u2029c\u200ed\u200fe\u061cf\u200bg\u200dh\ufeffi",
  ]);
  assertEquals(result.warnings?.messages, ["a b c d e f g h i"]);
});

Deno.test("ExtensionApiClient.confirmPush: truncates a long warning by code point", async () => {
  const result = await confirmWithWarnings([
    "😀".repeat(MAX_REGISTRY_WARNING_LENGTH + 5),
    "x".repeat(MAX_REGISTRY_WARNING_LENGTH),
  ]);
  assertEquals(result.warnings?.messages, [
    `${"😀".repeat(MAX_REGISTRY_WARNING_LENGTH)}…`,
    "x".repeat(MAX_REGISTRY_WARNING_LENGTH),
  ]);
});

Deno.test("ExtensionApiClient.confirmPush: caps the warnings and counts the omitted ones", async () => {
  const many = Array.from(
    { length: MAX_REGISTRY_WARNINGS + 3 },
    (_, i) => `warning ${i}`,
  );
  const result = await confirmWithWarnings(many);
  assertEquals(result.warnings, {
    messages: many.slice(0, MAX_REGISTRY_WARNINGS),
    omitted: 3,
  });
  const atLimit = await confirmWithWarnings(
    many.slice(0, MAX_REGISTRY_WARNINGS),
  );
  assertEquals(atLimit.warnings, {
    messages: many.slice(0, MAX_REGISTRY_WARNINGS),
    omitted: 0,
  });
});

Deno.test("ExtensionApiClient.confirmPush: does not count dropped entries as omitted warnings", async () => {
  const result = await confirmWithWarnings([
    ...Array.from({ length: MAX_REGISTRY_WARNINGS }, (_, i) => `warning ${i}`),
    7,
    "  ",
    null,
  ]);
  assertEquals(result.warnings?.omitted, 0);
  assertEquals(result.warnings?.messages.length, MAX_REGISTRY_WARNINGS);
});

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

Deno.test("ExtensionApiClient.searchExtensions builds correct URL with params", async () => {
  let capturedUrl = "";
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    capturedUrl = req.url;
    return new Response(
      JSON.stringify({
        extensions: [],
        meta: { total: 0, page: 1, perPage: 20 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const addr = server.addr;
  const client = new ExtensionApiClient(`http://localhost:${addr.port}`);
  await client.searchExtensions({
    q: "aws",
    collective: "stack72",
    sort: "new",
    perPage: 10,
    page: 2,
  });
  const url = new URL(capturedUrl);
  assertEquals(url.pathname, "/api/v1/extensions/search");
  assertEquals(url.searchParams.get("q"), "aws");
  assertEquals(url.searchParams.get("collective"), "stack72");
  assertEquals(url.searchParams.get("sort"), "new");
  assertEquals(url.searchParams.get("perPage"), "10");
  assertEquals(url.searchParams.get("page"), "2");
  await server.shutdown();
});

Deno.test("ExtensionApiClient.searchExtensions repeats platform and label params", async () => {
  let capturedUrl = "";
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    capturedUrl = req.url;
    return new Response(
      JSON.stringify({
        extensions: [],
        meta: { total: 0, page: 1, perPage: 20 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const addr = server.addr;
  const client = new ExtensionApiClient(`http://localhost:${addr.port}`);
  await client.searchExtensions({
    platform: ["aws", "docker"],
    label: ["deploy", "infra"],
  });
  const url = new URL(capturedUrl);
  assertEquals(url.searchParams.getAll("platform"), ["aws", "docker"]);
  assertEquals(url.searchParams.getAll("label"), ["deploy", "infra"]);
  await server.shutdown();
});

Deno.test("ExtensionApiClient.searchExtensions repeats contentType params", async () => {
  let capturedUrl = "";
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    capturedUrl = req.url;
    return new Response(
      JSON.stringify({
        extensions: [],
        meta: { total: 0, page: 1, perPage: 20 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const addr = server.addr;
  const client = new ExtensionApiClient(`http://localhost:${addr.port}`);
  await client.searchExtensions({
    contentType: ["models", "workflows"],
  });
  const url = new URL(capturedUrl);
  assertEquals(url.searchParams.getAll("contentType"), [
    "models",
    "workflows",
  ]);
  await server.shutdown();
});

Deno.test("ExtensionApiClient.searchExtensions sends no params when empty", async () => {
  let capturedUrl = "";
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    capturedUrl = req.url;
    return new Response(
      JSON.stringify({
        extensions: [],
        meta: { total: 0, page: 1, perPage: 20 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const addr = server.addr;
  const client = new ExtensionApiClient(`http://localhost:${addr.port}`);
  await client.searchExtensions({});
  const url = new URL(capturedUrl);
  assertEquals(url.pathname, "/api/v1/extensions/search");
  assertEquals(url.search, "");
  await server.shutdown();
});

Deno.test("ExtensionApiClient.searchExtensions throws UserError on connection failure", async () => {
  const client = new ExtensionApiClient("http://localhost:1");
  const error = await assertRejects(
    () => client.searchExtensions({ q: "test" }),
    UserError,
  );
  assertStringIncludes(error.message, "Could not connect");
});

Deno.test("ExtensionApiClient.yankExtension sends POST with reason to version yank endpoint", async () => {
  let capturedUrl = "";
  let capturedMethod = "";
  let capturedBody = "";
  let capturedAuth = "";
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    capturedUrl = req.url;
    capturedMethod = req.method;
    capturedAuth = req.headers.get("x-api-key") ?? "";
    capturedBody = await req.text();
    return new Response(
      JSON.stringify({ message: "Yanked @test/ext@2026.02.26.1" }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const addr = server.addr;
  const client = new ExtensionApiClient(`http://localhost:${addr.port}`);
  const result = await client.yankExtension(
    "@test/ext",
    "2026.02.26.1",
    null,
    "Security vulnerability",
    "swamp_fake-key",
  );
  const url = new URL(capturedUrl);
  assertEquals(capturedMethod, "POST");
  assertEquals(
    url.pathname,
    "/api/v1/extensions/%40test%2Fext@2026.02.26.1/yank",
  );
  assertEquals(capturedAuth, "swamp_fake-key");
  const parsedBody = JSON.parse(capturedBody);
  assertEquals(parsedBody.reason, "Security vulnerability");
  assertEquals(parsedBody.channel, undefined);
  assertStringIncludes(result.message, "Yanked");
  await server.shutdown();
});

Deno.test("ExtensionApiClient.yankExtension sends POST to extension yank endpoint when no version", async () => {
  let capturedUrl = "";
  const server = Deno.serve({ port: 0, onListen: () => {} }, (_req) => {
    capturedUrl = _req.url;
    return new Response(
      JSON.stringify({ message: "Yanked @test/ext" }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const addr = server.addr;
  const client = new ExtensionApiClient(`http://localhost:${addr.port}`);
  await client.yankExtension(
    "@test/ext",
    null,
    null,
    "Policy violation",
    "swamp_fake-key",
  );
  const url = new URL(capturedUrl);
  assertEquals(url.pathname, "/api/v1/extensions/%40test%2Fext/yank");
  await server.shutdown();
});

Deno.test("ExtensionApiClient.yankExtension throws UserError on 410 already yanked", async () => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (_req) => {
    return new Response(
      JSON.stringify({ error: "'@test/ext' is already yanked" }),
      { status: 410, headers: { "content-type": "application/json" } },
    );
  });
  const addr = server.addr;
  const client = new ExtensionApiClient(`http://localhost:${addr.port}`);
  const error = await assertRejects(
    () =>
      client.yankExtension(
        "@test/ext",
        null,
        null,
        "reason",
        "swamp_fake-key",
      ),
    UserError,
  );
  assertStringIncludes(error.message, "already yanked");
  await server.shutdown();
});

Deno.test("ExtensionApiClient.yankExtension includes channel in body when provided", async () => {
  let capturedBody = "";
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    capturedBody = await req.text();
    return new Response(
      JSON.stringify({ message: "Yanked @test/ext (stable channel)" }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const addr = server.addr;
  const client = new ExtensionApiClient(`http://localhost:${addr.port}`);
  await client.yankExtension(
    "@test/ext",
    null,
    "stable",
    "withdrawing from stable",
    "swamp_fake-key",
  );
  const parsedBody = JSON.parse(capturedBody);
  assertEquals(parsedBody.channel, "stable");
  assertEquals(parsedBody.reason, "withdrawing from stable");
  await server.shutdown();
});

Deno.test("ExtensionApiClient.yankExtension throws UserError on connection failure", async () => {
  const client = new ExtensionApiClient("http://localhost:1");
  const error = await assertRejects(
    () =>
      client.yankExtension(
        "@test/ext",
        "2026.02.26.1",
        null,
        "reason",
        "fake-key",
      ),
    UserError,
  );
  assertStringIncludes(error.message, "Could not connect");
});

Deno.test("ExtensionApiClient.unyankExtension sends POST with reason to version unyank endpoint", async () => {
  let capturedUrl = "";
  let capturedMethod = "";
  let capturedBody = "";
  let capturedAuth = "";
  let capturedContentType = "";
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    capturedUrl = req.url;
    capturedMethod = req.method;
    capturedAuth = req.headers.get("x-api-key") ?? "";
    capturedContentType = req.headers.get("content-type") ?? "";
    capturedBody = await req.text();
    return new Response(
      JSON.stringify({ message: "Unyanked @test/ext@2026.02.26.1" }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const addr = server.addr;
  const client = new ExtensionApiClient(`http://localhost:${addr.port}`);
  const result = await client.unyankExtension(
    "@test/ext",
    "2026.02.26.1",
    null,
    "Mistake yank",
    "swamp_fake-key",
  );
  const url = new URL(capturedUrl);
  assertEquals(capturedMethod, "POST");
  assertEquals(
    url.pathname,
    "/api/v1/extensions/%40test%2Fext@2026.02.26.1/unyank",
  );
  assertEquals(capturedAuth, "swamp_fake-key");
  assertEquals(capturedContentType, "application/json");
  assertEquals(JSON.parse(capturedBody).reason, "Mistake yank");
  assertStringIncludes(result.message, "Unyanked");
  await server.shutdown();
});

Deno.test("ExtensionApiClient.unyankExtension sends POST to extension unyank endpoint when no version", async () => {
  let capturedUrl = "";
  const server = Deno.serve({ port: 0, onListen: () => {} }, (_req) => {
    capturedUrl = _req.url;
    return new Response(
      JSON.stringify({ message: "Unyanked @test/ext" }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const addr = server.addr;
  const client = new ExtensionApiClient(`http://localhost:${addr.port}`);
  await client.unyankExtension(
    "@test/ext",
    null,
    null,
    "restoring name",
    "swamp_fake-key",
  );
  const url = new URL(capturedUrl);
  assertEquals(url.pathname, "/api/v1/extensions/%40test%2Fext/unyank");
  await server.shutdown();
});

Deno.test("ExtensionApiClient.unyankExtension sends POST with no body and no Content-Type when reason is null", async () => {
  let capturedBody = "";
  let capturedContentType: string | null = "";
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    capturedContentType = req.headers.get("content-type");
    capturedBody = await req.text();
    return new Response(
      JSON.stringify({ message: "Unyanked @test/ext" }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const addr = server.addr;
  const client = new ExtensionApiClient(`http://localhost:${addr.port}`);
  await client.unyankExtension(
    "@test/ext",
    null,
    null,
    null,
    "swamp_fake-key",
  );
  assertEquals(capturedBody, "");
  assertEquals(capturedContentType, null);
  await server.shutdown();
});

Deno.test("ExtensionApiClient.unyankExtension includes channel in body when provided", async () => {
  let capturedBody = "";
  let capturedContentType = "";
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    capturedContentType = req.headers.get("content-type") ?? "";
    capturedBody = await req.text();
    return new Response(
      JSON.stringify({ message: "Unyanked @test/ext (beta channel)" }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const addr = server.addr;
  const client = new ExtensionApiClient(`http://localhost:${addr.port}`);
  await client.unyankExtension(
    "@test/ext",
    null,
    "beta",
    null,
    "swamp_fake-key",
  );
  assertEquals(capturedContentType, "application/json");
  const parsedBody = JSON.parse(capturedBody);
  assertEquals(parsedBody.channel, "beta");
  assertEquals(parsedBody.reason, undefined);
  await server.shutdown();
});

Deno.test("ExtensionApiClient.unyankExtension throws UserError on 409 not yanked", async () => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (_req) => {
    return new Response(
      JSON.stringify({ error: "'@test/ext' is not yanked" }),
      { status: 409, headers: { "content-type": "application/json" } },
    );
  });
  const addr = server.addr;
  const client = new ExtensionApiClient(`http://localhost:${addr.port}`);
  const error = await assertRejects(
    () =>
      client.unyankExtension(
        "@test/ext",
        null,
        null,
        null,
        "swamp_fake-key",
      ),
    UserError,
  );
  assertStringIncludes(error.message, "not yanked");
  await server.shutdown();
});

Deno.test("ExtensionApiClient.unyankExtension throws UserError on 404 not found", async () => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (_req) => {
    return new Response(
      JSON.stringify({ error: "Extension '@test/ext' not found" }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  });
  const addr = server.addr;
  const client = new ExtensionApiClient(`http://localhost:${addr.port}`);
  const error = await assertRejects(
    () =>
      client.unyankExtension(
        "@test/ext",
        null,
        null,
        null,
        "swamp_fake-key",
      ),
    UserError,
  );
  assertStringIncludes(error.message, "not found");
  await server.shutdown();
});

Deno.test("ExtensionApiClient.unyankExtension throws UserError on connection failure", async () => {
  const client = new ExtensionApiClient("http://localhost:1");
  const error = await assertRejects(
    () =>
      client.unyankExtension(
        "@test/ext",
        "2026.02.26.1",
        null,
        "reason",
        "fake-key",
      ),
    UserError,
  );
  assertStringIncludes(error.message, "Could not connect");
});

Deno.test("ExtensionApiClient version-scoped methods URL-encode version path segments", async () => {
  const captured: Record<string, string> = {};
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/yank")) captured.yank = req.url;
    else if (url.pathname.endsWith("/unyank")) captured.unyank = req.url;
    else if (url.pathname.endsWith("/download")) {
      captured.download = req.url;
      return new Response(null, {
        status: 302,
        headers: { location: "https://example.com/archive.tar.gz" },
      });
    } else if (url.pathname.endsWith("/checksum")) {
      captured.checksum = req.url;
      return new Response(
        JSON.stringify({ checksum: "abc123" }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ message: "ok" }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const addr = server.addr;
  const client = new ExtensionApiClient(`http://localhost:${addr.port}`);

  // A version containing characters that would corrupt the URL if spliced raw:
  // `?` would start a query string, `#` would truncate the path, `/` would
  // create an extra path segment. Real CalVer inputs never contain these, but
  // every adapter that accepts a version must encode defensively.
  const hostileVersion = "2026.02.26.1?foo#bar/baz";
  const encoded = encodeURIComponent(hostileVersion);
  const expectedBase = `/api/v1/extensions/%40test%2Fext@${encoded}`;

  try {
    await client.yankExtension(
      "@test/ext",
      hostileVersion,
      null,
      "reason",
      "key",
    );
    const yankUrl = new URL(captured.yank);
    assertEquals(yankUrl.pathname, `${expectedBase}/yank`);
    assertEquals(yankUrl.search, "");

    await client.unyankExtension(
      "@test/ext",
      hostileVersion,
      null,
      null,
      "key",
    );
    const unyankUrl = new URL(captured.unyank);
    assertEquals(unyankUrl.pathname, `${expectedBase}/unyank`);
    assertEquals(unyankUrl.search, "");

    await client.getDownloadUrl("@test/ext", hostileVersion, "key");
    const downloadUrl = new URL(captured.download);
    assertEquals(downloadUrl.pathname, `${expectedBase}/download`);
    assertEquals(downloadUrl.search, "");

    await client.getChecksum("@test/ext", hostileVersion);
    const checksumUrl = new URL(captured.checksum);
    assertEquals(checksumUrl.pathname, `${expectedBase}/checksum`);
    assertEquals(checksumUrl.search, "");

    await client.getDownloadUrl("@test/ext", hostileVersion, "key", "beta");
    const downloadUrlCh = new URL(captured.download);
    assertEquals(downloadUrlCh.pathname, `${expectedBase}/download`);
    assertEquals(downloadUrlCh.searchParams.get("channel"), "beta");

    await client.getChecksum("@test/ext", hostileVersion, undefined, "rc");
    const checksumUrlCh = new URL(captured.checksum);
    assertEquals(checksumUrlCh.pathname, `${expectedBase}/checksum`);
    assertEquals(checksumUrlCh.searchParams.get("channel"), "rc");
  } finally {
    await server.shutdown();
  }
});

const noSleep = () => Promise.resolve();

Deno.test("ExtensionApiClient: 429 surfaces Retry-After in UserError", async () => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (_req) => {
    return new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "45" },
    });
  });
  try {
    const client = new ExtensionApiClient(
      `http://localhost:${server.addr.port}`,
      {},
      { sleep: noSleep },
    );
    const err = await assertRejects(
      () => client.getLatestVersion("@test/ext"),
      UserError,
    );
    assertStringIncludes(err.message, "Rate limit exceeded");
    assertStringIncludes(err.message, "Retry in 45s");
    assertStringIncludes(err.message, "swamp auth login");
  } finally {
    await server.shutdown();
  }
});

Deno.test("ExtensionApiClient: 429 on search surfaces sign-in hint", async () => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (_req) => {
    return new Response("rate limited", { status: 429 });
  });
  try {
    const client = new ExtensionApiClient(
      `http://localhost:${server.addr.port}`,
    );
    const err = await assertRejects(
      () => client.searchExtensions({ q: "aws" }),
      UserError,
    );
    assertStringIncludes(err.message, "Rate limit exceeded");
    assertEquals(err.message.includes("Retry in"), false);
    assertStringIncludes(err.message, "swamp auth login");
  } finally {
    await server.shutdown();
  }
});

Deno.test("ExtensionApiClient: 429 on getDownloadUrl is preferred over 404 fallthrough", async () => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (_req) => {
    return new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "10" },
    });
  });
  try {
    const client = new ExtensionApiClient(
      `http://localhost:${server.addr.port}`,
      {},
      { sleep: noSleep },
    );
    const err = await assertRejects(
      () => client.getDownloadUrl("@test/ext", "2026.01.01.1"),
      UserError,
    );
    assertStringIncludes(err.message, "Rate limit exceeded");
    assertStringIncludes(err.message, "Retry in 10s");
  } finally {
    await server.shutdown();
  }
});

Deno.test("ExtensionApiClient: principal-scope 429 with an API key omits the sign-in hint", async () => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (_req) => {
    return Response.json(
      { error: "Rate limit exceeded", scope: "principal" },
      {
        status: 429,
        headers: { "retry-after": "120", "x-ratelimit-scope": "principal" },
      },
    );
  });
  try {
    const client = new ExtensionApiClient(
      `http://localhost:${server.addr.port}`,
      {},
      { sleep: noSleep },
    );
    const err = await assertRejects(
      () => client.getLatestVersion("@test/ext", "collective-token"),
      UserError,
    );
    assertStringIncludes(err.message, "this API key or login");
    assertStringIncludes(err.message, "Retry in 120s");
    assertEquals(err.message.includes("swamp auth login"), false);
  } finally {
    await server.shutdown();
  }
});

Deno.test("ExtensionApiClient: reads the scope from the body when the header is missing", async () => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (_req) => {
    return Response.json(
      { error: "Rate limit exceeded", scope: "global" },
      { status: 429 },
    );
  });
  try {
    const client = new ExtensionApiClient(
      `http://localhost:${server.addr.port}`,
    );
    const err = await assertRejects(
      () => client.searchExtensions({ q: "aws" }),
      UserError,
    );
    assertStringIncludes(err.message, "too many requests");
    assertEquals(err.message.includes("swamp auth login"), false);
  } finally {
    await server.shutdown();
  }
});

Deno.test("ExtensionApiClient: retries a rate-limited GET and returns the later response", async () => {
  let requests = 0;
  const delays: number[] = [];
  const server = Deno.serve({ port: 0, onListen: () => {} }, (_req) => {
    requests++;
    if (requests === 1) {
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "15", "x-ratelimit-scope": "principal" },
      });
    }
    return Response.json({ latestVersion: "2026.09.10.0" });
  });
  try {
    const client = new ExtensionApiClient(
      `http://localhost:${server.addr.port}`,
      {},
      {
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      },
    );
    const latest = await client.getLatestVersion("@swamp/1password", "key");
    assertEquals(latest?.version, "2026.09.10.0");
    assertEquals(requests, 2);
    assertEquals(delays.length, 1);
    assertEquals(delays[0] >= 15_000 && delays[0] < 16_000, true);
  } finally {
    await server.shutdown();
  }
});

Deno.test("ExtensionApiClient: gives up after three rate-limited attempts", async () => {
  let requests = 0;
  const server = Deno.serve({ port: 0, onListen: () => {} }, (_req) => {
    requests++;
    return new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "1", "x-ratelimit-scope": "principal" },
    });
  });
  try {
    const client = new ExtensionApiClient(
      `http://localhost:${server.addr.port}`,
      {},
      { sleep: noSleep },
    );
    await assertRejects(
      () => client.getChecksum("@test/ext", "2026.01.01.1", "key"),
      UserError,
      "this API key or login",
    );
    assertEquals(requests, 3);
  } finally {
    await server.shutdown();
  }
});

Deno.test("ExtensionApiClient: does not retry a rate-limited POST", async () => {
  let requests = 0;
  const server = Deno.serve({ port: 0, onListen: () => {} }, (_req) => {
    requests++;
    return new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "1", "x-ratelimit-scope": "principal" },
    });
  });
  try {
    const client = new ExtensionApiClient(
      `http://localhost:${server.addr.port}`,
      {},
      { sleep: noSleep },
    );
    await assertRejects(
      () => client.yankExtension("@test/ext", null, null, "test", "key"),
      UserError,
      "Rate limit exceeded",
    );
    assertEquals(requests, 1);
  } finally {
    await server.shutdown();
  }
});

// ── Identity header injection ─────────────────────────────────────────

Deno.test("ExtensionApiClient sends both identity headers when constructed with bearerToken and distinctId", async () => {
  const captured: Record<string, string | null> = {};
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    captured.authorization = req.headers.get("authorization");
    captured.distinctId = req.headers.get("swamp-distinct-id");
    return new Response(
      JSON.stringify({
        extensions: [],
        meta: { total: 0, page: 1, perPage: 20 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  try {
    const client = new ExtensionApiClient(
      `http://localhost:${server.addr.port}`,
      { bearerToken: "swamp_test-key", distinctId: "device-uuid-abc" },
    );
    await client.searchExtensions({});
    assertEquals(captured.authorization, "Bearer swamp_test-key");
    assertEquals(captured.distinctId, "device-uuid-abc");
  } finally {
    await server.shutdown();
  }
});

Deno.test("ExtensionApiClient sends only Swamp-Distinct-Id when bearerToken is absent", async () => {
  const captured: Record<string, string | null> = {};
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    captured.authorization = req.headers.get("authorization");
    captured.distinctId = req.headers.get("swamp-distinct-id");
    return new Response(
      JSON.stringify({
        extensions: [],
        meta: { total: 0, page: 1, perPage: 20 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  try {
    const client = new ExtensionApiClient(
      `http://localhost:${server.addr.port}`,
      { distinctId: "device-uuid-xyz" },
    );
    await client.searchExtensions({});
    assertEquals(captured.authorization, null);
    assertEquals(captured.distinctId, "device-uuid-xyz");
  } finally {
    await server.shutdown();
  }
});

Deno.test("ExtensionApiClient sends no identity headers when constructed without identity", async () => {
  const captured: Record<string, string | null> = {};
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    captured.authorization = req.headers.get("authorization");
    captured.distinctId = req.headers.get("swamp-distinct-id");
    return new Response(
      JSON.stringify({
        extensions: [],
        meta: { total: 0, page: 1, perPage: 20 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  try {
    const client = new ExtensionApiClient(
      `http://localhost:${server.addr.port}`,
    );
    await client.searchExtensions({});
    assertEquals(captured.authorization, null);
    assertEquals(captured.distinctId, null);
  } finally {
    await server.shutdown();
  }
});

Deno.test("ExtensionApiClient sends constructor bearer when no caller Authorization is set", async () => {
  // Half (a) of the precedence contract: when nothing on the call sets
  // Authorization, the constructor-supplied bearer goes out.
  const captured: Record<string, string | null> = {};
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    captured.authorization = req.headers.get("authorization");
    return new Response(
      JSON.stringify({
        extensions: [],
        meta: { total: 0, page: 1, perPage: 20 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  try {
    const client = new ExtensionApiClient(
      `http://localhost:${server.addr.port}`,
      { bearerToken: "swamp_only-from-constructor" },
    );
    await client.searchExtensions({});
    assertEquals(captured.authorization, "Bearer swamp_only-from-constructor");
  } finally {
    await server.shutdown();
  }
});

Deno.test("ExtensionApiClient lets caller-supplied x-api-key coexist with constructor identity", async () => {
  // Half (b) of the precedence contract: per-method `apiKey` paths
  // (push/yank/etc.) set their own `x-api-key` header. Constructor
  // identity adds Authorization Bearer + Swamp-Distinct-Id, but the
  // caller's `x-api-key` is preserved unchanged.
  const captured: Record<string, string | null> = {};
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    captured.authorization = req.headers.get("authorization");
    captured.xApiKey = req.headers.get("x-api-key");
    captured.distinctId = req.headers.get("swamp-distinct-id");
    return new Response(
      JSON.stringify({ message: "yanked" }),
      { headers: { "content-type": "application/json" } },
    );
  });
  try {
    const client = new ExtensionApiClient(
      `http://localhost:${server.addr.port}`,
      { bearerToken: "swamp_ctor", distinctId: "device-1" },
    );
    await client.yankExtension(
      "@test/ext",
      "2026.01.01.1",
      null,
      "test reason",
      "swamp_caller-key",
    );
    assertEquals(captured.xApiKey, "swamp_caller-key");
    assertEquals(captured.authorization, "Bearer swamp_ctor");
    assertEquals(captured.distinctId, "device-1");
  } finally {
    await server.shutdown();
  }
});

Deno.test("ExtensionApiClient.downloadArchive does NOT send identity headers to the S3 presigned URL", async () => {
  // Locks in the S3 hop contract: identity headers attach to the
  // swamp-club /download call, but the subsequent fetch of the
  // presigned URL must be bare. Sending identity to S3 breaks the
  // presigned signature and leaks the bearer to S3 access logs.
  const swampClubHeaders: Record<string, string | null> = {};
  const s3Headers: Record<string, string | null> = {};

  const s3Server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    s3Headers.authorization = req.headers.get("authorization");
    s3Headers.distinctId = req.headers.get("swamp-distinct-id");
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      headers: { "content-type": "application/gzip" },
    });
  });
  const s3Addr = s3Server.addr;
  const s3Url = `http://localhost:${s3Addr.port}/presigned-archive.tar.gz`;

  const swampClubServer = Deno.serve(
    { port: 0, onListen: () => {} },
    (req) => {
      swampClubHeaders.authorization = req.headers.get("authorization");
      swampClubHeaders.distinctId = req.headers.get("swamp-distinct-id");
      // /download returns 302 with Location pointing at the presigned URL.
      return new Response(null, {
        status: 302,
        headers: { location: s3Url },
      });
    },
  );

  try {
    const client = new ExtensionApiClient(
      `http://localhost:${swampClubServer.addr.port}`,
      { bearerToken: "swamp_secret-key", distinctId: "device-leak-canary" },
    );
    const bytes = await client.downloadArchive("@test/ext", "2026.01.01.1");
    assertEquals(bytes.length, 4);
    // swamp-club hop carries identity.
    assertEquals(
      swampClubHeaders.authorization,
      "Bearer swamp_secret-key",
    );
    assertEquals(swampClubHeaders.distinctId, "device-leak-canary");
    // S3 hop is bare — no identity, no token leak.
    assertEquals(s3Headers.authorization, null);
    assertEquals(s3Headers.distinctId, null);
  } finally {
    await swampClubServer.shutdown();
    await s3Server.shutdown();
  }
});

Deno.test("ExtensionApiClient.checkResponse surfaces scope-specific 403 message", async () => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (_req) => {
    return new Response(
      JSON.stringify({
        message: "This token requires the extensions:push scope",
      }),
      {
        status: 403,
        headers: { "content-type": "application/json" },
      },
    );
  });
  const addr = server.addr;
  const client = new ExtensionApiClient(`http://localhost:${addr.port}`);
  const error = await assertRejects(
    () => client.getLatestVersion("@test/ext", "fake-key"),
    UserError,
  );
  assertStringIncludes(error.message, "extensions:push");
  assertStringIncludes(error.message, "collective settings");
  assertEquals(error.code, REGISTRY_TOKEN_SCOPE_CODE);
  await server.shutdown();
});

Deno.test("ExtensionApiClient.checkResponse passes through non-scope 403 message", async () => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (_req) => {
    return new Response(
      JSON.stringify({ message: "Forbidden: insufficient permissions" }),
      {
        status: 403,
        headers: { "content-type": "application/json" },
      },
    );
  });
  const addr = server.addr;
  const client = new ExtensionApiClient(`http://localhost:${addr.port}`);
  const error = await assertRejects(
    () => client.getLatestVersion("@test/ext", "fake-key"),
    UserError,
  );
  assertStringIncludes(error.message, "insufficient permissions");
  // The code lets the push tell a refusal from other failures without
  // matching the server's prose.
  assertEquals(error.code, REGISTRY_FORBIDDEN_CODE);
  await server.shutdown();
});

Deno.test("ExtensionApiClient.checkResponse includes URL in error message", async () => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (_req) => {
    return new Response(JSON.stringify({ error: "Invalid path" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  });
  const addr = server.addr;
  const client = new ExtensionApiClient(`http://localhost:${addr.port}`);
  const error = await assertRejects(
    () => client.getChecksum("@hivemq/asdlc-factory", "2026.06.27.1"),
    UserError,
  );
  assertStringIncludes(error.message, "Extension API error (HTTP 400)");
  assertStringIncludes(error.message, "Invalid path");
  assertStringIncludes(error.message, "/api/v1/extensions/");
  await server.shutdown();
});

/**
 * Serves the registry download redirect and the archive body it points to,
 * as the real registry + object store do.
 */
function serveArchive(body: () => BodyInit): Deno.HttpServer<Deno.NetAddr> {
  return Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    if (new URL(req.url).pathname.endsWith("/download")) {
      return new Response(null, {
        status: 302,
        headers: { location: new URL("/blob", req.url).href },
      });
    }
    return new Response(body());
  });
}

Deno.test("ExtensionApiClient.downloadArchive returns the archive bytes under the size limit", async () => {
  const payload = new Uint8Array([0x1F, 0x8B, 1, 2, 3]);
  const server = serveArchive(() => payload);
  try {
    const client = new ExtensionApiClient(
      `http://localhost:${server.addr.port}`,
    );
    assertEquals(
      await client.downloadArchive("@test/ext", "2026.09.29.1"),
      payload,
    );
  } finally {
    await server.shutdown();
  }
});

Deno.test("ExtensionApiClient.downloadArchive refuses a Content-Length over the archive size limit", async () => {
  const server = serveArchive(() =>
    new Uint8Array(MAX_EXTENSION_ARCHIVE_BYTES + 1)
  );
  try {
    const client = new ExtensionApiClient(
      `http://localhost:${server.addr.port}`,
    );
    const error = await assertRejects(
      () => client.downloadArchive("@test/ext", "2026.09.29.1"),
      UserError,
    );
    assertStringIncludes(error.message, "@test/ext@2026.09.29.1");
    assertStringIncludes(error.message, "50 MiB");
  } finally {
    await server.shutdown();
  }
});

Deno.test("ExtensionApiClient.downloadArchive stops reading a body with no Content-Length once it passes the limit", async () => {
  // An endless chunked body: the download can only finish by giving up.
  const chunk = new Uint8Array(1024 * 1024);
  const server = serveArchive(() =>
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
    })
  );
  try {
    const client = new ExtensionApiClient(
      `http://localhost:${server.addr.port}`,
    );
    const error = await assertRejects(
      () => client.downloadArchive("@test/ext", "2026.09.29.1"),
      UserError,
    );
    assertStringIncludes(error.message, "archive size limit");
  } finally {
    await server.shutdown();
  }
});

Deno.test("ExtensionApiClient.listVersions: sends every channel filter and the page, and reads the list back", async () => {
  const seen: URL[] = [];
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    seen.push(new URL(req.url));
    return Response.json({
      versions: [{ version: "2026.09.16.1", channel: "rc", publishedAt: "" }],
      meta: { total: 1, page: 2, perPage: 100 },
    });
  });
  try {
    const client = new ExtensionApiClient(
      `http://localhost:${server.addr.port}`,
    );
    const result = await client.listVersions("@test/ext", {
      channel: ["stable", "rc", "beta"],
      perPage: 100,
      page: 2,
    }, "test-key");
    assertEquals(result.versions[0].channel, "rc");
    assertEquals(result.meta.total, 1);
    assertEquals(seen[0].pathname, "/api/v1/extensions/%40test%2Fext/versions");
    assertEquals(seen[0].searchParams.getAll("channel"), [
      "stable",
      "rc",
      "beta",
    ]);
    assertEquals(seen[0].searchParams.get("perPage"), "100");
    assertEquals(seen[0].searchParams.get("page"), "2");
  } finally {
    await server.shutdown();
  }
});

Deno.test("ExtensionApiClient.listVersions: an unknown extension lists no versions", async () => {
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    () => new Response("not found", { status: 404 }),
  );
  try {
    const client = new ExtensionApiClient(
      `http://localhost:${server.addr.port}`,
    );
    const result = await client.listVersions("@test/none");
    assertEquals(result.versions, []);
    assertEquals(result.meta.total, 0);
  } finally {
    await server.shutdown();
  }
});

Deno.test("ExtensionApiClient: uses the injected fetch for every request", async () => {
  const urls: string[] = [];
  const client = new ExtensionApiClient("https://registry.test", {}, {
    fetch: (url) => {
      urls.push(String(url));
      return Promise.resolve(new Response("", { status: 404 }));
    },
  });
  assertEquals(await client.getLatestVersion("@test/ext"), null);
  assertEquals(urls, [
    "https://registry.test/api/v1/extensions/%40test%2Fext/latest",
  ]);
});
