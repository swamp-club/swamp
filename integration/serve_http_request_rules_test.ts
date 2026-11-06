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
import { fromFileUrl } from "@std/path";
import { FOLLOWER_READ_REQUESTS } from "../src/serve/follower_requests.ts";
import { HTTP_ACTION_RULES } from "../src/serve/http_action_request.ts";
import {
  DETACHED_ACTION_TYPES,
  READ_ACTION_TYPES,
} from "../src/serve/http_action_reply.ts";
import {
  HTTP_ACTION_TYPES,
  HTTP_REQUEST_TYPES,
} from "../src/serve/protocol.ts";

const SERVE_COMMAND = fromFileUrl(
  new URL("../src/cli/commands/serve.ts", import.meta.url),
);

const ACTION_ROUTE = fromFileUrl(
  new URL("../src/serve/http_action_route.ts", import.meta.url),
);

// a new action type is a decision about what an integration may do: add it here
const PINNED_ACTION_TYPES = [
  "workflow.approvals",
  "workflow.approve",
  "workflow.history.get",
  "workflow.reject",
  "workflow.resume",
  "workflow.run",
  "workflow.signal",
];

// reads may overlap the read route; any other type here would be a write the
// dashboard's cookie could reach
const WRITES = PINNED_ACTION_TYPES.filter((type) =>
  !READ_ACTION_TYPES.has(type)
);

async function actionDispatch(): Promise<string> {
  const source = await Deno.readTextFile(SERVE_COMMAND);
  const start = source.indexOf("apiUrl.pathname === SERVE_ACTION_PATH");
  assert(start !== -1, "SERVE_ACTION_PATH dispatch not found");
  const end = source.indexOf("apiUrl.pathname === SERVE_REQUEST_PATH", start);
  assert(end > start, "the action dispatch must end at the read route's");
  return source.slice(start, end);
}

Deno.test("serve HTTP route rules: the route is dispatched after the no-auth host and Origin checks", async () => {
  const source = await Deno.readTextFile(SERVE_COMMAND);
  const trustCheck = source.indexOf("= validateNoAuthApiRequest(");
  const route = source.indexOf("apiUrl.pathname === SERVE_REQUEST_PATH");
  assert(trustCheck !== -1, "validateNoAuthApiRequest call not found");
  assert(route !== -1, "SERVE_REQUEST_PATH dispatch not found");
  assert(
    trustCheck < route,
    "the HTTP request route must be dispatched after validateNoAuthApiRequest",
  );
});

Deno.test("serve HTTP route rules: every type the route answers is a read a fresh follower answers itself", () => {
  for (const type of HTTP_REQUEST_TYPES) {
    assert(
      FOLLOWER_READ_REQUESTS.has(type),
      `${type} is answered over HTTP but is not a follower read`,
    );
  }
});

Deno.test("serve HTTP route rules: the read route answers none of the action route's writes", () => {
  for (const type of WRITES) {
    assert(!HTTP_REQUEST_TYPES.has(type), `${type} would take a cookie`);
  }
});

Deno.test("serve HTTP route rules: the action route answers exactly the pinned types", () => {
  assertEquals([...HTTP_ACTION_TYPES].sort(), PINNED_ACTION_TYPES);
  assertEquals(Object.keys(HTTP_ACTION_RULES).sort(), PINNED_ACTION_TYPES);
  for (const type of [...DETACHED_ACTION_TYPES, ...READ_ACTION_TYPES]) {
    assert(HTTP_ACTION_TYPES.has(type), `${type} is not a listed action`);
  }
});

Deno.test("serve HTTP route rules: the action route is dispatched after the no-auth host and Origin checks", async () => {
  const source = await Deno.readTextFile(SERVE_COMMAND);
  const trustCheck = source.indexOf("= validateNoAuthApiRequest(");
  const route = source.indexOf("apiUrl.pathname === SERVE_ACTION_PATH");
  assert(trustCheck !== -1, "validateNoAuthApiRequest call not found");
  assert(route !== -1, "SERVE_ACTION_PATH dispatch not found");
  assert(trustCheck < route, "the action route must follow the trust check");
});

Deno.test("serve HTTP route rules: no cookie can reach the action route", async () => {
  assert(
    !(await actionDispatch()).includes("dashboardSession"),
    "serve must pass the action route no session store",
  );
  const route = await Deno.readTextFile(ACTION_ROUTE);
  assert(route.includes("authenticateHttpCaller("), "route auth not found");
  assert(
    !route.includes("dashboardSession"),
    "the action route must take no session store",
  );
});

Deno.test("serve HTTP route rules: the action route limits by person", async () => {
  const route = await Deno.readTextFile(ACTION_ROUTE);
  assert(route.includes("authenticateHttpCaller("), "route auth not found");
  assert(route.includes("limitPrincipalRate: true"));
  assert(!route.includes("limitPrincipalRate: false"));
});

Deno.test("serve HTTP route rules: the local dashboard and workspace hub never forward the action route", async () => {
  for (
    const file of [
      "../src/serve/local/workspace_hub.ts",
      "../src/serve/local/local_dashboard_server.ts",
    ]
  ) {
    const source = await Deno.readTextFile(
      fromFileUrl(new URL(file, import.meta.url)),
    );
    assert(source.includes("SERVE_REQUEST_PATH"), `${file} changed shape`);
    assert(!source.includes("SERVE_ACTION_PATH"), `${file} forwards actions`);
  }
});
