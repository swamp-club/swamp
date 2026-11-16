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
  createWorkspaceRouter,
  type WorkspaceDirectory,
  type WorkspaceRoute,
} from "./workspace_router.ts";

const INFO: Deno.ServeHandlerInfo<Deno.NetAddr> = {
  remoteAddr: { transport: "tcp", hostname: "203.0.113.7", port: 50000 },
  completed: Promise.resolve(),
};

function directoryOf(
  workspaces: Record<string, WorkspaceRoute>,
  root?: WorkspaceRoute,
): WorkspaceDirectory {
  return {
    workspace: (name) => workspaces[name],
    root: () => root,
  };
}

async function answer(
  directory: WorkspaceDirectory,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const shutdown = new AbortController();
  try {
    const router = createWorkspaceRouter({
      directory,
      protocol: "https",
      trustProxy: false,
      signal: shutdown.signal,
    });
    const response = await router.handle(
      new Request(`https://serve.acme.internal${path}`),
      INFO,
    );
    return { status: response.status, body: await response.json() };
  } finally {
    shutdown.abort();
  }
}

Deno.test("createWorkspaceRouter: an unknown workspace name answers 404", async () => {
  const { status } = await answer(directoryOf({}), "/w/edge-dns/api");
  assertEquals(status, 404);
});

Deno.test("createWorkspaceRouter: a path under /w/ naming no valid workspace answers 404 without asking the root", async () => {
  const root: WorkspaceRoute = { kind: "running", port: 1 };
  for (const path of ["/w/", "/w/Bad/x", "/w"]) {
    const { status } = await answer(directoryOf({}, root), path);
    assertEquals(status, 404, path);
  }
});

Deno.test("createWorkspaceRouter: a path outside /w/ answers 404 when there is no root", async () => {
  const { status } = await answer(directoryOf({}), "/api/v1/request");
  assertEquals(status, 404);
});

Deno.test("createWorkspaceRouter: a workspace that is not running answers 503 naming it and its state", async () => {
  const { status, body } = await answer(
    directoryOf({ "edge-dns": { kind: "unavailable", state: "backoff" } }),
    "/w/edge-dns/api",
  );
  assertEquals(status, 503);
  assertEquals(body, {
    error: "The workspace is not running.",
    workspace: "edge-dns",
    state: "backoff",
  });
});

Deno.test("createWorkspaceRouter: a root that is not running answers 503 with its state", async () => {
  const { status, body } = await answer(
    directoryOf({}, { kind: "unavailable", state: "starting" }),
    "/api/v1/request",
  );
  assertEquals(status, 503);
  assertEquals(body, {
    error: "The workspace is not running.",
    state: "starting",
  });
});

Deno.test("createWorkspaceRouter: a router already shut down answers 503 without forwarding", async () => {
  const shutdown = new AbortController();
  const router = createWorkspaceRouter({
    directory: directoryOf({ a: { kind: "running", port: 1 } }),
    protocol: "https",
    trustProxy: false,
    signal: shutdown.signal,
  });
  shutdown.abort();
  const response = await router.handle(
    new Request("https://serve.acme.internal/w/a/api"),
    INFO,
  );
  assertEquals(response.status, 503);
  assertEquals(await response.json(), { error: "The host is shutting down." });
});
