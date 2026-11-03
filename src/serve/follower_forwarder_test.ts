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

import { assert, assertEquals } from "@std/assert";
import {
  FollowerForwarder,
  isFinalFrame,
  isRpcFrame,
} from "./follower_forwarder.ts";
import type { LeaderLink } from "./leader_link.ts";

Deno.test("isFinalFrame: errors, done frames and plain replies end a request; events and more-to-come replies do not", () => {
  assert(isFinalFrame({ type: "error", id: "1" }, "workflow.run"));
  assert(isFinalFrame({ type: "done", id: "1" }, "workflow.run"));
  assert(!isFinalFrame({ type: "event", id: "1" }, "workflow.run"));
  assert(
    isFinalFrame({ type: "vault.put", id: "1", payload: {} }, "vault.put"),
  );
  assert(
    !isFinalFrame(
      { type: "audit.export", id: "1", payload: { done: false } },
      "audit.export",
    ),
  );
  assert(
    isFinalFrame(
      { type: "audit.export", id: "1", payload: { done: true } },
      "audit.export",
    ),
  );
  assert(!isFinalFrame({ type: "other", id: "1" }, "vault.put"));
  assert(isFinalFrame({ type: "run.elsewhere", id: "1" }, "run.attach"));
  assert(isFinalFrame({ type: "run.interrupted", id: "1" }, "run.attach"));
  assert(!isFinalFrame({ type: "run.attached", id: "1" }, "run.attach"));
});

Deno.test("isRpcFrame: only a worker's rpc.* frames", () => {
  assert(isRpcFrame(JSON.stringify({ type: "rpc.request", id: "1" })));
  assert(!isRpcFrame(JSON.stringify({ type: "workflow.run", id: "1" })));
  assert(!isRpcFrame(JSON.stringify({ type: "x", note: '"rpc.' })));
  assert(!isRpcFrame("not json"));
});

Deno.test("FollowerForwarder: a relayed reply over the frame limit reaches the client as frame_too_large", async () => {
  const toClient: string[] = [];
  const client = new EventTarget() as EventTarget & {
    readyState: number;
    send: (data: string) => void;
  };
  client.readyState = WebSocket.OPEN;
  client.send = (data) => toClient.push(data);
  const upstream = {
    readyState: WebSocket.OPEN,
    binaryType: "blob",
    send: () => {},
    close: () => {},
    onopen: null as (() => void) | null,
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onerror: null as (() => void) | null,
    onclose: null as (() => void) | null,
  };
  const link = {
    openSocket: () => ({ socket: upstream, leader: {} }),
  } as unknown as LeaderLink;
  const forwarder = new FollowerForwarder(
    client as unknown as WebSocket,
    link,
    { headers: {}, pathAndQuery: "/" },
  );
  const requestId = crypto.randomUUID();
  const done = Promise.withResolvers<void>();

  forwarder.forward(
    requestId,
    "data.get",
    JSON.stringify({ type: "data.get", id: requestId }),
    new AbortController().signal,
    () => done.resolve(),
  );
  upstream.onmessage?.({
    data: JSON.stringify({
      type: "data.get",
      id: requestId,
      payload: { data: { content: "x".repeat(64 * 1024 * 1024) } },
    }),
  });
  await done.promise;
  upstream.onmessage?.({
    data: JSON.stringify({ type: "done", id: requestId }),
  });

  assertEquals(toClient.length, 1);
  const reply = JSON.parse(toClient[0]);
  assertEquals([reply.type, reply.id, reply.error.code], [
    "error",
    requestId,
    "frame_too_large",
  ]);
});
