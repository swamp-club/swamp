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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { SwampClient, type SwampClientOptions } from "./client.ts";
import { SwampClientError } from "./stream.ts";

// ── Constructor ─────────────────────────────────────────────────────────

Deno.test("SwampClient - constructor accepts a URL", () => {
  const client = new SwampClient("ws://localhost:9876/ws");
  // No error thrown — client is created in disconnected state
  client.close(); // safe to call even when not connected
});

Deno.test("SwampClient - close is idempotent when not connected", () => {
  const client = new SwampClient("ws://localhost:9876/ws");
  client.close();
  client.close();
  // No error — close on a null socket is a no-op
});

// ── Integration with a local WebSocket server ───────────────────────────

Deno.test("SwampClient - connect and close lifecycle", async () => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    if (req.headers.get("upgrade") === "websocket") {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onopen = () => {};
      return response;
    }
    return new Response("not found", { status: 404 });
  });

  const addr = server.addr;
  const client = new SwampClient(`ws://localhost:${addr.port}/ws`);

  await client.connect();
  // Calling connect again should return immediately (already open)
  await client.connect();

  client.close();
  await server.shutdown();
});

Deno.test("SwampClient - connect rejects on refused connection", async () => {
  // Port 1 is almost certainly not listening
  const client = new SwampClient("ws://127.0.0.1:1/ws", {
    retryBudgetMs: 0,
  });

  await assertRejects(
    () => client.connect(),
    Error,
  );
});

Deno.test("SwampClient - workflowRun receives completed event", async () => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    if (req.headers.get("upgrade") === "websocket") {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (e) => {
        const msg = JSON.parse(e.data as string);
        // Echo back a completed event
        socket.send(JSON.stringify({
          type: "event",
          id: msg.id,
          event: {
            kind: "completed",
            run: {
              id: "run-1",
              workflowId: "wf-1",
              workflowName: "test-wf",
              status: "succeeded",
              jobs: [],
            },
          },
        }));
      };
      return response;
    }
    return new Response("not found", { status: 404 });
  });

  const addr = server.addr;
  const client = new SwampClient(`ws://localhost:${addr.port}/ws`);

  const result = await client.workflowRun({
    workflowIdOrName: "test-wf",
  });
  assert(result.outcome === "completed");
  assertEquals(result.workflowName, "test-wf");
  assertEquals(result.status, "succeeded");

  client.close();
  await server.shutdown();
});

Deno.test("SwampClient - workflowRun dispatches intermediate events to handlers", async () => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    if (req.headers.get("upgrade") === "websocket") {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (e) => {
        const msg = JSON.parse(e.data as string);
        // Send a sequence of events
        socket.send(JSON.stringify({
          type: "event",
          id: msg.id,
          event: { kind: "validating_inputs" },
        }));
        socket.send(JSON.stringify({
          type: "event",
          id: msg.id,
          event: { kind: "evaluating_workflow" },
        }));
        socket.send(JSON.stringify({
          type: "event",
          id: msg.id,
          event: {
            kind: "completed",
            run: {
              id: "r1",
              workflowId: "w1",
              workflowName: "wf",
              status: "succeeded",
              jobs: [],
            },
          },
        }));
      };
      return response;
    }
    return new Response("not found", { status: 404 });
  });

  const addr = server.addr;
  const client = new SwampClient(`ws://localhost:${addr.port}/ws`);

  const seen: string[] = [];
  await client.workflowRun(
    { workflowIdOrName: "wf" },
    {
      validating_inputs: () => {
        seen.push("validating");
      },
      evaluating_workflow: () => {
        seen.push("evaluating");
      },
    },
  );

  assertEquals(seen, ["validating", "evaluating"]);

  client.close();
  await server.shutdown();
});

Deno.test("SwampClient - server error message rejects with SwampClientError", async () => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    if (req.headers.get("upgrade") === "websocket") {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (e) => {
        const msg = JSON.parse(e.data as string);
        socket.send(JSON.stringify({
          type: "error",
          id: msg.id,
          error: {
            code: "not_found",
            message: "Workflow not found",
          },
        }));
      };
      return response;
    }
    return new Response("not found", { status: 404 });
  });

  const addr = server.addr;
  const client = new SwampClient(`ws://localhost:${addr.port}/ws`);

  const err = await assertRejects(
    () => client.workflowRun({ workflowIdOrName: "missing" }),
    SwampClientError,
    "Workflow not found",
  );
  assertEquals((err as SwampClientError).code, "not_found");

  client.close();
  await server.shutdown();
});

Deno.test("SwampClient - error event in stream rejects with SwampClientError", async () => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    if (req.headers.get("upgrade") === "websocket") {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (e) => {
        const msg = JSON.parse(e.data as string);
        socket.send(JSON.stringify({
          type: "event",
          id: msg.id,
          event: {
            kind: "error",
            error: {
              code: "execution_failed",
              message: "Method threw an exception",
            },
          },
        }));
      };
      return response;
    }
    return new Response("not found", { status: 404 });
  });

  const addr = server.addr;
  const client = new SwampClient(`ws://localhost:${addr.port}/ws`);

  const err = await assertRejects(
    () =>
      client.modelMethodRun({
        modelIdOrName: "test",
        methodName: "run",
      }),
    SwampClientError,
    "Method threw an exception",
  );
  assertEquals((err as SwampClientError).code, "execution_failed");

  client.close();
  await server.shutdown();
});

Deno.test("SwampClient - workflowRunStream yields events", async () => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    if (req.headers.get("upgrade") === "websocket") {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (e) => {
        const msg = JSON.parse(e.data as string);
        socket.send(JSON.stringify({
          type: "event",
          id: msg.id,
          event: { kind: "validating_inputs" },
        }));
        socket.send(JSON.stringify({
          type: "event",
          id: msg.id,
          event: {
            kind: "completed",
            run: {
              id: "r1",
              workflowId: "w1",
              workflowName: "stream-wf",
              status: "succeeded",
              jobs: [],
            },
          },
        }));
      };
      return response;
    }
    return new Response("not found", { status: 404 });
  });

  const addr = server.addr;
  const client = new SwampClient(`ws://localhost:${addr.port}/ws`);

  const kinds: string[] = [];
  for await (
    const event of client.workflowRunStream({
      workflowIdOrName: "stream-wf",
    })
  ) {
    kinds.push(event.kind);
  }

  assertEquals(kinds, ["validating_inputs", "completed"]);

  client.close();
  await server.shutdown();
});

Deno.test("SwampClient - socket close rejects pending requests", async () => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    if (req.headers.get("upgrade") === "websocket") {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = () => {
        // Close instead of responding
        socket.close();
      };
      return response;
    }
    return new Response("not found", { status: 404 });
  });

  const addr = server.addr;
  const client = new SwampClient(`ws://localhost:${addr.port}/ws`);

  await assertRejects(
    () => client.workflowRun({ workflowIdOrName: "test" }),
    Error,
    "WebSocket closed",
  );

  client.close();
  await server.shutdown();
});

// ── Constructor options ───────────────────────────────────────────────

Deno.test("SwampClient - constructor accepts token option", () => {
  const client = new SwampClient("ws://localhost:9876/ws", {
    token: "admin.secret123",
  });
  client.close();
});

Deno.test("SwampClient - token is sent as WebSocket subprotocol", async () => {
  let receivedProtocol = "";
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    if (req.headers.get("upgrade") === "websocket") {
      receivedProtocol = req.headers.get("sec-websocket-protocol") ?? "";
      const { socket, response } = Deno.upgradeWebSocket(req, {
        protocol: receivedProtocol,
      });
      socket.onopen = () => {};
      return response;
    }
    return new Response("not found", { status: 404 });
  });

  const addr = server.addr;
  const client = new SwampClient(`ws://localhost:${addr.port}/ws`, {
    token: "admin.testsecret",
  });

  await client.connect();
  assertEquals(receivedProtocol, "bearer.admin.testsecret");

  client.close();
  await server.shutdown();
});

// ── request<T>() ──────────────────────────────────────────────────────

Deno.test("SwampClient - request resolves with payload", async () => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    if (req.headers.get("upgrade") === "websocket") {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (e) => {
        const msg = JSON.parse(e.data as string);
        socket.send(JSON.stringify({
          type: msg.type,
          id: msg.id,
          payload: {
            data: { results: [{ name: "test-workflow" }] },
          },
        }));
      };
      return response;
    }
    return new Response("not found", { status: 404 });
  });

  const addr = server.addr;
  const client = new SwampClient(`ws://localhost:${addr.port}/ws`);
  await client.connect();

  const result = await client.request<{
    data: { results: Array<{ name: string }> };
  }>(
    "workflow.search",
  );
  assertEquals(result.data.results[0].name, "test-workflow");

  client.close();
  await server.shutdown();
});

Deno.test("SwampClient - request rejects on error response", async () => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    if (req.headers.get("upgrade") === "websocket") {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (e) => {
        const msg = JSON.parse(e.data as string);
        socket.send(JSON.stringify({
          type: "error",
          id: msg.id,
          error: { code: "not_found", message: "Resource not found" },
        }));
      };
      return response;
    }
    return new Response("not found", { status: 404 });
  });

  const addr = server.addr;
  const client = new SwampClient(`ws://localhost:${addr.port}/ws`);
  await client.connect();

  await assertRejects(
    () => client.request("workflow.get", { workflowIdOrName: "missing" }),
    Error,
    "Resource not found",
  );

  client.close();
  await server.shutdown();
});

Deno.test("SwampClient - request sends payload when provided", async () => {
  let receivedPayload: Record<string, unknown> | undefined;
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    if (req.headers.get("upgrade") === "websocket") {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (e) => {
        const msg = JSON.parse(e.data as string);
        receivedPayload = msg.payload;
        socket.send(JSON.stringify({
          type: msg.type,
          id: msg.id,
          payload: { data: {} },
        }));
      };
      return response;
    }
    return new Response("not found", { status: 404 });
  });

  const addr = server.addr;
  const client = new SwampClient(`ws://localhost:${addr.port}/ws`);
  await client.connect();

  await client.request("workflow.run.search", { limit: 50, status: "failed" });
  assertEquals(receivedPayload?.limit, 50);
  assertEquals(receivedPayload?.status, "failed");

  client.close();
  await server.shutdown();
});

Deno.test("SwampClient - request rejects when connection fails", async () => {
  const client = new SwampClient("ws://127.0.0.1:1/ws", {
    retryBudgetMs: 0,
  });

  await assertRejects(
    () => client.request("workflow.search"),
    Error,
  );
});

// ── Stream errors ───────────────────────────────────────────────────────

async function withReplyServer(
  reply: (socket: WebSocket, id: string) => void,
  fn: (client: SwampClient) => Promise<void>,
): Promise<void> {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onmessage = (e) => reply(socket, JSON.parse(e.data as string).id);
    return response;
  });
  const client = new SwampClient(`ws://localhost:${server.addr.port}/ws`);
  try {
    await fn(client);
  } finally {
    client.close();
    await server.shutdown();
  }
}

const REFUSAL = {
  code: "unauthorized",
  message: "Access denied: user:bob does not have 'run' on workflow:gated",
  details: { action: "run" },
};

function sendRefusal(socket: WebSocket, id: string): void {
  socket.send(JSON.stringify({ type: "error", id, error: REFUSAL }));
}

function sendEventsThenError(socket: WebSocket, id: string): void {
  for (const kind of ["validating_inputs", "evaluating_workflow"]) {
    socket.send(JSON.stringify({ type: "event", id, event: { kind } }));
  }
  socket.send(JSON.stringify({
    type: "event",
    id,
    event: {
      kind: "error",
      error: { code: "execution_failed", message: "step failed" },
    },
  }));
}

function sendEventThenClose(socket: WebSocket, id: string): void {
  socket.send(JSON.stringify({
    type: "event",
    id,
    event: { kind: "validating_inputs" },
  }));
  socket.close();
}

async function collect(
  stream: AsyncIterable<{ kind: string }>,
): Promise<{ kinds: string[]; error: unknown }> {
  const kinds: string[] = [];
  try {
    for await (const event of stream) kinds.push(event.kind);
  } catch (error) {
    return { kinds, error };
  }
  return { kinds, error: undefined };
}

function assertSameClientError(actual: unknown, expected: unknown): void {
  if (!(actual instanceof SwampClientError)) {
    throw new Error(`expected SwampClientError, got ${String(actual)}`);
  }
  if (!(expected instanceof SwampClientError)) {
    throw new Error(`expected SwampClientError, got ${String(expected)}`);
  }
  assertEquals(
    { code: actual.code, message: actual.message, details: actual.details },
    {
      code: expected.code,
      message: expected.message,
      details: expected.details,
    },
  );
}

Deno.test("SwampClient - workflowRunStream throws a refusal that arrives while it waits", async () => {
  await withReplyServer(sendRefusal, async (client) => {
    const { kinds, error } = await collect(
      client.workflowRunStream({ workflowIdOrName: "gated" }),
    );
    assertEquals(kinds, []);
    const expected = await client.workflowRun({ workflowIdOrName: "gated" })
      .catch((e) => e);
    assertSameClientError(error, expected);
    assertEquals((error as SwampClientError).code, "unauthorized");
  });
});

Deno.test("SwampClient - modelMethodRunStream throws a refusal that arrives while it waits", async () => {
  await withReplyServer(sendRefusal, async (client) => {
    const payload = { modelIdOrName: "gated", methodName: "run" };
    const { kinds, error } = await collect(
      client.modelMethodRunStream(payload),
    );
    assertEquals(kinds, []);
    const expected = await client.modelMethodRun(payload).catch((e) => e);
    assertSameClientError(error, expected);
    assertEquals((error as SwampClientError).code, "unauthorized");
  });
});

Deno.test("SwampClient - workflowRunStream yields every event before an in-band error, then throws it", async () => {
  await withReplyServer(sendEventsThenError, async (client) => {
    const { kinds, error } = await collect(
      client.workflowRunStream({ workflowIdOrName: "failing" }),
    );
    assertEquals(kinds, ["validating_inputs", "evaluating_workflow", "error"]);
    const expected = await client.workflowRun({ workflowIdOrName: "failing" })
      .catch((e) => e);
    assertSameClientError(error, expected);
  });
});

Deno.test("SwampClient - modelMethodRunStream yields every event before an in-band error, then throws it", async () => {
  await withReplyServer(sendEventsThenError, async (client) => {
    const payload = { modelIdOrName: "failing", methodName: "run" };
    const { kinds, error } = await collect(
      client.modelMethodRunStream(payload),
    );
    assertEquals(kinds, ["validating_inputs", "evaluating_workflow", "error"]);
    const expected = await client.modelMethodRun(payload).catch((e) => e);
    assertSameClientError(error, expected);
  });
});

Deno.test("SwampClient - workflowRunStream throws when the socket closes mid-stream", async () => {
  await withReplyServer(sendEventThenClose, async (client) => {
    const { kinds, error } = await collect(
      client.workflowRunStream({ workflowIdOrName: "w" }),
    );
    assertEquals(kinds, ["validating_inputs"]);
    assertEquals((error as Error)?.message, "WebSocket closed");
  });
});

Deno.test("SwampClient - modelMethodRunStream throws when the socket closes mid-stream", async () => {
  await withReplyServer(sendEventThenClose, async (client) => {
    const { kinds, error } = await collect(
      client.modelMethodRunStream({ modelIdOrName: "m", methodName: "run" }),
    );
    assertEquals(kinds, ["validating_inputs"]);
    assertEquals((error as Error)?.message, "WebSocket closed");
  });
});

// ── How each request settles ────────────────────────────────────────────

type Frame = Record<string, unknown>;
type Request = { type: string; id: string; payload?: Record<string, unknown> };

const RUN = {
  id: "run-1",
  workflowId: "wf-1",
  workflowName: "gated",
  status: "suspended",
  jobs: [],
};

const event = (id: string, e: Frame): Frame => ({
  type: "event",
  id,
  event: e,
});
const done = (id: string): Frame => ({ type: "done", id });

/** A serve stand-in that answers each request with scripted frames. */
async function withScriptedServer(
  script: (req: Request) => Frame[],
  fn: (client: SwampClient, received: Request[]) => Promise<void>,
): Promise<void> {
  const received: Request[] = [];
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onmessage = (e) => {
      const msg = JSON.parse(e.data as string) as Request;
      received.push(msg);
      for (const frame of script(msg)) socket.send(JSON.stringify(frame));
    };
    return response;
  });
  const client = new SwampClient(`ws://localhost:${server.addr.port}/ws`);
  try {
    await fn(client, received);
  } finally {
    client.close();
    await server.shutdown();
  }
}

const gateFrames = (id: string): Frame[] => [
  event(id, { kind: "started", runId: "run-1", workflowName: "gated" }),
  event(id, {
    kind: "approval_requested",
    runId: "run-1",
    jobId: "gate",
    stepId: "approve",
    prompt: "Approve?",
  }),
  event(id, {
    kind: "suspended",
    run: RUN,
    jobId: "gate",
    stepId: "approve",
    prompt: "Approve?",
    timeout: 300,
  }),
  done(id),
];

Deno.test("SwampClient - workflowRun settles as suspended when the run stops at a gate", async () => {
  await withScriptedServer((req) => gateFrames(req.id), async (client) => {
    const seen: string[] = [];
    const result = await client.workflowRun({ workflowIdOrName: "gated" }, {
      suspended: (e) => {
        seen.push(`suspended:${e.stepId}`);
      },
    });
    assertEquals(seen, ["suspended:approve"]);
    assert(result.outcome === "suspended");
    assertEquals(result.gate, {
      jobId: "gate",
      stepId: "approve",
      prompt: "Approve?",
      timeout: 300,
    });
    assertEquals(result.id, "run-1");
    assertEquals(result.status, "suspended");
  });
});

Deno.test("SwampClient - workflowRun settles a cancelled run with its reason beside the run", async () => {
  await withScriptedServer(
    (req) => [
      event(req.id, {
        kind: "cancelled",
        run: { ...RUN, status: "cancelled" },
        reason: "superseded",
      }),
      done(req.id),
    ],
    async (client) => {
      const result = await client.workflowRun({ workflowIdOrName: "gated" });
      assert(result.outcome === "cancelled");
      assertEquals(result.reason, "superseded");
      assertEquals(result.status, "cancelled");
    },
  );
});

Deno.test("SwampClient - workflowRun settles an idempotent replay as replayed", async () => {
  await withScriptedServer(
    (req) => [
      event(req.id, {
        kind: "started",
        runId: "run-1",
        workflowName: "gated",
        replayed: true,
      }),
      done(req.id),
    ],
    async (client) => {
      const result = await client.workflowRun({
        workflowIdOrName: "gated",
        idempotencyKey: "k1",
      });
      assertEquals(result, { outcome: "replayed", runId: "run-1" });
    },
  );
});

Deno.test("SwampClient - a done frame with no terminal event rejects every pending request", async () => {
  await withScriptedServer(
    (req) => [
      event(req.id, { kind: "started", runId: "run-1", workflowName: "x" }),
      done(req.id),
    ],
    async (client) => {
      for (
        const call of [
          () => client.workflowRun({ workflowIdOrName: "x" }),
          () => client.workflowResume({ workflowIdOrName: "x", runId: "r" }),
          () => client.modelMethodRun({ modelIdOrName: "m", methodName: "go" }),
          () => client.request("workflow.resume", { workflowIdOrName: "x" }),
        ]
      ) {
        const err = await assertRejects(call, SwampClientError);
        assertEquals(err.code, "no_terminal_event");
      }
    },
  );
});

Deno.test("SwampClient - workflowResume sends workflow.resume and settles at the next gate or the end", async () => {
  let resumes = 0;
  await withScriptedServer(
    (req) =>
      ++resumes === 1 ? gateFrames(req.id) : [
        event(req.id, {
          kind: "completed",
          run: { ...RUN, status: "succeeded" },
        }),
        done(req.id),
      ],
    async (client, received) => {
      const first = await client.workflowResume({
        workflowIdOrName: "gated",
        runId: "run-1",
      });
      assertEquals(first.outcome, "suspended");
      const second = await client.workflowResume({
        workflowIdOrName: "gated",
        runId: "run-1",
      });
      assert(second.outcome === "completed");
      assertEquals(second.status, "succeeded");
      assertEquals(received.map((r) => r.type), [
        "workflow.resume",
        "workflow.resume",
      ]);
    },
  );
});

Deno.test("SwampClient - request resolves a suspended streamed reply with its run", async () => {
  await withScriptedServer((req) => gateFrames(req.id), async (client) => {
    const run = await client.request<{ status: string }>("workflow.resume", {
      workflowIdOrName: "gated",
    });
    assertEquals(run.status, "suspended");
  });
});

Deno.test("SwampClient - workflowRunStream ends after a suspended event", async () => {
  await withScriptedServer((req) => gateFrames(req.id), async (client) => {
    const kinds: string[] = [];
    for await (const e of client.workflowRunStream({ workflowIdOrName: "g" })) {
      kinds.push(e.kind);
    }
    assertEquals(kinds, ["started", "approval_requested", "suspended"]);
  });
});

Deno.test("SwampClient - a closed socket rejects pending requests with connection_closed", async () => {
  await withScriptedServer(() => [], async (client) => {
    const pending = client.workflowRun({ workflowIdOrName: "x" });
    await client.connect();
    client.close();
    const err = await assertRejects(() => pending, SwampClientError);
    assertEquals(err.code, "connection_closed");
  });
});

Deno.test("SwampClient - a send that throws leaves nothing pending", async () => {
  await withScriptedServer(() => [], async (client) => {
    await assertRejects(
      () =>
        client.workflowRun({
          workflowIdOrName: "x",
          inputs: { n: 1n },
        }),
      TypeError,
    );
    const pending = (client as unknown as { pending: Map<string, unknown> })
      .pending;
    assertEquals(pending.size, 0);
  });
});

// A WebSocket server over raw TCP, so a test decides when a connection the
// client closed actually ends; Deno.serve answers the close frame itself.
class RawSocketServer {
  private listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  private accepted: Deno.Conn[] = [];
  private buffers = new Map<Deno.Conn, Uint8Array>();
  readonly url = `ws://127.0.0.1:${
    (this.listener.addr as Deno.NetAddr).port
  }/ws`;

  async accept(): Promise<Deno.Conn> {
    const conn = await this.listener.accept();
    this.accepted.push(conn);
    this.buffers.set(conn, new Uint8Array());
    const head = new TextDecoder().decode(await this.readUntilHeaderEnd(conn));
    const key = /sec-websocket-key:\s*(\S+)/i.exec(head)![1];
    const digest = await crypto.subtle.digest(
      "SHA-1",
      new TextEncoder().encode(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"),
    );
    const accept = btoa(String.fromCharCode(...new Uint8Array(digest)));
    await conn.write(
      new TextEncoder().encode(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
          `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      ),
    );
    return conn;
  }

  async readText(conn: Deno.Conn): Promise<string> {
    const head = await this.read(conn, 2);
    let length = head[1] & 0x7f;
    if (length === 126) {
      const ext = await this.read(conn, 2);
      length = (ext[0] << 8) | ext[1];
    }
    const mask = await this.read(conn, 4);
    const body = await this.read(conn, length);
    return new TextDecoder().decode(body.map((b, i) => b ^ mask[i % 4]));
  }

  async sendText(conn: Deno.Conn, text: string): Promise<void> {
    const body = new TextEncoder().encode(text);
    const head = body.length < 126
      ? [0x81, body.length]
      : [0x81, 126, body.length >> 8, body.length & 0xff];
    await conn.write(new Uint8Array([...head, ...body]));
  }

  close(): void {
    for (const conn of this.accepted) {
      try {
        conn.close();
      } catch {
        // already closed by the test
      }
    }
    this.listener.close();
  }

  private async readUntilHeaderEnd(conn: Deno.Conn): Promise<Uint8Array> {
    for (;;) {
      const buf = this.buffers.get(conn)!;
      const text = new TextDecoder().decode(buf);
      const end = text.indexOf("\r\n\r\n");
      if (end >= 0) {
        this.buffers.set(conn, buf.slice(end + 4));
        return buf.slice(0, end);
      }
      await this.fill(conn);
    }
  }

  private async read(conn: Deno.Conn, n: number): Promise<Uint8Array> {
    while (this.buffers.get(conn)!.length < n) await this.fill(conn);
    const buf = this.buffers.get(conn)!;
    this.buffers.set(conn, buf.slice(n));
    return buf.slice(0, n);
  }

  private async fill(conn: Deno.Conn): Promise<void> {
    const chunk = new Uint8Array(4096);
    const n = await conn.read(chunk);
    if (n === null) throw new Error("connection ended");
    const buf = this.buffers.get(conn)!;
    const next = new Uint8Array(buf.length + n);
    next.set(buf);
    next.set(chunk.subarray(0, n), buf.length);
    this.buffers.set(conn, next);
  }
}

Deno.test("SwampClient - a closed socket ending after a reconnect leaves the new socket and its requests alone", async () => {
  const server = new RawSocketServer();
  const client = new SwampClient(server.url);
  try {
    const firstConn = server.accept();
    await client.connect();
    const oldConn = await firstConn;
    const oldRequest = client.request("workflow.search");
    await server.readText(oldConn);

    client.close();
    const secondConn = server.accept();
    await client.connect();
    const newConn = await secondConn;
    const newRequest = client.request("workflow.search");
    const sent = JSON.parse(await server.readText(newConn)) as Request;

    oldConn.close();
    const oldError = await oldRequest.then(() => undefined, (e) => e);

    await server.sendText(
      newConn,
      JSON.stringify({
        type: "workflow.search",
        id: sent.id,
        payload: { data: { ok: true } },
      }),
    );
    assertEquals(await newRequest, { data: { ok: true } });

    const another = client.request("workflow.search");
    const next = JSON.parse(await server.readText(newConn)) as Request;
    await server.sendText(
      newConn,
      JSON.stringify({
        type: "workflow.search",
        id: next.id,
        payload: { data: { again: true } },
      }),
    );
    assertEquals(await another, { data: { again: true } });
    assert(oldError instanceof SwampClientError);
    assertEquals(oldError.code, "connection_closed");
  } finally {
    client.close();
    server.close();
  }
});

// ── Retrying while serve restarts ───────────────────────────────────────

/** a clock that only moves when the client sleeps */
function fakeClock(random = 0.5) {
  const sleeps: number[] = [];
  let t = 0;
  return {
    sleeps,
    options: {
      now: () => t,
      random: () => random,
      sleep: (ms: number) => {
        sleeps.push(ms);
        t += ms;
        return Promise.resolve();
      },
    },
  };
}

function closedPort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

const completedRun = (id: string): Frame =>
  event(id, {
    kind: "completed",
    run: { ...RUN, workflowName: "w", status: "succeeded" },
  });

const refusal = (
  id: string,
  code: string,
  retryAfterSeconds?: number,
): Frame => ({
  type: "error",
  id,
  error: {
    code,
    message: `serve is ${code}`,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  },
});

/** a serve stand-in whose answer depends on how many requests came before */
async function withRestartingServer(
  upgrade: (connection: number) => Response | undefined,
  script: (req: Request, n: number, socket: WebSocket) => void,
  options: Partial<SwampClientOptions>,
  fn: (client: SwampClient, received: Request[]) => Promise<void>,
): Promise<void> {
  const received: Request[] = [];
  let connections = 0;
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const refused = upgrade(connections++);
    if (refused) return refused;
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onmessage = (e) => {
      const msg = JSON.parse(e.data as string) as Request;
      received.push(msg);
      script(msg, received.length, socket);
    };
    return response;
  });
  const client = new SwampClient(
    `ws://127.0.0.1:${server.addr.port}/ws`,
    options,
  );
  try {
    await fn(client, received);
  } finally {
    client.close();
    await server.shutdown();
  }
}

const accept = () => undefined;

Deno.test("SwampClient - connect retries a refused connection until serve listens", async () => {
  const port = closedPort();
  let server: Deno.HttpServer | undefined;
  const sleeps: number[] = [];
  const client = new SwampClient(`ws://127.0.0.1:${port}/ws`, {
    random: () => 0.5,
    sleep: (ms) => {
      sleeps.push(ms);
      server ??= Deno.serve(
        { hostname: "127.0.0.1", port, onListen: () => {} },
        (req) => Deno.upgradeWebSocket(req).response,
      );
      return Promise.resolve();
    },
  });
  try {
    await client.connect();
    assertEquals(sleeps, [125]);
  } finally {
    client.close();
    await server?.shutdown();
  }
});

Deno.test("SwampClient - connect gives up on a refused connection when its budget runs out", async () => {
  const clock = fakeClock(1);
  const client = new SwampClient(`ws://127.0.0.1:${closedPort()}/ws`, {
    retryBudgetMs: 2_000,
    ...clock.options,
  });
  await assertRejects(() => client.connect(), Error, "tcp connect error");
  // backoff doubles from 250 ms; the next 2 s wait would pass the budget
  assertEquals(clock.sleeps, [250, 500, 1000]);
});

Deno.test("SwampClient - connect retries a 503 upgrade but not a 401", async () => {
  const clock = fakeClock();
  await withRestartingServer(
    (n) => n < 2 ? new Response("starting", { status: 503 }) : undefined,
    () => {},
    clock.options,
    async (client) => {
      await client.connect();
      assertEquals(clock.sleeps.length, 2);
    },
  );

  const denied = fakeClock();
  await withRestartingServer(
    () => new Response("no", { status: 401 }),
    () => {},
    denied.options,
    async (client) => {
      await assertRejects(() => client.connect(), Error, "401");
      assertEquals(denied.sleeps, []);
    },
  );
});

Deno.test("SwampClient - workflowRun starts again on a fresh connection after a draining refusal", async () => {
  const clock = fakeClock();
  let opened = 0;
  await withRestartingServer(
    () => {
      opened++;
      return undefined;
    },
    (req, n, socket) => {
      if (n === 1) {
        socket.send(JSON.stringify(refusal(req.id, "draining", 5)));
        return;
      }
      socket.send(JSON.stringify(completedRun(req.id)));
    },
    clock.options,
    async (client, received) => {
      const result = await client.workflowRun({ workflowIdOrName: "w" });
      assertEquals(result.outcome, "completed");
      assertEquals(received.length, 2);
      assert(received[0].id !== received[1].id);
      assertEquals(opened, 2);
      // Retry-After plus a jitter of half of min(1 s, a quarter of it)
      assertEquals(clock.sleeps, [5_500]);
    },
  );
});

Deno.test("SwampClient - a draining refusal from an older serve backs off without Retry-After", async () => {
  const clock = fakeClock();
  await withRestartingServer(
    accept,
    (req, n, socket) => {
      socket.send(JSON.stringify(
        n === 1 ? refusal(req.id, "draining") : completedRun(req.id),
      ));
    },
    clock.options,
    async (client) => {
      await client.workflowRun({ workflowIdOrName: "w" });
      assertEquals(clock.sleeps, [125]);
    },
  );
});

Deno.test("SwampClient - not_ready refusals are retried for every run start", async () => {
  const notReadyOnce = (req: Request, n: number, socket: WebSocket) => {
    socket.send(JSON.stringify(
      n % 2 === 1 ? refusal(req.id, "not_ready", 2) : completedRun(req.id),
    ));
  };
  const clock = fakeClock(0);
  await withRestartingServer(
    accept,
    notReadyOnce,
    clock.options,
    async (client, received) => {
      await client.modelMethodRun({ modelIdOrName: "m", methodName: "run" });
      await client.workflowResume({ workflowIdOrName: "w", runId: "run-1" });
      const { kinds, error } = await collect(
        client.workflowRunStream({ workflowIdOrName: "w" }),
      );
      assertEquals([kinds, error], [["completed"], undefined]);
      const streamed = await collect(
        client.modelMethodRunStream({ modelIdOrName: "m", methodName: "run" }),
      );
      assertEquals([streamed.kinds, streamed.error], [
        ["completed"],
        undefined,
      ]);
      assertEquals(received.length, 8);
      assertEquals(clock.sleeps, [2000, 2000, 2000, 2000]);
    },
  );
});

Deno.test("SwampClient - a refused start past its budget rejects with the refusal and its retryAfterSeconds", async () => {
  const clock = fakeClock();
  await withRestartingServer(
    accept,
    (req, _n, socket) =>
      socket.send(JSON.stringify(refusal(req.id, "draining", 5))),
    { retryBudgetMs: 12_000, ...clock.options },
    async (client, received) => {
      const err = await assertRejects(
        () => client.workflowRun({ workflowIdOrName: "w" }),
        SwampClientError,
      );
      assertEquals([err.code, err.retryAfterSeconds], ["draining", 5]);
      assertEquals(received.length, 3);
      assertEquals(clock.sleeps, [5_500, 5_500]);
    },
  );
});

Deno.test("SwampClient - a run start is not sent again once the connection closes after it", async () => {
  const clock = fakeClock();
  await withRestartingServer(
    accept,
    (_req, _n, socket) => socket.close(),
    clock.options,
    async (client, received) => {
      const err = await assertRejects(
        () => client.workflowRun({ workflowIdOrName: "w" }),
        SwampClientError,
      );
      assertEquals(err.code, "connection_closed");
      assertEquals(received.length, 1);
      assertEquals(clock.sleeps, []);
    },
  );
});

Deno.test("SwampClient - a draining error after a run event, or on a plain request, is not retried", async () => {
  const clock = fakeClock();
  await withRestartingServer(
    accept,
    (req, _n, socket) => {
      if (req.type === "workflow.run") {
        socket.send(JSON.stringify(event(req.id, { kind: "started" })));
      }
      socket.send(JSON.stringify(refusal(req.id, "draining", 5)));
    },
    clock.options,
    async (client, received) => {
      const run = await assertRejects(
        () => client.workflowRun({ workflowIdOrName: "w" }),
        SwampClientError,
      );
      assertEquals(run.code, "draining");
      const plain = await assertRejects(
        () => client.request("workflow.search"),
        SwampClientError,
      );
      assertEquals([plain.code, plain.retryAfterSeconds], ["draining", 5]);
      assertEquals(received.length, 2);
      assertEquals(clock.sleeps, []);
    },
  );
});

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(condition(), "condition never held");
}

Deno.test("SwampClient - a socket retired by a draining refusal closes once its last run settles", async () => {
  const clock = fakeClock();
  let held: { id: string; socket: WebSocket } | undefined;
  let retiredClosed = false;
  await withRestartingServer(
    accept,
    (req, n, socket) => {
      if (n === 1) {
        held = { id: req.id, socket };
        socket.addEventListener("close", () => retiredClosed = true);
        return;
      }
      if (n === 2) {
        socket.send(JSON.stringify(refusal(req.id, "draining", 0)));
        return;
      }
      socket.send(JSON.stringify(completedRun(req.id)));
    },
    clock.options,
    async (client, received) => {
      const first = client.workflowRun({ workflowIdOrName: "w" });
      await until(() => received.length === 1);
      const second = await client.workflowRun({ workflowIdOrName: "w" });
      assertEquals(second.outcome, "completed");
      assertEquals(retiredClosed, false);
      held!.socket.send(JSON.stringify(completedRun(held!.id)));
      assertEquals((await first).outcome, "completed");
      await until(() => retiredClosed);
    },
  );
});

Deno.test("SwampClient - a Retry-After of 0 still waits the backoff base before starting again", async () => {
  const clock = fakeClock();
  await withRestartingServer(
    accept,
    (req, n, socket) => {
      socket.send(JSON.stringify(
        n === 1 ? refusal(req.id, "not_ready", 0) : completedRun(req.id),
      ));
    },
    clock.options,
    async (client, received) => {
      await client.workflowRun({ workflowIdOrName: "w" });
      assertEquals(received.length, 2);
      assertEquals(clock.sleeps, [250]);
    },
  );
});
