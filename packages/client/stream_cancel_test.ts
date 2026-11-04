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

import { assertEquals } from "@std/assert";
import {
  SwampClient,
  type SwampConnection,
  type SwampTransport,
  type SwampTransportHandlers,
} from "./client.ts";
import type { ServerMessage, ServerRequest } from "./protocol.ts";

/** Records what the client sends and lets a test play serve's frames. */
function fakeServe() {
  const sent: ServerRequest[] = [];
  let handlers: SwampTransportHandlers | null = null;
  const connection: SwampConnection = {
    isOpen: true,
    send: (request) => sent.push(request),
    close: () => {},
  };
  const transport: SwampTransport = {
    reopens: false,
    open: (next) => {
      handlers = next;
      return Promise.resolve(connection);
    },
  };
  const frame = (message: ServerMessage) => handlers?.onFrame(message);
  return { sent, transport, frame };
}

function runRequest(sent: ServerRequest[]): ServerRequest {
  const request = sent.find((r) => r.type === "workflow.run");
  if (request === undefined) throw new Error("no run was started");
  return request;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

Deno.test("workflowRunStream: leaving the loop early stops following the run", async () => {
  const serve = fakeServe();
  const client = new SwampClient(serve.transport);
  const stream = client.workflowRunStream({ workflowIdOrName: "w" });
  const next = stream.next();
  await tick();
  const { id } = runRequest(serve.sent);
  serve.frame({
    type: "event",
    id,
    event: { kind: "job_started", jobId: "a" },
  });
  await next;
  await stream.return(undefined);
  assertEquals(serve.sent.at(-1), { type: "cancel", id });
});

Deno.test("workflowRunStream: an abort ends the stream and stops following", async () => {
  const serve = fakeServe();
  const client = new SwampClient(serve.transport);
  const stop = new AbortController();
  const seen: string[] = [];
  const done = (async () => {
    for await (
      const event of client.workflowRunStream({ workflowIdOrName: "w" }, {
        signal: stop.signal,
      })
    ) {
      seen.push(event.kind);
    }
  })();
  await tick();
  const { id } = runRequest(serve.sent);
  serve.frame({
    type: "event",
    id,
    event: { kind: "job_started", jobId: "a" },
  });
  await tick();
  stop.abort();
  await done;
  assertEquals(seen, ["job_started"]);
  assertEquals(serve.sent.at(-1), { type: "cancel", id });
});

Deno.test("workflowRunStream: a run that ends on its own sends no cancel", async () => {
  const serve = fakeServe();
  const client = new SwampClient(serve.transport);
  const done = (async () => {
    for await (const _ of client.workflowRunStream({ workflowIdOrName: "w" })) {
      // drained
    }
  })();
  await tick();
  const { id } = runRequest(serve.sent);
  serve.frame({
    type: "event",
    id,
    event: {
      kind: "completed",
      run: {
        id: "r",
        workflowId: "w",
        workflowName: "w",
        status: "succeeded",
        jobs: [],
      },
    },
  } as ServerMessage);
  await done;
  assertEquals(serve.sent.some((r) => r.type === "cancel"), false);
});

Deno.test("workflowRunStream: an already aborted signal starts nothing", async () => {
  const serve = fakeServe();
  const client = new SwampClient(serve.transport);
  const stop = new AbortController();
  stop.abort();
  for await (
    const _ of client.workflowRunStream({ workflowIdOrName: "w" }, {
      signal: stop.signal,
    })
  ) {
    throw new Error("no event was expected");
  }
  assertEquals(serve.sent.some((r) => r.type === "workflow.run"), false);
});
