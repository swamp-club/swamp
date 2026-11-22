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
import { withMockedFetch } from "@swamp-club/swamp-testing";
import {
  ROOT_SERVE,
  workspaceServe,
} from "../../domain/serve/managed_serve.ts";
import {
  exitCode,
  linesOf,
  pollReady,
  readListening,
  StderrTail,
} from "./deno_serve_process.ts";
import { serveChildArgs } from "./serve_process.ts";

function bytes(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return ReadableStream.from(chunks.map((c) => encoder.encode(c)));
}

Deno.test("readListening: returns the port and auth mode from the listening line and leaves the rest unread", async () => {
  const lines = linesOf(bytes(
    "not json\n",
    '{"status":"starting"}\n',
    '{"status":"listening","host":"127.0.0.1","port":41001,"authMode":"oauth"}\n',
    "after\n",
  ));
  assertEquals(await readListening(lines), {
    port: 41_001,
    authMode: "oauth",
  });
  assertEquals((await lines.read()).value, "after");
});

Deno.test("readListening: reads a line split across chunks", async () => {
  const lines = linesOf(
    bytes('{"status":"list', 'ening","po', 'rt":7,"authMode":"none"}\n'),
  );
  assertEquals(await readListening(lines), { port: 7, authMode: "none" });
});

Deno.test("readListening: ignores a line with an invalid port or no auth mode", async () => {
  const lines = linesOf(bytes(
    '{"status":"listening","port":"41001","authMode":"token"}\n',
    '{"status":"listening","port":0,"authMode":"token"}\n',
    '{"status":"listening","port":70000,"authMode":"token"}\n',
    '{"status":"listening","port":1.5,"authMode":"token"}\n',
    '{"status":"listening","port":41001}\n',
    "null\n",
  ));
  assertEquals(await readListening(lines), null);
});

Deno.test("linesOf: cuts a long line, drops its rest and reads on", async () => {
  const lines = linesOf(bytes("abcdef", "ghij\r\nnext\r\n", "last"), 4);
  const read: string[] = [];
  for (let r = await lines.read(); !r.done; r = await lines.read()) {
    read.push(r.value);
  }
  assertEquals(read, ["abcd", "next", "last"]);
});

Deno.test("readListening: null when the stream ends before listening", async () => {
  assertEquals(await readListening(linesOf(bytes("booting\n"))), null);
});

Deno.test("pollReady: retries until /ready answers 200", async () => {
  let attempt = 0;
  const { result, calls } = await withMockedFetch(() => {
    attempt++;
    if (attempt === 1) throw new TypeError("connection refused");
    if (attempt === 2) return new Response("not ready", { status: 503 });
    return new Response("ok", { status: 200 });
  }, () => pollReady(41_001, new AbortController().signal, 1));
  assertEquals(result, true);
  assertEquals(calls.map((c) => c.url), [
    "http://127.0.0.1:41001/ready",
    "http://127.0.0.1:41001/ready",
    "http://127.0.0.1:41001/ready",
  ]);
});

Deno.test("pollReady: false when aborted before /ready answers 200", async () => {
  const controller = new AbortController();
  const { result, calls } = await withMockedFetch(() => {
    controller.abort();
    return new Response("not ready", { status: 503 });
  }, () => pollReady(41_001, controller.signal, 60_000));
  assertEquals(result, false);
  assertEquals(calls.length, 1);
});

Deno.test("pollReady: false at once for an aborted signal", async () => {
  const { result, calls } = await withMockedFetch(
    [],
    () => pollReady(41_001, AbortSignal.abort(), 1),
  );
  assertEquals(result, false);
  assertEquals(calls.length, 0);
});

Deno.test("StderrTail: keeps only the last lines", () => {
  const tail = new StderrTail(2);
  for (const line of ["a", "b", "c"]) tail.push(line);
  assertEquals(tail.lines(), ["b", "c"]);
});

Deno.test("exitCode: a signal death has no exit code", () => {
  assertEquals(exitCode({ code: 143, signal: "SIGTERM" }), null);
  assertEquals(exitCode({ code: 75, signal: null }), 75);
});

Deno.test("serveChildArgs: the flags the host adds to every child", () => {
  assertEquals(
    serveChildArgs({
      id: workspaceServe("edge-dns"),
      repoDir: "/host/workspaces/edge-dns",
      address: "https://serve.example/w/edge-dns",
      trustedHost: "serve.example",
      env: {},
    }),
    [
      "serve",
      "--json",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--address",
      "https://serve.example/w/edge-dns",
      "--trusted-hosts",
      "serve.example",
      "--trust-proxy",
      "--exit-on-stdin-close",
      "--hosted-workspace",
      "--repo-dir",
      "/host/workspaces/edge-dns",
    ],
  );
});

Deno.test("serveChildArgs: only a spec with the host's workspaces folder is given it and the host's address", () => {
  const spec = {
    id: ROOT_SERVE,
    repoDir: "/host/root",
    address: "https://serve.example",
    trustedHost: "serve.example",
    env: {},
  };
  const root = serveChildArgs({
    ...spec,
    hostWorkspaces: {
      dir: "/host/workspaces",
      address: "https://serve.example",
    },
  });
  assertEquals(root.includes("--host-no-folder"), false);
  assertEquals(
    root.slice(-4),
    [
      "--host-workspaces-dir",
      "/host/workspaces",
      "--host-address",
      "https://serve.example",
    ],
  );
  assertEquals(root.includes("--hosted-workspace"), false);
  const plain = serveChildArgs(spec);
  assertEquals(plain.includes("--host-workspaces-dir"), false);
  assertEquals(plain.includes("--host-address"), false);
});

Deno.test("serveChildArgs: a spec with the root's address is given it, and one without is not", () => {
  const spec = {
    id: workspaceServe("edge-dns"),
    repoDir: "/host/workspaces/edge-dns",
    address: "https://serve.example/w/edge-dns",
    trustedHost: "serve.example",
    env: {},
  };
  const args = serveChildArgs({
    ...spec,
    rootAddress: "https://serve.example",
    oauthClient: { id: "client-123", secretFile: "/run/secrets/oauth" },
  });
  const at = args.indexOf("--root-address");
  assert(at > 0);
  assertEquals(args[at + 1], "https://serve.example");
  assertEquals(args.slice(-4)[0], "--oauth-client-id");
  assertEquals(serveChildArgs(spec).includes("--root-address"), false);
});

Deno.test("serveChildArgs: an OAuth client adds its id and the path of its secret file", () => {
  const args = serveChildArgs({
    id: workspaceServe("edge-dns"),
    repoDir: "/host/workspaces/edge-dns",
    address: "https://serve.example/w/edge-dns",
    trustedHost: "serve.example",
    env: {},
    oauthClient: { id: "client-123", secretFile: "/run/secrets/oauth" },
  });
  assertEquals(args.slice(-4), [
    "--oauth-client-id",
    "client-123",
    "--oauth-client-secret-file",
    "/run/secrets/oauth",
  ]);
  assertEquals(
    serveChildArgs({
      id: workspaceServe("edge-dns"),
      repoDir: "/host/workspaces/edge-dns",
      address: "https://serve.example/w/edge-dns",
      trustedHost: "serve.example",
      env: {},
      oauthClient: null,
    }).includes("--oauth-client-id"),
    false,
  );
});
