import { assertEquals } from "@std/assert";
import { errorResponse, jsonResponse, Router } from "./router.ts";

Deno.test("Router - matches simple static path", () => {
  const router = new Router();
  router.get("/api/test", () => new Response("ok"));

  const request = new Request("http://localhost/api/test");
  const match = router.match(request);

  assertEquals(match !== null, true);
  assertEquals(match?.params, {});
});

Deno.test("Router - matches path with single parameter", () => {
  const router = new Router();
  router.get("/api/models/:type", () => new Response("ok"));

  const request = new Request("http://localhost/api/models/aws-ec2-instance");
  const match = router.match(request);

  assertEquals(match !== null, true);
  assertEquals(match?.params, { type: "aws-ec2-instance" });
});

Deno.test("Router - matches path with multiple parameters", () => {
  const router = new Router();
  router.get("/api/models/:type/:id", () => new Response("ok"));

  const request = new Request("http://localhost/api/models/echo/test-123");
  const match = router.match(request);

  assertEquals(match !== null, true);
  assertEquals(match?.params, { type: "echo", id: "test-123" });
});

Deno.test("Router - matches wildcard path", () => {
  const router = new Router();
  router.get("/*", () => new Response("ok"));

  const request = new Request("http://localhost/any/path/here");
  const match = router.match(request);

  assertEquals(match !== null, true);
});

Deno.test("Router - returns null for non-matching path", () => {
  const router = new Router();
  router.get("/api/test", () => new Response("ok"));

  const request = new Request("http://localhost/api/other");
  const match = router.match(request);

  assertEquals(match, null);
});

Deno.test("Router - distinguishes HTTP methods", () => {
  const router = new Router();
  router.get("/api/test", () => new Response("GET"));
  router.post("/api/test", () => new Response("POST"));

  const getRequest = new Request("http://localhost/api/test", {
    method: "GET",
  });
  const postRequest = new Request("http://localhost/api/test", {
    method: "POST",
  });

  const getMatch = router.match(getRequest);
  const postMatch = router.match(postRequest);

  assertEquals(getMatch !== null, true);
  assertEquals(postMatch !== null, true);
});

Deno.test("Router - handle returns 404 for unmatched route", async () => {
  const router = new Router();
  router.get("/api/test", () => new Response("ok"));

  const request = new Request("http://localhost/api/other");
  const response = await router.handle(request);

  assertEquals(response.status, 404);
});

Deno.test("Router - handle invokes matched handler", async () => {
  const router = new Router();
  router.get("/api/test", () => new Response("success", { status: 200 }));

  const request = new Request("http://localhost/api/test");
  const response = await router.handle(request);

  assertEquals(response.status, 200);
  assertEquals(await response.text(), "success");
});

Deno.test("Router - all HTTP method helpers work", () => {
  const router = new Router();
  const handler = () => new Response("ok");

  router.get("/get", handler);
  router.post("/post", handler);
  router.put("/put", handler);
  router.patch("/patch", handler);
  router.delete("/delete", handler);
  router.options("/options", handler);

  assertEquals(
    router.match(new Request("http://localhost/get", { method: "GET" })) !==
      null,
    true,
  );
  assertEquals(
    router.match(new Request("http://localhost/post", { method: "POST" })) !==
      null,
    true,
  );
  assertEquals(
    router.match(new Request("http://localhost/put", { method: "PUT" })) !==
      null,
    true,
  );
  assertEquals(
    router.match(new Request("http://localhost/patch", { method: "PATCH" })) !==
      null,
    true,
  );
  assertEquals(
    router.match(
      new Request("http://localhost/delete", { method: "DELETE" }),
    ) !==
      null,
    true,
  );
  assertEquals(
    router.match(
      new Request("http://localhost/options", { method: "OPTIONS" }),
    ) !== null,
    true,
  );
});

Deno.test("jsonResponse creates JSON response with correct headers", async () => {
  const data = { foo: "bar" };
  const response = jsonResponse(data);

  assertEquals(response.status, 200);
  assertEquals(response.headers.get("Content-Type"), "application/json");
  assertEquals(await response.json(), data);
});

Deno.test("jsonResponse accepts custom status code", () => {
  const response = jsonResponse({ created: true }, 201);
  assertEquals(response.status, 201);
});

Deno.test("jsonResponse accepts custom headers", () => {
  const response = jsonResponse({}, 200, { "X-Custom": "value" });
  assertEquals(response.headers.get("X-Custom"), "value");
});

Deno.test("errorResponse creates error JSON response", async () => {
  const response = errorResponse("Something went wrong", 400);

  assertEquals(response.status, 400);
  assertEquals(response.headers.get("Content-Type"), "application/json");
  assertEquals(await response.json(), { error: "Something went wrong" });
});

Deno.test("errorResponse defaults to 500 status", () => {
  const response = errorResponse("Internal error");
  assertEquals(response.status, 500);
});
