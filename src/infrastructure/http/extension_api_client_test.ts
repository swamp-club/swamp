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
  assertEquals(JSON.parse(capturedBody).reason, "Security vulnerability");
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
    () => client.yankExtension("@test/ext", null, "reason", "swamp_fake-key"),
    UserError,
  );
  assertStringIncludes(error.message, "already yanked");
  await server.shutdown();
});

Deno.test("ExtensionApiClient.yankExtension throws UserError on connection failure", async () => {
  const client = new ExtensionApiClient("http://localhost:1");
  const error = await assertRejects(
    () =>
      client.yankExtension(
        "@test/ext",
        "2026.02.26.1",
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
    "swamp_fake-key",
  );
  assertEquals(capturedBody, "");
  assertEquals(capturedContentType, null);
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
    () => client.unyankExtension("@test/ext", null, null, "swamp_fake-key"),
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
    () => client.unyankExtension("@test/ext", null, null, "swamp_fake-key"),
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
    await client.yankExtension("@test/ext", hostileVersion, "reason", "key");
    const yankUrl = new URL(captured.yank);
    assertEquals(yankUrl.pathname, `${expectedBase}/yank`);
    assertEquals(yankUrl.search, "");

    await client.unyankExtension("@test/ext", hostileVersion, null, "key");
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
  } finally {
    await server.shutdown();
  }
});

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
