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
import { SwampClient } from "./client.ts";
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
  const client = new SwampClient("ws://127.0.0.1:1/ws");

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
