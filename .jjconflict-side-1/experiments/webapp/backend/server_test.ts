import { assertEquals } from "@std/assert";
import { getLogger } from "@logtape/logtape";
import { createServer, HttpServer } from "./server.ts";
import { initializeLogging } from "../../../src/infrastructure/logging/logger.ts";

// Initialize logging for tests
await initializeLogging({});

const testLogger = getLogger(["test"]);

Deno.test("createServer returns HttpServer instance", () => {
  const server = createServer({
    port: 8080,
    host: "localhost",
    logger: testLogger,
  });

  assertEquals(server instanceof HttpServer, true);
});

Deno.test("HttpServer - can add routes via convenience methods", () => {
  const server = createServer({
    port: 8080,
    host: "localhost",
    logger: testLogger,
  });

  const handler = () => new Response("ok");

  // All methods should return this for chaining
  const result = server.get("/get", handler);
  assertEquals(result, server);

  server.post("/post", handler);
  server.put("/put", handler);
  server.patch("/patch", handler);
  server.delete("/delete", handler);
  server.options("/options", handler);

  // Verify routes are registered on underlying router
  const router = server.getRouter();
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
});

Deno.test("HttpServer - can add middleware", () => {
  const server = createServer({
    port: 8080,
    host: "localhost",
    logger: testLogger,
  });

  const middleware = async (_req: Request, next: () => Promise<Response>) => {
    return await next();
  };

  const result = server.use(middleware);
  assertEquals(result, server);
});

Deno.test("HttpServer - getRouter returns Router instance", () => {
  const server = createServer({
    port: 8080,
    host: "localhost",
    logger: testLogger,
  });

  const router = server.getRouter();
  assertEquals(typeof router.get, "function");
  assertEquals(typeof router.post, "function");
  assertEquals(typeof router.match, "function");
});

Deno.test("HttpServer - stop is callable without starting", () => {
  const server = createServer({
    port: 8080,
    host: "localhost",
    logger: testLogger,
  });

  // Should not throw even if server hasn't started
  server.stop();
});
