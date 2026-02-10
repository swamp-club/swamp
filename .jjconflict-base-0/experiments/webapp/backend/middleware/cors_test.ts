import { assertEquals } from "@std/assert";
import { cors } from "./cors.ts";

Deno.test("cors - handles OPTIONS preflight with default config", async () => {
  const middleware = cors();
  const request = new Request("http://localhost/api/test", {
    method: "OPTIONS",
    headers: { Origin: "http://example.com" },
  });

  const response = await middleware(
    request,
    () => Promise.resolve(new Response("ok")),
  );

  assertEquals(response.status, 204);
  assertEquals(response.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(
    response.headers.get("Access-Control-Allow-Methods"),
    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  assertEquals(
    response.headers.get("Access-Control-Allow-Headers"),
    "Content-Type, Authorization",
  );
});

Deno.test("cors - adds CORS headers to regular response", async () => {
  const middleware = cors();
  const request = new Request("http://localhost/api/test", {
    method: "GET",
    headers: { Origin: "http://example.com" },
  });

  const response = await middleware(
    request,
    () => Promise.resolve(new Response("ok", { status: 200 })),
  );

  assertEquals(response.status, 200);
  assertEquals(response.headers.get("Access-Control-Allow-Origin"), "*");
});

Deno.test("cors - respects custom origins config", async () => {
  const middleware = cors({ origins: ["http://allowed.com"] });
  const request = new Request("http://localhost/api/test", {
    method: "OPTIONS",
    headers: { Origin: "http://allowed.com" },
  });

  const response = await middleware(
    request,
    () => Promise.resolve(new Response("ok")),
  );

  assertEquals(response.status, 204);
  assertEquals(
    response.headers.get("Access-Control-Allow-Origin"),
    "http://allowed.com",
  );
  assertEquals(response.headers.get("Vary"), "Origin");
});

Deno.test("cors - rejects OPTIONS from disallowed origin", async () => {
  const middleware = cors({ origins: ["http://allowed.com"] });
  const request = new Request("http://localhost/api/test", {
    method: "OPTIONS",
    headers: { Origin: "http://notallowed.com" },
  });

  const response = await middleware(
    request,
    () => Promise.resolve(new Response("ok")),
  );

  assertEquals(response.status, 403);
});

Deno.test("cors - handles credentials option", async () => {
  const middleware = cors({
    origins: ["http://example.com"],
    credentials: true,
  });
  const request = new Request("http://localhost/api/test", {
    method: "OPTIONS",
    headers: { Origin: "http://example.com" },
  });

  const response = await middleware(
    request,
    () => Promise.resolve(new Response("ok")),
  );

  assertEquals(
    response.headers.get("Access-Control-Allow-Credentials"),
    "true",
  );
});

Deno.test("cors - handles exposeHeaders option", async () => {
  const middleware = cors({ exposeHeaders: ["X-Custom-Header", "X-Another"] });
  const request = new Request("http://localhost/api/test", {
    method: "GET",
    headers: { Origin: "http://example.com" },
  });

  const response = await middleware(
    request,
    () => Promise.resolve(new Response("ok")),
  );

  assertEquals(
    response.headers.get("Access-Control-Expose-Headers"),
    "X-Custom-Header, X-Another",
  );
});

Deno.test("cors - handles maxAge option", async () => {
  const middleware = cors({ maxAge: 3600 });
  const request = new Request("http://localhost/api/test", {
    method: "OPTIONS",
    headers: { Origin: "http://example.com" },
  });

  const response = await middleware(
    request,
    () => Promise.resolve(new Response("ok")),
  );

  assertEquals(response.headers.get("Access-Control-Max-Age"), "3600");
});

Deno.test("cors - custom methods config", async () => {
  const middleware = cors({ methods: ["GET", "POST"] });
  const request = new Request("http://localhost/api/test", {
    method: "OPTIONS",
    headers: { Origin: "http://example.com" },
  });

  const response = await middleware(
    request,
    () => Promise.resolve(new Response("ok")),
  );

  assertEquals(
    response.headers.get("Access-Control-Allow-Methods"),
    "GET, POST",
  );
});

Deno.test("cors - custom headers config", async () => {
  const middleware = cors({ headers: ["Content-Type", "X-API-Key"] });
  const request = new Request("http://localhost/api/test", {
    method: "OPTIONS",
    headers: { Origin: "http://example.com" },
  });

  const response = await middleware(
    request,
    () => Promise.resolve(new Response("ok")),
  );

  assertEquals(
    response.headers.get("Access-Control-Allow-Headers"),
    "Content-Type, X-API-Key",
  );
});
