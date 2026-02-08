import { assertEquals, assertStringIncludes } from "@std/assert";
import { createStaticHandler } from "./static_handler.ts";
import { join } from "@std/path";

// Use a temporary directory for testing
const testDir = await Deno.makeTempDir();

// Create test files
await Deno.writeTextFile(join(testDir, "index.html"), "<html>index</html>");
await Deno.writeTextFile(join(testDir, "test.js"), "console.log('test');");
await Deno.writeTextFile(join(testDir, "style.css"), "body { color: red; }");
await Deno.mkdir(join(testDir, "subdir"));
await Deno.writeTextFile(
  join(testDir, "subdir", "nested.html"),
  "<html>nested</html>",
);

Deno.test("static handler serves existing file", async () => {
  const handler = createStaticHandler(testDir);
  const request = new Request("http://localhost/test.js");
  const response = await handler.serveStatic({ request, params: {} });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get("Content-Type"), "application/javascript");
  assertStringIncludes(await response.text(), "console.log");
});

Deno.test("static handler serves CSS with correct content type", async () => {
  const handler = createStaticHandler(testDir);
  const request = new Request("http://localhost/style.css");
  const response = await handler.serveStatic({ request, params: {} });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get("Content-Type"), "text/css");
});

Deno.test("static handler serves nested files", async () => {
  const handler = createStaticHandler(testDir);
  const request = new Request("http://localhost/subdir/nested.html");
  const response = await handler.serveStatic({ request, params: {} });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get("Content-Type"), "text/html");
  assertStringIncludes(await response.text(), "nested");
});

Deno.test("static handler falls back to index.html for SPA routes", async () => {
  const handler = createStaticHandler(testDir);
  const request = new Request("http://localhost/some/spa/route");
  const response = await handler.serveStatic({ request, params: {} });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get("Content-Type"), "text/html");
  assertStringIncludes(await response.text(), "index");
});

Deno.test("static handler returns 404 for api routes", async () => {
  const handler = createStaticHandler(testDir);
  const request = new Request("http://localhost/api/v1/models");
  const response = await handler.serveStatic({ request, params: {} });

  assertEquals(response.status, 404);
});

Deno.test("static handler sets cache-control for assets", async () => {
  const handler = createStaticHandler(testDir);
  const request = new Request("http://localhost/test.js");
  const response = await handler.serveStatic({ request, params: {} });

  assertEquals(
    response.headers.get("Cache-Control"),
    "public, max-age=31536000",
  );
});

Deno.test("static handler sets no-cache for HTML", async () => {
  const handler = createStaticHandler(testDir);
  const request = new Request("http://localhost/index.html");
  const response = await handler.serveStatic({ request, params: {} });

  assertEquals(response.headers.get("Cache-Control"), "no-cache");
});

// Cleanup
Deno.test({
  name: "cleanup temp directory",
  fn: async () => {
    await Deno.remove(testDir, { recursive: true });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
