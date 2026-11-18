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
import { UserError } from "../domain/errors.ts";
import { withMockedEnv } from "../infrastructure/persistence/path_test_helpers.ts";
import { validateServerRequest } from "../serve/connection.ts";
import { NOT_A_HOST_ROOT_CODE } from "../serve/handlers/workspace_handlers.ts";
import {
  resetMarkerServerAddress,
  ServerResponseError,
  setMarkerServerAddress,
} from "./remote_run.ts";
import type { RequestResponseOptions } from "./remote_run.ts";
import {
  namedWorkspaceRequest,
  sendWorkspaceRequest,
  type WorkspaceRequest,
  type WorkspaceRequestDeps,
} from "./serve_workspace_request.ts";

const NO_SERVER_ENV = {
  SWAMP_SERVE_URL: undefined,
  SWAMP_SERVER_URL: undefined,
};

interface Sent {
  options: RequestResponseOptions;
  request: WorkspaceRequest;
}

function fakeDeps(
  reply: unknown,
): { sent: Sent[]; deps: WorkspaceRequestDeps } {
  const sent: Sent[] = [];
  return {
    sent,
    deps: {
      request: <T>(
        options: RequestResponseOptions,
        request: WorkspaceRequest,
      ) => {
        sent.push({ options, request });
        return reply instanceof Error
          ? Promise.reject(reply)
          : Promise.resolve(reply as T);
      },
      resolveToken: () => Promise.resolve("root-token"),
    },
  };
}

function refusal(code: string, message: string): ServerResponseError {
  return new ServerResponseError({ code, message });
}

async function refusedWith(
  code: string,
  message: string,
  request: WorkspaceRequest = namedWorkspaceRequest("workspace.get", "edge"),
): Promise<UserError> {
  const { deps } = fakeDeps(refusal(code, message));
  return await assertRejects(
    () =>
      sendWorkspaceRequest(
        { server: "https://host.example" },
        request,
        deps,
      ),
    UserError,
  );
}

Deno.test("sendWorkspaceRequest: sends the request to --server with the resolved token", async () => {
  const { sent, deps } = fakeDeps({ data: { workspaces: [] } });
  const reply = await sendWorkspaceRequest(
    { server: "https://host.example" },
    { type: "workspace.list" },
    deps,
  );
  assertEquals(reply, { data: { workspaces: [] } });
  assertEquals(sent, [{
    options: { server: "https://host.example", token: "root-token" },
    request: { type: "workspace.list" },
  }]);
});

Deno.test("sendWorkspaceRequest: without --server it uses the repo's server address", async () => {
  setMarkerServerAddress("https://marker.example");
  try {
    await withMockedEnv(NO_SERVER_ENV, async () => {
      const { sent, deps } = fakeDeps({ data: { workspaces: [] } });
      await sendWorkspaceRequest({}, { type: "workspace.list" }, deps);
      assertEquals(sent[0].options.server, "https://marker.example");
    });
  } finally {
    resetMarkerServerAddress();
  }
});

Deno.test("sendWorkspaceRequest: with no server anywhere it names --server and sends nothing", async () => {
  resetMarkerServerAddress();
  await withMockedEnv(NO_SERVER_ENV, async () => {
    const { sent, deps } = fakeDeps({});
    const error = await assertRejects(
      () => sendWorkspaceRequest({}, { type: "workspace.list" }, deps),
      UserError,
    );
    assertEquals(error.code, "server_required");
    assert(error.message.includes("--server"));
    assertEquals(sent, []);
  });
});

Deno.test("namedWorkspaceRequest: refuses a name serve's schema would refuse, before anything is sent", () => {
  for (const name of ["", "a".repeat(64), "Edge", "-edge", "edge/dns"]) {
    let refused = false;
    try {
      namedWorkspaceRequest("workspace.create", name);
    } catch (error) {
      refused = error instanceof UserError;
    }
    assert(refused, `expected ${JSON.stringify(name)} to be refused`);
  }
});

Deno.test("namedWorkspaceRequest: every request it builds passes serve's request schema", () => {
  const requests: WorkspaceRequest[] = [
    { type: "workspace.list" },
    namedWorkspaceRequest("workspace.create", "edge-dns"),
    namedWorkspaceRequest("workspace.get", "edge-dns"),
    namedWorkspaceRequest("workspace.suspend", "edge-dns"),
    namedWorkspaceRequest("workspace.resume", "edge-dns"),
    namedWorkspaceRequest("workspace.delete", "a".repeat(63)),
  ];
  for (const request of requests) {
    const validated = validateServerRequest({ ...request, id: "request-1" });
    assert(
      typeof validated !== "string",
      `${request.type}: ${String(validated)}`,
    );
  }
});

Deno.test("sendWorkspaceRequest: an unknown workspace reads as the root's message", async () => {
  const error = await refusedWith(
    "not_found",
    "No hosted workspace named edge.",
  );
  assertEquals(error.message, "No hosted workspace named edge.");
  assertEquals(error.code, "not_found");
});

Deno.test("sendWorkspaceRequest: a taken name reads as the root's message", async () => {
  const message =
    "The name edge is taken: a workspace, a link or a wanted file already holds it.";
  const error = await refusedWith(
    "already_exists",
    message,
    namedWorkspaceRequest("workspace.create", "edge"),
  );
  assertEquals(error.message, message);
  assertEquals(error.code, "already_exists");
});

Deno.test("sendWorkspaceRequest: a refused request names the root and keeps its reason", async () => {
  const error = await refusedWith(
    "unauthorized",
    "Permission denied: admin on access:*",
  );
  assertEquals(
    error.message,
    "The root at https://host.example refused the request: Permission denied: admin on access:*",
  );
  assertEquals(error.code, "unauthorized");
});

Deno.test("sendWorkspaceRequest: a serve that is not a host's root says to point --server at the host", async () => {
  const error = await refusedWith(
    NOT_A_HOST_ROOT_CODE,
    "This serve answers no workspace requests: only the root of a swamp serve host does.",
  );
  assertEquals(
    error.message,
    "https://host.example is not a host's root, so it answers no workspace requests. Pass --server the swamp serve host's own address, not a workspace's.",
  );
  assertEquals(error.code, "not_a_host_root");
});

Deno.test("sendWorkspaceRequest: a serve that predates workspace requests is reported as such", async () => {
  const error = await refusedWith(
    "invalid_request",
    "Invalid request: type: Invalid input",
  );
  assertEquals(
    error.message,
    "https://host.example does not answer workspace requests: it is not a swamp serve host's root, or it runs a swamp that predates them.",
  );
  assertEquals(error.code, "unsupported_by_server");
});

Deno.test("sendWorkspaceRequest: an older token-mode root's refusal of create reads as the root's message", async () => {
  const message =
    "A root in token mode cannot create a workspace yet: its creator would have no way to get a token inside it until signing in to a workspace through the root exists.";
  const error = await refusedWith(
    "token_mode_create_refused",
    message,
    namedWorkspaceRequest("workspace.create", "edge"),
  );
  assertEquals(error.message, message);
  assertEquals(error.code, "token_mode_create_refused");
});

Deno.test("sendWorkspaceRequest: the server address in a message drops credentials", async () => {
  const { deps } = fakeDeps(refusal("unauthorized", "denied"));
  const error = await assertRejects(
    () =>
      sendWorkspaceRequest(
        { server: "https://user:secret@host.example/?token=abc" },
        { type: "workspace.list" },
        deps,
      ),
    UserError,
  );
  assertEquals(
    error.message,
    "The root at https://host.example refused the request: denied",
  );
});

Deno.test("sendWorkspaceRequest: any other error passes through unchanged", async () => {
  const other = refusal("rate_limited", "Slow down");
  const { deps } = fakeDeps(other);
  const error = await assertRejects(() =>
    sendWorkspaceRequest(
      { server: "https://host.example" },
      { type: "workspace.list" },
      deps,
    )
  );
  assert(error === other);

  const unreachable = new UserError("Could not connect to wss://host.example");
  const { deps: down } = fakeDeps(unreachable);
  const downError = await assertRejects(() =>
    sendWorkspaceRequest(
      { server: "https://host.example" },
      { type: "workspace.list" },
      down,
    )
  );
  assert(downError === unreachable);
});
