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
  createTlsHttpClient,
  diagnoseTlsMessage,
  probeServerHealth,
  readTokenFile,
  requestServerResponse,
  resetMarkerServerAddress,
  resolveServerToken,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  runModelMethodOverServer,
  runWorkflowOverServer,
  setMarkerServerAddress,
  subscribeServerEvents,
  toWebSocketUrl,
  warnServerReloadNeeded,
  writeRemoteIndicator,
} from "./remote_run.ts";
import { gzipSync } from "node:zlib";
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
): {
  url: string;
  shutdown: () => Promise<void>;
  received: unknown[];
  upgradeUrls: string[];
} {
  const received: unknown[] = [];
  const upgradeUrls: string[] = [];
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      upgradeUrls.push(req.url);
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
    upgradeUrls,
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

Deno.test("resolveServeUrl: falls back to SWAMP_SERVER_URL when SWAMP_SERVE_URL is not set", () => {
  const prevServe = Deno.env.get("SWAMP_SERVE_URL");
  const prevServer = Deno.env.get("SWAMP_SERVER_URL");
  try {
    Deno.env.delete("SWAMP_SERVE_URL");
    Deno.env.set("SWAMP_SERVER_URL", "wss://server-env.example.com");
    assertEquals(resolveServeUrl(undefined), "wss://server-env.example.com");
  } finally {
    if (prevServe !== undefined) Deno.env.set("SWAMP_SERVE_URL", prevServe);
    else Deno.env.delete("SWAMP_SERVE_URL");
    if (prevServer !== undefined) Deno.env.set("SWAMP_SERVER_URL", prevServer);
    else Deno.env.delete("SWAMP_SERVER_URL");
  }
});

Deno.test("resolveServeUrl: SWAMP_SERVE_URL takes precedence over SWAMP_SERVER_URL", () => {
  const prevServe = Deno.env.get("SWAMP_SERVE_URL");
  const prevServer = Deno.env.get("SWAMP_SERVER_URL");
  try {
    Deno.env.set("SWAMP_SERVE_URL", "wss://serve.example.com");
    Deno.env.set("SWAMP_SERVER_URL", "wss://server.example.com");
    assertEquals(resolveServeUrl(undefined), "wss://serve.example.com");
  } finally {
    if (prevServe !== undefined) Deno.env.set("SWAMP_SERVE_URL", prevServe);
    else Deno.env.delete("SWAMP_SERVE_URL");
    if (prevServer !== undefined) Deno.env.set("SWAMP_SERVER_URL", prevServer);
    else Deno.env.delete("SWAMP_SERVER_URL");
  }
});

Deno.test("resolveServeUrl: returns undefined when no flag or env var set", () => {
  const prevServe = Deno.env.get("SWAMP_SERVE_URL");
  const prevServer = Deno.env.get("SWAMP_SERVER_URL");
  try {
    Deno.env.delete("SWAMP_SERVE_URL");
    Deno.env.delete("SWAMP_SERVER_URL");
    assertEquals(resolveServeUrl(undefined), undefined);
  } finally {
    if (prevServe !== undefined) Deno.env.set("SWAMP_SERVE_URL", prevServe);
    if (prevServer !== undefined) Deno.env.set("SWAMP_SERVER_URL", prevServer);
  }
});

Deno.test("resolveServeUrl: falls back to markerValue when no flag or env var set", () => {
  const prevServe = Deno.env.get("SWAMP_SERVE_URL");
  const prevServer = Deno.env.get("SWAMP_SERVER_URL");
  try {
    Deno.env.delete("SWAMP_SERVE_URL");
    Deno.env.delete("SWAMP_SERVER_URL");
    assertEquals(
      resolveServeUrl(undefined, "wss://marker.example.com"),
      "wss://marker.example.com",
    );
  } finally {
    if (prevServe !== undefined) Deno.env.set("SWAMP_SERVE_URL", prevServe);
    if (prevServer !== undefined) Deno.env.set("SWAMP_SERVER_URL", prevServer);
  }
});

Deno.test("resolveServeUrl: env var takes precedence over markerValue", () => {
  const prevServe = Deno.env.get("SWAMP_SERVE_URL");
  const prevServer = Deno.env.get("SWAMP_SERVER_URL");
  try {
    Deno.env.set("SWAMP_SERVE_URL", "wss://env.example.com");
    Deno.env.delete("SWAMP_SERVER_URL");
    assertEquals(
      resolveServeUrl(undefined, "wss://marker.example.com"),
      "wss://env.example.com",
    );
  } finally {
    if (prevServe !== undefined) Deno.env.set("SWAMP_SERVE_URL", prevServe);
    else Deno.env.delete("SWAMP_SERVE_URL");
    if (prevServer !== undefined) Deno.env.set("SWAMP_SERVER_URL", prevServer);
    else Deno.env.delete("SWAMP_SERVER_URL");
  }
});

Deno.test("resolveServeUrl: flag takes precedence over markerValue", () => {
  const prevServe = Deno.env.get("SWAMP_SERVE_URL");
  const prevServer = Deno.env.get("SWAMP_SERVER_URL");
  try {
    Deno.env.delete("SWAMP_SERVE_URL");
    Deno.env.delete("SWAMP_SERVER_URL");
    assertEquals(
      resolveServeUrl("wss://flag.example.com", "wss://marker.example.com"),
      "wss://flag.example.com",
    );
  } finally {
    if (prevServe !== undefined) Deno.env.set("SWAMP_SERVE_URL", prevServe);
    if (prevServer !== undefined) Deno.env.set("SWAMP_SERVER_URL", prevServer);
  }
});

Deno.test("resolveServeUrl: returns undefined when no flag, env var, or markerValue", () => {
  const prevServe = Deno.env.get("SWAMP_SERVE_URL");
  const prevServer = Deno.env.get("SWAMP_SERVER_URL");
  try {
    Deno.env.delete("SWAMP_SERVE_URL");
    Deno.env.delete("SWAMP_SERVER_URL");
    assertEquals(resolveServeUrl(undefined, undefined), undefined);
  } finally {
    if (prevServe !== undefined) Deno.env.set("SWAMP_SERVE_URL", prevServe);
    if (prevServer !== undefined) Deno.env.set("SWAMP_SERVER_URL", prevServer);
  }
});

// ── cached marker serverAddress tests ─────────────────────────────────

Deno.test("resolveServeUrl: falls back to cached marker serverAddress", () => {
  const prevServe = Deno.env.get("SWAMP_SERVE_URL");
  const prevServer = Deno.env.get("SWAMP_SERVER_URL");
  try {
    Deno.env.delete("SWAMP_SERVE_URL");
    Deno.env.delete("SWAMP_SERVER_URL");
    setMarkerServerAddress("wss://cached.example.com");
    assertEquals(resolveServeUrl(undefined), "wss://cached.example.com");
  } finally {
    resetMarkerServerAddress();
    if (prevServe !== undefined) Deno.env.set("SWAMP_SERVE_URL", prevServe);
    if (prevServer !== undefined) Deno.env.set("SWAMP_SERVER_URL", prevServer);
  }
});

Deno.test("resolveServeUrl: explicit markerValue takes precedence over cached value", () => {
  const prevServe = Deno.env.get("SWAMP_SERVE_URL");
  const prevServer = Deno.env.get("SWAMP_SERVER_URL");
  try {
    Deno.env.delete("SWAMP_SERVE_URL");
    Deno.env.delete("SWAMP_SERVER_URL");
    setMarkerServerAddress("wss://cached.example.com");
    assertEquals(
      resolveServeUrl(undefined, "wss://explicit.example.com"),
      "wss://explicit.example.com",
    );
  } finally {
    resetMarkerServerAddress();
    if (prevServe !== undefined) Deno.env.set("SWAMP_SERVE_URL", prevServe);
    if (prevServer !== undefined) Deno.env.set("SWAMP_SERVER_URL", prevServer);
  }
});

Deno.test("resolveServeUrl: env var takes precedence over cached marker value", () => {
  const prevServe = Deno.env.get("SWAMP_SERVE_URL");
  const prevServer = Deno.env.get("SWAMP_SERVER_URL");
  try {
    Deno.env.set("SWAMP_SERVE_URL", "wss://env.example.com");
    Deno.env.delete("SWAMP_SERVER_URL");
    setMarkerServerAddress("wss://cached.example.com");
    assertEquals(resolveServeUrl(undefined), "wss://env.example.com");
  } finally {
    resetMarkerServerAddress();
    if (prevServe !== undefined) Deno.env.set("SWAMP_SERVE_URL", prevServe);
    else Deno.env.delete("SWAMP_SERVE_URL");
    if (prevServer !== undefined) Deno.env.set("SWAMP_SERVER_URL", prevServer);
    else Deno.env.delete("SWAMP_SERVER_URL");
  }
});

Deno.test("resolveServeUrl: returns undefined when cache is not set and no other source", () => {
  const prevServe = Deno.env.get("SWAMP_SERVE_URL");
  const prevServer = Deno.env.get("SWAMP_SERVER_URL");
  try {
    Deno.env.delete("SWAMP_SERVE_URL");
    Deno.env.delete("SWAMP_SERVER_URL");
    resetMarkerServerAddress();
    assertEquals(resolveServeUrl(undefined), undefined);
  } finally {
    if (prevServe !== undefined) Deno.env.set("SWAMP_SERVE_URL", prevServe);
    if (prevServer !== undefined) Deno.env.set("SWAMP_SERVER_URL", prevServer);
  }
});

Deno.test("resetMarkerServerAddress: clears the cached value", () => {
  const prevServe = Deno.env.get("SWAMP_SERVE_URL");
  const prevServer = Deno.env.get("SWAMP_SERVER_URL");
  try {
    Deno.env.delete("SWAMP_SERVE_URL");
    Deno.env.delete("SWAMP_SERVER_URL");
    setMarkerServerAddress("wss://cached.example.com");
    assertEquals(resolveServeUrl(undefined), "wss://cached.example.com");
    resetMarkerServerAddress();
    assertEquals(resolveServeUrl(undefined), undefined);
  } finally {
    if (prevServe !== undefined) Deno.env.set("SWAMP_SERVE_URL", prevServe);
    if (prevServer !== undefined) Deno.env.set("SWAMP_SERVER_URL", prevServer);
  }
});

Deno.test("toWebSocketUrl: accepts ws/wss and maps http/https", () => {
  assertEquals(toWebSocketUrl("ws://h:1"), "ws://h:1/");
  assertEquals(toWebSocketUrl("http://h:1"), "ws://h:1/");
  assertEquals(toWebSocketUrl("https://h:1"), "wss://h:1/");
  assertThrows(() => toWebSocketUrl("ftp://h"), UserError);
  assertThrows(() => toWebSocketUrl("not a url"), UserError);
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
  name:
    "requestServerResponse: opts into compression and decodes a gzip binary frame",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const results = Array.from({ length: 50 }, (_, i) => ({ name: `wf-${i}` }));
    const server = scriptedServer((request, _reply, socket) => {
      const json = JSON.stringify({
        type: "workflow.search",
        id: request.id,
        payload: { data: { results } },
      });
      socket.send(gzipSync(new TextEncoder().encode(json)));
    });
    try {
      const result = await requestServerResponse<
        { data: { results: unknown[] } }
      >(
        { server: server.url },
        { type: "workflow.search" },
      );
      assertEquals(result.data.results, results);
      assertEquals(
        new URL(server.upgradeUrls[0]).searchParams.get("compress"),
        "gzip",
      );
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "requestServerResponse: rejects with UserError on an undecodable binary frame",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = scriptedServer((_request, _reply, socket) => {
      socket.send(new Uint8Array([1, 2, 3, 4]));
    });
    try {
      await assertRejects(
        () =>
          requestServerResponse(
            { server: server.url },
            { type: "workflow.search" },
          ),
        UserError,
        "Could not decode a compressed response",
      );
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

Deno.test("resolveServerToken: ws URL is resolved by credential repo normalization", async () => {
  const mockRepo: ServerCredentialRepository = {
    get: (url: string): Promise<ServerCredential | null> => {
      if (url === "ws://localhost:9090") {
        return Promise.resolve({
          serverUrl: "http://localhost:9090",
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

// ── readTokenFile tests ─────────────────────────────────────────────

Deno.test("readTokenFile: reads token and trims trailing newline", async () => {
  const tmpFile = await Deno.makeTempFile({ prefix: "swamp-token-test-" });
  try {
    await Deno.writeTextFile(tmpFile, "pool.secret-value\n");
    const result = await readTokenFile(tmpFile, "--token-file");
    assertEquals(result, "pool.secret-value");
  } finally {
    await Deno.remove(tmpFile).catch(() => {});
  }
});

Deno.test("readTokenFile: throws UserError for missing file", async () => {
  const err = await assertRejects(
    () => readTokenFile("/tmp/swamp-nonexistent-token-file", "--token-file"),
    UserError,
  );
  assertStringIncludes(err.message, "--token-file file not found");
});

Deno.test("readTokenFile: throws UserError for empty file", async () => {
  const tmpFile = await Deno.makeTempFile({ prefix: "swamp-token-test-" });
  try {
    await Deno.writeTextFile(tmpFile, "");
    const err = await assertRejects(
      () => readTokenFile(tmpFile, "--token-file"),
      UserError,
    );
    assertStringIncludes(err.message, "--token-file file is empty");
  } finally {
    await Deno.remove(tmpFile).catch(() => {});
  }
});

// ── resolveServerToken: token-file tests ────────────────────────────

Deno.test("resolveServerToken: reads token from SWAMP_SERVER_TOKEN_FILE env var", async () => {
  const tmpFile = await Deno.makeTempFile({ prefix: "swamp-token-test-" });
  const prev = Deno.env.get("SWAMP_SERVER_TOKEN_FILE");
  try {
    await Deno.writeTextFile(tmpFile, "file.token-value\n");
    Deno.env.set("SWAMP_SERVER_TOKEN_FILE", tmpFile);
    const emptyRepo: ServerCredentialRepository = {
      get: () => Promise.resolve(null),
      save: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      list: () => Promise.resolve([]),
    };
    const result = await resolveServerToken(
      "http://localhost:9090",
      undefined,
      emptyRepo,
    );
    assertEquals(result, "file.token-value");
  } finally {
    if (prev !== undefined) Deno.env.set("SWAMP_SERVER_TOKEN_FILE", prev);
    else Deno.env.delete("SWAMP_SERVER_TOKEN_FILE");
    await Deno.remove(tmpFile).catch(() => {});
  }
});

Deno.test("resolveServerToken: explicit token takes precedence over token file env var", async () => {
  const tmpFile = await Deno.makeTempFile({ prefix: "swamp-token-test-" });
  const prev = Deno.env.get("SWAMP_SERVER_TOKEN_FILE");
  try {
    await Deno.writeTextFile(tmpFile, "file.token\n");
    Deno.env.set("SWAMP_SERVER_TOKEN_FILE", tmpFile);
    const result = await resolveServerToken(
      "http://localhost:9090",
      "explicit.token",
    );
    assertEquals(result, "explicit.token");
  } finally {
    if (prev !== undefined) Deno.env.set("SWAMP_SERVER_TOKEN_FILE", prev);
    else Deno.env.delete("SWAMP_SERVER_TOKEN_FILE");
    await Deno.remove(tmpFile).catch(() => {});
  }
});

Deno.test("resolveServerToken: falls back to credential repo when no token file set", async () => {
  const prev = Deno.env.get("SWAMP_SERVER_TOKEN_FILE");
  try {
    Deno.env.delete("SWAMP_SERVER_TOKEN_FILE");
    const mockRepo: ServerCredentialRepository = {
      get: (): Promise<ServerCredential | null> =>
        Promise.resolve({
          serverUrl: "http://localhost:9090",
          tokenName: "stored",
          token: "stored.credential",
          principalId: "user:test",
          obtainedAt: "2026-06-18T00:00:00Z",
        }),
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
  } finally {
    if (prev !== undefined) Deno.env.set("SWAMP_SERVER_TOKEN_FILE", prev);
    else Deno.env.delete("SWAMP_SERVER_TOKEN_FILE");
  }
});

// ── resolveServerTokenFromOptions tests ──────────────────────────────

Deno.test("resolveServerTokenFromOptions: reads token from options.tokenFile", async () => {
  const tmpFile = await Deno.makeTempFile({ prefix: "swamp-token-test-" });
  const prev = Deno.env.get("SWAMP_SERVER_TOKEN_FILE");
  try {
    Deno.env.delete("SWAMP_SERVER_TOKEN_FILE");
    await Deno.writeTextFile(tmpFile, "file.token-value\n");
    const emptyRepo: ServerCredentialRepository = {
      get: () => Promise.resolve(null),
      save: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      list: () => Promise.resolve([]),
    };
    const result = await resolveServerTokenFromOptions(
      "http://localhost:9090",
      { tokenFile: tmpFile },
      emptyRepo,
    );
    assertEquals(result, "file.token-value");
  } finally {
    if (prev !== undefined) Deno.env.set("SWAMP_SERVER_TOKEN_FILE", prev);
    else Deno.env.delete("SWAMP_SERVER_TOKEN_FILE");
    await Deno.remove(tmpFile).catch(() => {});
  }
});

Deno.test("resolveServerTokenFromOptions: throws when both token and tokenFile provided", async () => {
  const err = await assertRejects(
    () =>
      resolveServerTokenFromOptions(
        "http://localhost:9090",
        { token: "explicit.token", tokenFile: "/some/file" },
      ),
    UserError,
  );
  assertStringIncludes(err.message, "mutually exclusive");
});

Deno.test("resolveServerTokenFromOptions: passes token through when no tokenFile", async () => {
  const prev = Deno.env.get("SWAMP_SERVER_TOKEN_FILE");
  try {
    Deno.env.delete("SWAMP_SERVER_TOKEN_FILE");
    const result = await resolveServerTokenFromOptions(
      "http://localhost:9090",
      { token: "explicit.token" },
    );
    assertEquals(result, "explicit.token");
  } finally {
    if (prev !== undefined) Deno.env.set("SWAMP_SERVER_TOKEN_FILE", prev);
    else Deno.env.delete("SWAMP_SERVER_TOKEN_FILE");
  }
});

Deno.test("resolveServerTokenFromOptions: falls back to env var when no options", async () => {
  const tmpFile = await Deno.makeTempFile({ prefix: "swamp-token-test-" });
  const prev = Deno.env.get("SWAMP_SERVER_TOKEN_FILE");
  try {
    await Deno.writeTextFile(tmpFile, "env-file.token\n");
    Deno.env.set("SWAMP_SERVER_TOKEN_FILE", tmpFile);
    const emptyRepo: ServerCredentialRepository = {
      get: () => Promise.resolve(null),
      save: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      list: () => Promise.resolve([]),
    };
    const result = await resolveServerTokenFromOptions(
      "http://localhost:9090",
      {},
      emptyRepo,
    );
    assertEquals(result, "env-file.token");
  } finally {
    if (prev !== undefined) Deno.env.set("SWAMP_SERVER_TOKEN_FILE", prev);
    else Deno.env.delete("SWAMP_SERVER_TOKEN_FILE");
    await Deno.remove(tmpFile).catch(() => {});
  }
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

// ── createTlsHttpClient tests ─────────────────────────────────────────

Deno.test("createTlsHttpClient: turns a cert-store failure into guidance", () => {
  const error = assertThrows(
    () =>
      createTlsHttpClient({}, () => {
        throw new Error("SecTrustSettingsCopyCertificates failed");
      }),
    UserError,
  );
  assertStringIncludes(error.message, "SecTrustSettingsCopyCertificates");
  assertStringIncludes(error.message, "DENO_TLS_CA_STORE=mozilla");
});

Deno.test("createTlsHttpClient: returns the client when the store loads", () => {
  using client = createTlsHttpClient();
  assertEquals(typeof client.close, "function");
});

// ── diagnoseTlsMessage tests ──────────────────────────────────────────

Deno.test("diagnoseTlsMessage: returns guidance for CaUsedAsEndEntity", () => {
  const result = diagnoseTlsMessage(
    "invalid peer certificate: Other(OtherError(CaUsedAsEndEntity))",
  );
  assertStringIncludes(result!, "CA:TRUE");
  assertStringIncludes(result!, "CA:FALSE");
});

Deno.test("diagnoseTlsMessage: returns guidance for UnknownIssuer", () => {
  const result = diagnoseTlsMessage(
    "invalid peer certificate: UnknownIssuer",
  );
  assertStringIncludes(result!, "--ca-cert");
  assertStringIncludes(result!, "SWAMP_CA_CERT");
});

Deno.test("diagnoseTlsMessage: returns guidance for hostname mismatch", () => {
  const result = diagnoseTlsMessage(
    'certificate not valid for name "localhost"; certificate is only valid for DnsName("external.example.com")',
  );
  assertStringIncludes(result!, "does not match the hostname");
});

Deno.test("diagnoseTlsMessage: returns message for expired cert", () => {
  const result = diagnoseTlsMessage(
    "invalid peer certificate: expired",
  );
  assertStringIncludes(result!, "TLS certificate rejected");
});

Deno.test("diagnoseTlsMessage: returns undefined for non-TLS errors", () => {
  assertEquals(diagnoseTlsMessage("connection refused"), undefined);
  assertEquals(diagnoseTlsMessage("DNS lookup failed"), undefined);
});

// ── warnServerReloadNeeded tests ──────────────────────────────────────

Deno.test("warnServerReloadNeeded: does not throw", () => {
  warnServerReloadNeeded("ws://127.0.0.1:9090");
});

// ── writeRemoteIndicator tests ───────────────────────────────────────

Deno.test("writeRemoteIndicator: writes server URL to stderr", () => {
  const calls: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    calls.push(args.map(String).join(" "));
  };
  try {
    writeRemoteIndicator("https://serve.example.com");
    assertEquals(calls.length, 1);
    assertStringIncludes(calls[0], "Remote");
    assertStringIncludes(calls[0], "https://serve.example.com");
  } finally {
    console.error = originalError;
  }
});

Deno.test("writeRemoteIndicator: includes a credential-free ws URL unchanged", () => {
  const calls: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    calls.push(args.map(String).join(" "));
  };
  try {
    writeRemoteIndicator("wss://internal.corp:4000");
    assertEquals(calls.length, 1);
    assertStringIncludes(calls[0], "wss://internal.corp:4000");
  } finally {
    console.error = originalError;
  }
});

Deno.test("writeRemoteIndicator: hides userinfo, token query and fragment", () => {
  const calls: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    calls.push(args.map(String).join(" "));
  };
  try {
    writeRemoteIndicator(
      "http://alice:hunter2@127.0.0.1:9000/?token=abc.s3cret#frag",
    );
    assertEquals(calls.length, 1);
    assertStringIncludes(calls[0], "http://127.0.0.1:9000");
    for (const secret of ["alice", "hunter2", "token", "s3cret", "frag"]) {
      assertEquals(calls[0].includes(secret), false, secret);
    }
  } finally {
    console.error = originalError;
  }
});

Deno.test("writeRemoteIndicator: an unparseable value is not echoed", () => {
  const calls: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    calls.push(args.map(String).join(" "));
  };
  try {
    writeRemoteIndicator("not a url s3cret");
    assertEquals(calls.length, 1);
    assertStringIncludes(calls[0], "(invalid URL)");
    assertEquals(calls[0].includes("s3cret"), false);
  } finally {
    console.error = originalError;
  }
});

Deno.test("toWebSocketUrl: the invalid-URL error hides credentials", () => {
  const error = assertThrows(
    () => toWebSocketUrl("ftp://alice:hunter2@h:2121/?token=abc.s3cret"),
    UserError,
  );
  assertStringIncludes(error.message, "'ftp://h:2121'");
  for (const secret of ["alice", "hunter2", "s3cret"]) {
    assertEquals(error.message.includes(secret), false, secret);
  }
});

Deno.test("toWebSocketUrl: the invalid-URL error omits an unparseable value", () => {
  const error = assertThrows(
    () => toWebSocketUrl("not a url s3cret"),
    UserError,
  );
  assertEquals(error.message.includes("s3cret"), false);
  assertStringIncludes(error.message, "Invalid --server URL —");
});

Deno.test({
  name:
    "requestServerResponse: SWAMP_SERVE_TIMEOUT_MS env var overrides default timeout",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = scriptedServer((_request, _reply) => {
      // Intentionally never reply — triggers timeout
    });
    const original = Deno.env.get("SWAMP_SERVE_TIMEOUT_MS");
    Deno.env.set("SWAMP_SERVE_TIMEOUT_MS", "200");
    try {
      await assertRejects(
        () =>
          requestServerResponse(
            { server: server.url },
            { type: "test.timeout" },
          ),
        UserError,
        "timed out after 200ms",
      );
    } finally {
      if (original !== undefined) {
        Deno.env.set("SWAMP_SERVE_TIMEOUT_MS", original);
      } else {
        Deno.env.delete("SWAMP_SERVE_TIMEOUT_MS");
      }
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "requestServerResponse: timeout error message mentions SWAMP_SERVE_TIMEOUT_MS",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = scriptedServer((_request, _reply) => {
      // Never reply
    });
    try {
      await assertRejects(
        () =>
          requestServerResponse(
            { server: server.url, timeoutMs: 200 },
            { type: "test.timeout" },
          ),
        UserError,
        "SWAMP_SERVE_TIMEOUT_MS",
      );
    } finally {
      await server.shutdown();
    }
  },
});

// ── subscribeServerEvents tests ──────────────────────────────────────

Deno.test("subscribeServerEvents: yields audit events from server", async () => {
  const server = scriptedServer((request, reply) => {
    if (request.type === "audit.subscribe") {
      reply({
        type: "audit.subscribe",
        id: request.id,
        payload: { subscriptionId: "sub-1" },
      });
      reply({
        type: "audit.event",
        id: "sub-1",
        payload: { event: { action: "vault.get", outcome: "success" } },
      });
      reply({
        type: "audit.event",
        id: "sub-1",
        payload: { event: { action: "model.run", outcome: "denied" } },
      });
    }
  });
  try {
    const events: Record<string, unknown>[] = [];
    const ac = new AbortController();
    const stream = subscribeServerEvents(
      { server: server.url, token: undefined, signal: ac.signal },
      { type: "audit.subscribe" },
    );
    for await (const event of stream) {
      events.push(event);
      if (events.length >= 2) {
        ac.abort();
      }
    }
    assertEquals(events.length, 2);
    assertEquals(events[0].action, "vault.get");
    assertEquals(events[1].action, "model.run");
  } finally {
    await server.shutdown();
  }
});

Deno.test("subscribeServerEvents: propagates server error", async () => {
  const server = scriptedServer((request, reply) => {
    reply({
      type: "error",
      id: request.id,
      error: { code: "audit_not_configured", message: "Audit not enabled" },
    });
  });
  try {
    const stream = subscribeServerEvents(
      { server: server.url, token: undefined },
      { type: "audit.subscribe" },
    );
    await assertRejects(
      async () => {
        for await (const _ of stream) {
          // should not yield
        }
      },
      UserError,
      "Audit not enabled",
    );
  } finally {
    await server.shutdown();
  }
});

Deno.test("subscribeServerEvents: terminates on socket close", async () => {
  const server = scriptedServer((request, reply, socket) => {
    if (request.type === "audit.subscribe") {
      reply({
        type: "audit.subscribe",
        id: request.id,
        payload: { subscriptionId: "sub-1" },
      });
      reply({
        type: "audit.event",
        id: "sub-1",
        payload: { event: { action: "test" } },
      });
      setTimeout(() => socket.close(), 50);
    }
  });
  try {
    const events: Record<string, unknown>[] = [];
    const stream = subscribeServerEvents(
      { server: server.url, token: undefined },
      { type: "audit.subscribe" },
    );
    for await (const event of stream) {
      events.push(event);
    }
    assertEquals(events.length, 1);
  } finally {
    await server.shutdown();
  }
});

// ── server-error classification tests (swamp-club#2383) ──────────────

function upgradeFailingServer(status: number): {
  url: string;
  shutdown: () => Promise<void>;
} {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      if (req.headers.get("upgrade") === "websocket") {
        return new Response("upgrade failed", { status });
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
    "remote run: a 500 on the WebSocket upgrade shows a server error, not an auth failure",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = upgradeFailingServer(500);
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
      assertStringIncludes(error.message, "Server error (HTTP 500)");
      assertEquals(error.message.includes("Authentication failed"), false);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "requestServerResponse: a 500 on the WebSocket upgrade shows a server error, not an auth failure",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = upgradeFailingServer(500);
    try {
      const error = await assertRejects(
        () =>
          requestServerResponse(
            { server: server.url },
            { type: "access.grant.list" },
          ),
        UserError,
      );
      assertStringIncludes(error.message, "Server error (HTTP 500)");
      assertEquals(error.message.includes("Authentication failed"), false);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "requestServerResponse: another non-auth status keeps the original message instead of an auth failure",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = upgradeFailingServer(404);
    try {
      const error = await assertRejects(
        () =>
          requestServerResponse(
            { server: server.url },
            { type: "access.grant.list" },
          ),
        UserError,
      );
      assertStringIncludes(error.message, "Invalid status code: 404");
      assertEquals(error.message.includes("Authentication failed"), false);
    } finally {
      await server.shutdown();
    }
  },
});
