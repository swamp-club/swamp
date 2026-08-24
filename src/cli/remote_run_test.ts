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

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { UserError } from "../domain/errors.ts";
import {
  diagnoseTlsError,
  normalizeServerUrl,
  probeServerHealth,
  requestServerResponse,
  resolveServerToken,
  resolveServeUrl,
  runModelMethodOverServer,
  runWorkflowOverServer,
} from "./remote_run.ts";
import type { ServerCredential } from "../domain/auth/server_credential.ts";
import type { ServerCredentialRepository } from "../domain/auth/server_credential.ts";

/**
 * In-process scripted serve endpoint: the script receives each parsed client
 * request plus a `reply` function and decides what frames come back.
 */
function scriptedServer(
  script: (
    request: { type: string; id: string; payload: Record<string, unknown> },
    reply: (frame: Record<string, unknown>) => void,
    socket: WebSocket,
  ) => void,
): { url: string; shutdown: () => Promise<void>; received: unknown[] } {
  const received: unknown[] = [];
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (event) => {
        const parsed = JSON.parse(event.data as string);
        received.push(parsed);
        script(
          parsed,
          (frame) => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify(frame));
            }
          },
          socket,
        );
      };
      return response;
    },
  );
  return {
    url: `ws://127.0.0.1:${server.addr.port}`,
    shutdown: () => server.shutdown(),
    received,
  };
}

// ── resolveServeUrl tests ──────────────────────────────────────────────

Deno.test("resolveServeUrl: flag value takes precedence over env var", () => {
  const prev = Deno.env.get("SWAMP_SERVE_URL");
  try {
    Deno.env.set("SWAMP_SERVE_URL", "wss://env.example.com");
    assertEquals(
      resolveServeUrl("wss://flag.example.com"),
      "wss://flag.example.com",
    );
  } finally {
    if (prev !== undefined) Deno.env.set("SWAMP_SERVE_URL", prev);
    else Deno.env.delete("SWAMP_SERVE_URL");
  }
});

Deno.test("resolveServeUrl: falls back to SWAMP_SERVE_URL env var", () => {
  const prev = Deno.env.get("SWAMP_SERVE_URL");
  try {
    Deno.env.set("SWAMP_SERVE_URL", "wss://env.example.com");
    assertEquals(resolveServeUrl(undefined), "wss://env.example.com");
  } finally {
    if (prev !== undefined) Deno.env.set("SWAMP_SERVE_URL", prev);
    else Deno.env.delete("SWAMP_SERVE_URL");
  }
});

Deno.test("resolveServeUrl: returns undefined when neither flag nor env var set", () => {
  const prev = Deno.env.get("SWAMP_SERVE_URL");
  try {
    Deno.env.delete("SWAMP_SERVE_URL");
    assertEquals(resolveServeUrl(undefined), undefined);
  } finally {
    if (prev !== undefined) Deno.env.set("SWAMP_SERVE_URL", prev);
  }
});

Deno.test("normalizeServerUrl: accepts ws/wss and maps http/https", () => {
  assertEquals(normalizeServerUrl("ws://h:1"), "ws://h:1/");
  assertEquals(normalizeServerUrl("http://h:1"), "ws://h:1/");
  assertEquals(normalizeServerUrl("https://h:1"), "wss://h:1/");
  assertThrows(() => normalizeServerUrl("ftp://h"), UserError);
  assertThrows(() => normalizeServerUrl("not a url"), UserError);
});

Deno.test({
  name:
    "remote run: streams events until the done frame and sends the right payload",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = scriptedServer((request, reply) => {
      reply({
        type: "event",
        id: request.id,
        event: { kind: "started", workflowName: "wf" },
      });
      reply({
        type: "event",
        id: request.id,
        event: { kind: "completed", status: "succeeded" },
      });
      reply({ type: "done", id: request.id });
    });
    try {
      const events: string[] = [];
      for await (
        const event of runWorkflowOverServer({
          server: server.url,
          payload: {
            workflowIdOrName: "wf",
            inputs: { env: "prod" },
            lastEvaluated: false,
          },
        })
      ) {
        events.push(event.kind);
      }
      assertEquals(events, ["started", "completed"]);
      const sent = server.received[0] as {
        type: string;
        payload: Record<string, unknown>;
      };
      assertEquals(sent.type, "workflow.run");
      assertEquals(sent.payload.workflowIdOrName, "wf");
      assertEquals(sent.payload.inputs, { env: "prod" });
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "remote run: an error frame becomes a UserError with the server's code",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = scriptedServer((request, reply) => {
      reply({
        type: "error",
        id: request.id,
        error: {
          code: "workflow_execution_failed",
          message: "no such workflow",
        },
      });
    });
    try {
      const error = await assertRejects(async () => {
        for await (
          const _ of runModelMethodOverServer({
            server: server.url,
            payload: { modelIdOrName: "m", methodName: "run" },
          })
          // deno-lint-ignore no-empty
        ) {}
      }, UserError);
      assertStringIncludes(error.message, "workflow_execution_failed");
      assertStringIncludes(error.message, "no such workflow");
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "remote run: premature socket close is a loud failure, not success",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = scriptedServer((request, reply, socket) => {
      reply({
        type: "event",
        id: request.id,
        event: { kind: "started", workflowName: "wf" },
      });
      socket.close();
    });
    try {
      const error = await assertRejects(async () => {
        for await (
          const _ of runWorkflowOverServer({
            server: server.url,
            payload: { workflowIdOrName: "wf" },
          })
          // deno-lint-ignore no-empty
        ) {}
      }, UserError);
      assertStringIncludes(error.message, "closed before the run completed");
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "remote run: abort sends cancel and settles as AbortError on the server's confirmation",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = scriptedServer((request, reply) => {
      if (request.type === "cancel") {
        reply({
          type: "error",
          id: request.id,
          error: { code: "cancelled", message: "Operation was cancelled" },
        });
        return;
      }
      reply({
        type: "event",
        id: request.id,
        event: { kind: "started", workflowName: "wf" },
      });
      // Then hang until cancelled.
    });
    try {
      const controller = new AbortController();
      const error = await assertRejects(async () => {
        for await (
          const event of runWorkflowOverServer({
            server: server.url,
            signal: controller.signal,
            payload: { workflowIdOrName: "wf" },
          })
        ) {
          if (event.kind === "started") {
            controller.abort();
          }
        }
      }, DOMException);
      assertEquals(error.name, "AbortError");
      const types = server.received.map((r) => (r as { type: string }).type);
      assertEquals(types, ["workflow.run", "cancel"]);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "remote run: connection refused fails with an actionable error",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await assertRejects(async () => {
      for await (
        const _ of runWorkflowOverServer({
          // Port 1 is never listening.
          server: "ws://127.0.0.1:1",
          payload: { workflowIdOrName: "wf" },
        })
        // deno-lint-ignore no-empty
      ) {}
    }, UserError);
  },
});

// ── requestServerResponse tests ──────────────────────────────────────

Deno.test({
  name: "requestServerResponse: returns payload from a single response frame",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = scriptedServer((request, reply) => {
      reply({
        type: "access.grant.list",
        id: request.id,
        payload: { grants: [{ id: "g1" }] },
      });
    });
    try {
      const result = await requestServerResponse<{ grants: unknown[] }>(
        { server: server.url },
        { type: "access.grant.list" },
      );
      assertEquals(result.grants.length, 1);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "requestServerResponse: rejects with UserError on server error frame",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = scriptedServer((request, reply) => {
      reply({
        type: "error",
        id: request.id,
        error: { code: "test_error", message: "something broke" },
      });
    });
    try {
      await assertRejects(
        () =>
          requestServerResponse(
            { server: server.url },
            { type: "access.reload" },
          ),
        UserError,
        "test_error",
      );
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "requestServerResponse: rejects on timeout",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = scriptedServer((_request, _reply) => {
      // Intentionally never reply
    });
    try {
      await assertRejects(
        () =>
          requestServerResponse(
            { server: server.url, timeoutMs: 200 },
            { type: "access.reload" },
          ),
        UserError,
        "timed out",
      );
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "requestServerResponse: rejects on premature socket close",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = scriptedServer((_request, _reply, socket) => {
      socket.close();
    });
    try {
      await assertRejects(
        () =>
          requestServerResponse(
            { server: server.url },
            { type: "access.reload" },
          ),
        UserError,
        "closed before",
      );
    } finally {
      await server.shutdown();
    }
  },
});

// ── resolveServerToken tests ────────────────────────────────────────────

Deno.test("resolveServerToken: explicit token takes precedence", async () => {
  const result = await resolveServerToken(
    "http://localhost:9090",
    "explicit.token",
  );
  assertEquals(result, "explicit.token");
});

Deno.test("resolveServerToken: falls back to credential repo", async () => {
  const mockRepo: ServerCredentialRepository = {
    get: (url: string): Promise<ServerCredential | null> => {
      if (url.includes("localhost")) {
        return Promise.resolve({
          serverUrl: url,
          tokenName: "stored",
          token: "stored.credential",
          principalId: "user:test",
          obtainedAt: "2026-06-18T00:00:00Z",
        });
      }
      return Promise.resolve(null);
    },
    save: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    list: () => Promise.resolve([]),
  };

  const result = await resolveServerToken(
    "http://localhost:9090",
    undefined,
    mockRepo,
  );
  assertEquals(result, "stored.credential");
});

Deno.test("resolveServerToken: converts ws URL to http for credential lookup", async () => {
  const mockRepo: ServerCredentialRepository = {
    get: (url: string): Promise<ServerCredential | null> => {
      if (url === "http://localhost:9090") {
        return Promise.resolve({
          serverUrl: url,
          tokenName: "stored",
          token: "stored.ws-lookup",
          principalId: "user:test",
          obtainedAt: "2026-06-18T00:00:00Z",
        });
      }
      return Promise.resolve(null);
    },
    save: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    list: () => Promise.resolve([]),
  };

  const result = await resolveServerToken(
    "ws://localhost:9090",
    undefined,
    mockRepo,
  );
  assertEquals(result, "stored.ws-lookup");
});

// ── extra headers tests ────────────────────────────────────────────────

function headerCapturingServer(): {
  url: string;
  shutdown: () => Promise<void>;
  capturedHeaders: () => Headers;
} {
  let captured: Headers = new Headers();
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      captured = new Headers(req.headers);
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (event) => {
        const parsed = JSON.parse(event.data as string);
        socket.send(
          JSON.stringify({
            type: "done",
            id: parsed.id,
          }),
        );
      };
      return response;
    },
  );
  return {
    url: `ws://127.0.0.1:${server.addr.port}`,
    shutdown: () => server.shutdown(),
    capturedHeaders: () => captured,
  };
}

Deno.test({
  name: "remote run: sends extra headers from options on WebSocket upgrade",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = headerCapturingServer();
    try {
      for await (
        const _ of runWorkflowOverServer({
          server: server.url,
          headers: { "X-Tunnel-Token": "secret123", "X-Proxy-Auth": "pass" },
          payload: { workflowIdOrName: "wf" },
        })
        // deno-lint-ignore no-empty
      ) {}
      assertEquals(
        server.capturedHeaders().get("x-tunnel-token"),
        "secret123",
      );
      assertEquals(server.capturedHeaders().get("x-proxy-auth"), "pass");
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "requestServerResponse: sends extra headers from options on WebSocket upgrade",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    let captured: Headers = new Headers();
    const server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      (req) => {
        captured = new Headers(req.headers);
        const { socket, response } = Deno.upgradeWebSocket(req);
        socket.onmessage = (event) => {
          const parsed = JSON.parse(event.data as string);
          socket.send(JSON.stringify({
            type: "test.response",
            id: parsed.id,
            payload: { ok: true },
          }));
        };
        return response;
      },
    );
    const url = `ws://127.0.0.1:${server.addr.port}`;
    try {
      await requestServerResponse<Record<string, unknown>>(
        { server: url, headers: { "X-Custom": "val" } },
        { type: "test" },
      );
      assertEquals(captured.get("x-custom"), "val");
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "remote run: resolves extra headers from SWAMP_SERVE_EXTRA_HEADERS env var",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = headerCapturingServer();
    const prev = Deno.env.get("SWAMP_SERVE_EXTRA_HEADERS");
    try {
      Deno.env.set("SWAMP_SERVE_EXTRA_HEADERS", "X-From-Env: envvalue");
      for await (
        const _ of runWorkflowOverServer({
          server: server.url,
          payload: { workflowIdOrName: "wf" },
        })
        // deno-lint-ignore no-empty
      ) {}
      assertEquals(server.capturedHeaders().get("x-from-env"), "envvalue");
    } finally {
      if (prev !== undefined) Deno.env.set("SWAMP_SERVE_EXTRA_HEADERS", prev);
      else Deno.env.delete("SWAMP_SERVE_EXTRA_HEADERS");
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "remote run: explicit headers option takes precedence over env var",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = headerCapturingServer();
    const prev = Deno.env.get("SWAMP_SERVE_EXTRA_HEADERS");
    try {
      Deno.env.set("SWAMP_SERVE_EXTRA_HEADERS", "X-Env: should-not-appear");
      for await (
        const _ of runWorkflowOverServer({
          server: server.url,
          headers: { "X-Explicit": "wins" },
          payload: { workflowIdOrName: "wf" },
        })
        // deno-lint-ignore no-empty
      ) {}
      assertEquals(server.capturedHeaders().get("x-explicit"), "wins");
      assertEquals(server.capturedHeaders().get("x-env"), null);
    } finally {
      if (prev !== undefined) Deno.env.set("SWAMP_SERVE_EXTRA_HEADERS", prev);
      else Deno.env.delete("SWAMP_SERVE_EXTRA_HEADERS");
      await server.shutdown();
    }
  },
});

Deno.test("resolveServerToken: returns undefined when no credential", async () => {
  const emptyRepo: ServerCredentialRepository = {
    get: () => Promise.resolve(null),
    save: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    list: () => Promise.resolve([]),
  };

  const result = await resolveServerToken(
    "http://unknown:9090",
    undefined,
    emptyRepo,
  );
  assertEquals(result, undefined);
});

// ── auth error classification tests ──────────────────────────────────

/**
 * Server that rejects WebSocket upgrades with 401 but serves a healthy
 * /health endpoint — simulates a swamp serve instance rejecting stale
 * credentials.
 */
function authRejectingServer(
  opts?: { healthBody?: unknown; healthStatus?: number },
): {
  url: string;
  shutdown: () => Promise<void>;
} {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      if (req.headers.get("upgrade") === "websocket") {
        return new Response("Unauthorized", { status: 401 });
      }
      const url = new URL(req.url);
      if (url.pathname === "/health" || url.pathname === "/") {
        return Response.json(
          opts?.healthBody ?? { status: "ok" },
          { status: opts?.healthStatus ?? 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    },
  );
  return {
    url: `ws://127.0.0.1:${server.addr.port}`,
    shutdown: () => server.shutdown(),
  };
}

Deno.test({
  name: "probeServerHealth: returns true for healthy server",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = authRejectingServer();
    try {
      assertEquals(await probeServerHealth(server.url), true);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "probeServerHealth: returns false for unreachable server",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    assertEquals(await probeServerHealth("ws://127.0.0.1:1"), false);
  },
});

Deno.test({
  name:
    "probeServerHealth: returns false when response body is not valid health JSON",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = authRejectingServer({ healthBody: { status: "degraded" } });
    try {
      assertEquals(await probeServerHealth(server.url), false);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "remote run: auth rejection shows authentication error when server is healthy",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = authRejectingServer();
    try {
      const error = await assertRejects(async () => {
        for await (
          const _ of runWorkflowOverServer({
            server: server.url,
            payload: { workflowIdOrName: "wf" },
          })
          // deno-lint-ignore no-empty
        ) {}
      }, UserError);
      assertStringIncludes(error.message, "Authentication failed");
      assertStringIncludes(error.message, "swamp auth server-login");
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "requestServerResponse: auth rejection shows authentication error when server is healthy",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = authRejectingServer();
    try {
      const error = await assertRejects(
        () =>
          requestServerResponse(
            { server: server.url },
            { type: "access.grant.list" },
          ),
        UserError,
      );
      assertStringIncludes(error.message, "Authentication failed");
      assertStringIncludes(error.message, "swamp auth server-login");
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "remote run: connection refused preserves original error when server is unreachable",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const error = await assertRejects(async () => {
      for await (
        const _ of runWorkflowOverServer({
          server: "ws://127.0.0.1:1",
          payload: { workflowIdOrName: "wf" },
        })
        // deno-lint-ignore no-empty
      ) {}
    }, UserError);
    assertStringIncludes(error.message, "Could not connect to");
  },
});

// ── rate-limit error classification tests ────────────────────────────

function rateLimitingServer(): {
  url: string;
  shutdown: () => Promise<void>;
} {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      if (req.headers.get("upgrade") === "websocket") {
        return new Response("Too Many Requests", { status: 429 });
      }
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return Response.json({ status: "ok" });
      }
      return new Response("Not found", { status: 404 });
    },
  );
  return {
    url: `ws://127.0.0.1:${server.addr.port}`,
    shutdown: () => server.shutdown(),
  };
}

Deno.test({
  name:
    "remote run: rate-limited WebSocket upgrade shows rate-limit error, not auth failure",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = rateLimitingServer();
    try {
      const error = await assertRejects(async () => {
        for await (
          const _ of runWorkflowOverServer({
            server: server.url,
            payload: { workflowIdOrName: "wf" },
          })
          // deno-lint-ignore no-empty
        ) {}
      }, UserError);
      assertStringIncludes(error.message, "Rate-limited");
      assertEquals(error.message.includes("Authentication failed"), false);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "requestServerResponse: rate-limited WebSocket upgrade shows rate-limit error, not auth failure",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = rateLimitingServer();
    try {
      const error = await assertRejects(
        () =>
          requestServerResponse(
            { server: server.url },
            { type: "test.request" },
          ),
        UserError,
      );
      assertStringIncludes(error.message, "Rate-limited");
      assertEquals(error.message.includes("Authentication failed"), false);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "remote run: auth rejection still shows authentication error (not rate-limit)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = authRejectingServer();
    try {
      const error = await assertRejects(async () => {
        for await (
          const _ of runWorkflowOverServer({
            server: server.url,
            payload: { workflowIdOrName: "wf" },
          })
          // deno-lint-ignore no-empty
        ) {}
      }, UserError);
      assertStringIncludes(error.message, "Authentication failed");
      assertEquals(error.message.includes("Rate-limited"), false);
    } finally {
      await server.shutdown();
    }
  },
});

// ── cross-instance reconnection tests ─────────────────────────────────

Deno.test({
  name:
    "remote run: reconnects and sends run.attach after socket drop with known runId",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    let connectionCount = 0;
    const server = scriptedServer((request, reply, socket) => {
      connectionCount++;
      if (request.type === "workflow.run") {
        reply({
          type: "event",
          id: request.id,
          event: {
            kind: "started",
            runId: "run-123",
            workflowName: "wf",
            seq: 1,
          },
        });
        reply({
          type: "event",
          id: request.id,
          event: { kind: "job_started", jobName: "job1", seq: 2 },
        });
        setTimeout(() => socket.close(), 20);
      } else if (request.type === "run.attach") {
        reply({
          type: "run.attached",
          id: request.id,
          payload: {
            runId: "run-123",
            kind: "workflow-run",
            startedAt: "2026-08-01T00:00:00Z",
          },
        });
        reply({
          type: "event",
          id: request.id,
          event: { kind: "completed", status: "succeeded", seq: 3 },
        });
        reply({ type: "done", id: request.id });
      }
    });
    try {
      const events: string[] = [];
      for await (
        const event of runWorkflowOverServer({
          server: server.url,
          payload: { workflowIdOrName: "wf" },
        })
      ) {
        events.push(event.kind);
      }
      assertEquals(events, ["started", "job_started", "completed"]);
      assertEquals(connectionCount >= 2, true);
      const attachReq = server.received.find(
        (r) => (r as { type: string }).type === "run.attach",
      ) as { type: string; payload: { runId: string; afterSeq: number } };
      assertEquals(attachReq.payload.runId, "run-123");
      assertEquals(attachReq.payload.afterSeq, 2);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "remote run: handles run.elsewhere by retrying through load balancer",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    let elsewhereCount = 0;
    const server = scriptedServer((request, reply, socket) => {
      if (request.type === "workflow.run") {
        reply({
          type: "event",
          id: request.id,
          event: {
            kind: "started",
            runId: "run-456",
            workflowName: "wf",
            seq: 1,
          },
        });
        setTimeout(() => socket.close(), 20);
        return;
      }
      if (request.type === "run.attach") {
        elsewhereCount++;
        if (elsewhereCount <= 2) {
          reply({
            type: "run.elsewhere",
            id: request.id,
            payload: { runId: "run-456", instanceId: "instance-other" },
          });
          return;
        }
        reply({
          type: "run.attached",
          id: request.id,
          payload: {
            runId: "run-456",
            kind: "workflow-run",
            startedAt: "2026-08-01T00:00:00Z",
          },
        });
        reply({
          type: "event",
          id: request.id,
          event: { kind: "completed", status: "succeeded", seq: 3 },
        });
        reply({ type: "done", id: request.id });
      }
    });
    try {
      const events: string[] = [];
      for await (
        const event of runWorkflowOverServer({
          server: server.url,
          payload: { workflowIdOrName: "wf" },
        })
      ) {
        events.push(event.kind);
      }
      assertEquals(events, ["started", "completed"]);
      assertEquals(elsewhereCount, 3);
      const attachRequests = server.received.filter(
        (r) => (r as { type: string }).type === "run.attach",
      );
      assertEquals(attachRequests.length, 3);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "remote run: run.interrupted throws UserError with instance details",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = scriptedServer((request, reply, socket) => {
      if (request.type === "workflow.run") {
        reply({
          type: "event",
          id: request.id,
          event: {
            kind: "started",
            runId: "run-dead",
            workflowName: "wf",
            seq: 1,
          },
        });
        setTimeout(() => socket.close(), 20);
      } else if (request.type === "run.attach") {
        reply({
          type: "run.interrupted",
          id: request.id,
          payload: {
            runId: "run-dead",
            instanceId: "dead-instance",
            reason: "instance_dead",
          },
        });
      }
    });
    try {
      const error = await assertRejects(async () => {
        for await (
          const _ of runWorkflowOverServer({
            server: server.url,
            payload: { workflowIdOrName: "wf" },
          })
          // deno-lint-ignore no-empty
        ) {}
      }, UserError);
      assertStringIncludes(error.message, "interrupted");
      assertStringIncludes(error.message, "dead-instance");
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "remote run: does not attempt reconnect when socket drops before runId is known",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = scriptedServer((_request, _reply, socket) => {
      socket.close();
    });
    try {
      const error = await assertRejects(async () => {
        for await (
          const _ of runWorkflowOverServer({
            server: server.url,
            payload: { workflowIdOrName: "wf" },
          })
          // deno-lint-ignore no-empty
        ) {}
      }, UserError);
      assertStringIncludes(error.message, "closed before the run completed");
    } finally {
      await server.shutdown();
    }
  },
});

// ── Token transport tests ─────────────────────────────────────────────

Deno.test({
  name:
    "requestServerResponse: sends token via Authorization header, not query param",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    let capturedUrl: string | undefined;
    let capturedAuthHeader: string | null | undefined;
    const server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      (req) => {
        capturedUrl = req.url;
        capturedAuthHeader = req.headers.get("authorization");
        const { socket, response } = Deno.upgradeWebSocket(req);
        socket.onmessage = (event) => {
          const parsed = JSON.parse(event.data as string);
          socket.send(JSON.stringify({
            type: parsed.type,
            id: parsed.id,
            payload: { ok: true },
          }));
        };
        return response;
      },
    );
    try {
      const url = `ws://127.0.0.1:${server.addr.port}`;
      await requestServerResponse<{ ok: boolean }>(
        { server: url, token: "mytoken.secret" },
        { type: "test" },
      );
      assertEquals(capturedAuthHeader, "Bearer mytoken.secret");
      const parsedUrl = new URL(capturedUrl!);
      assertEquals(parsedUrl.searchParams.has("token"), false);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "requestServerResponse: extra headers passed alongside Authorization",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    let capturedAuthHeader: string | null | undefined;
    let capturedCustomHeader: string | null | undefined;
    const server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      (req) => {
        capturedAuthHeader = req.headers.get("authorization");
        capturedCustomHeader = req.headers.get("x-custom");
        const { socket, response } = Deno.upgradeWebSocket(req);
        socket.onmessage = (event) => {
          const parsed = JSON.parse(event.data as string);
          socket.send(JSON.stringify({
            type: parsed.type,
            id: parsed.id,
            payload: { ok: true },
          }));
        };
        return response;
      },
    );
    try {
      const url = `ws://127.0.0.1:${server.addr.port}`;
      await requestServerResponse<{ ok: boolean }>(
        {
          server: url,
          token: "tok.sec",
          headers: { "X-Custom": "proxy-value" },
        },
        { type: "test" },
      );
      assertEquals(capturedAuthHeader, "Bearer tok.sec");
      assertEquals(capturedCustomHeader, "proxy-value");
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "remote run: reconnect sends Authorization header, not query param token",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const capturedHeaders: (string | null)[] = [];
    const capturedUrls: string[] = [];
    let connectionCount = 0;
    const server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      (req) => {
        capturedHeaders.push(req.headers.get("authorization"));
        capturedUrls.push(req.url);
        connectionCount++;
        const { socket, response } = Deno.upgradeWebSocket(req);
        socket.onmessage = (event) => {
          const parsed = JSON.parse(event.data as string);
          if (parsed.type === "workflow.run") {
            socket.send(JSON.stringify({
              type: "event",
              id: parsed.id,
              event: {
                kind: "started",
                runId: "run-abc",
                workflowName: "wf",
                seq: 1,
              },
            }));
            setTimeout(() => socket.close(), 20);
          } else if (parsed.type === "run.attach") {
            socket.send(JSON.stringify({
              type: "run.attached",
              id: parsed.id,
              payload: {
                runId: "run-abc",
                kind: "workflow-run",
                startedAt: "2026-08-01T00:00:00Z",
              },
            }));
            socket.send(JSON.stringify({
              type: "event",
              id: parsed.id,
              event: { kind: "completed", status: "succeeded", seq: 2 },
            }));
            socket.send(JSON.stringify({ type: "done", id: parsed.id }));
          }
        };
        return response;
      },
    );
    try {
      const url = `ws://127.0.0.1:${server.addr.port}`;
      for await (
        const _ of runWorkflowOverServer({
          server: url,
          token: "tok.reconnect-secret",
          payload: { workflowIdOrName: "wf" },
        })
      ) { /* consume */ }
      assertEquals(connectionCount >= 2, true);
      for (let i = 0; i < capturedHeaders.length; i++) {
        assertEquals(
          capturedHeaders[i],
          "Bearer tok.reconnect-secret",
        );
        const parsed = new URL(capturedUrls[i]);
        assertEquals(parsed.searchParams.has("token"), false);
      }
    } finally {
      await server.shutdown();
    }
  },
});

// ── diagnoseTlsError tests ────────────────────────────────────────────

Deno.test({
  name: "diagnoseTlsError: returns undefined for non-wss URLs",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    assertEquals(await diagnoseTlsError("ws://127.0.0.1:9999"), undefined);
  },
});

Deno.test({
  name: "diagnoseTlsError: returns undefined for invalid URL",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    assertEquals(await diagnoseTlsError("not-a-url"), undefined);
  },
});
