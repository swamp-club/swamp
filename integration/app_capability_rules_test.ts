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
import { join } from "@std/path";
import type * as client from "../packages/client/protocol.ts";
import type * as serve from "../src/serve/protocol.ts";
import {
  CAPABILITY_REQUESTS,
  exposedRequestTypes,
} from "../packages/app-sdk/capabilities.ts";
import { APP_SANDBOX } from "../packages/app-sdk/headers.ts";
import {
  productionSourceFiles,
  repoRelative,
  ROOT,
} from "./arch_fitness_helpers.ts";

const EXPOSED_TO_APPS = [
  "data.get",
  "data.query",
  "data.search",
  "data.subscribe",
  "data.versions",
  "model.get",
  "model.method.run",
  "model.output.search",
  "model.search",
  "model.usage.summary",
  "run.attach",
  "server.version",
  "worker.list",
  "workflow.get",
  "workflow.history.get",
  "workflow.history.logs",
  "workflow.history.search",
  "workflow.run",
  "workflow.run.search",
  "workflow.run.summary",
  "workflow.search",
] as const;

// what the federation gate adds; serve offers federation:read only with it on
const GATED_EXPOSED_TO_APPS = [
  "federation.member.get",
  "federation.member.list",
] as const;

type Exposed =
  | typeof EXPOSED_TO_APPS[number]
  | typeof GATED_EXPOSED_TO_APPS[number];

// every type an app can send is one the client declares
const _everyExposedTypeIsInTheClient: Exposed extends
  client.ServerRequest["type"] ? true : false = true;
void _everyExposedTypeIsInTheClient;

// and one serve declares
const _everyExposedTypeIsInServe: Exposed extends serve.ServerRequest["type"]
  ? true
  : false = true;
void _everyExposedTypeIsInServe;

Deno.test("app capabilities: the exposed set is exactly this list", () => {
  // pinned exactly; a type not listed is refused by default
  assertEquals([...exposedRequestTypes()].sort(), [...EXPOSED_TO_APPS].sort());
});

Deno.test("app capabilities: with the federation gate on, the exposed set adds only the two member reads", () => {
  assertEquals(
    [...exposedRequestTypes({ gated: true })].sort(),
    [...EXPOSED_TO_APPS, ...GATED_EXPOSED_TO_APPS].sort(),
  );
});

Deno.test("app capabilities: federation:read reaches the member reads and never a token or a removal", () => {
  assertEquals([...CAPABILITY_REQUESTS["federation:read"]].sort(), [
    "federation.member.get",
    "federation.member.list",
  ]);
  for (const type of Object.values(CAPABILITY_REQUESTS).flat()) {
    assert(
      !/^federation\.(token\.|member\.remove$|link\.)/.test(type),
      type,
    );
  }
});

Deno.test("app capabilities: no capability reaches a secret or the access layer", () => {
  for (const type of Object.values(CAPABILITY_REQUESTS).flat()) {
    assert(
      !/^(vault|access|audit|app|serve|datastore|extension)\./.test(type),
      type,
    );
  }
});

Deno.test("app capabilities: no CORS header is sent outside the app path", async () => {
  const offenders: string[] = [];
  for await (const path of productionSourceFiles(join(ROOT, "src"))) {
    const source = await Deno.readTextFile(path);
    if (/access-control-allow-origin/i.test(source)) {
      offenders.push(repoRelative(path));
    }
  }
  // the app platform is public and loaded by the same opaque-origin frames
  assertEquals(offenders, ["src/serve/app_platform_assets.ts"]);
});

Deno.test("app capabilities: the frame is never given same-origin", () => {
  const tokens = APP_SANDBOX.split(/\s+/).filter((t) => t.length > 0);
  for (const token of tokens) {
    assert(token !== "allow-same-origin", token);
    assert(!token.startsWith("allow-top-navigation"), token);
    assert(token !== "allow-modals", token);
  }
  assertEquals([...tokens].sort(), [
    "allow-forms",
    "allow-popups",
    "allow-popups-to-escape-sandbox",
    "allow-scripts",
  ]);
});

Deno.test("app capabilities: the dashboard frame takes its sandbox from APP_SANDBOX", async () => {
  const text = await Deno.readTextFile(
    join(ROOT, "packages/dashboard/src/apps/AppFrame.tsx"),
  );
  assert(/import\s*\{[^}]*\bAPP_SANDBOX\b[^}]*\}\s*from/.test(text));
  const sandboxAttrs = [
    ...text.matchAll(/\bsandbox=(\{[^}]*\}|"[^"]*"|'[^']*')/g),
  ]
    .map((m) => m[1]);
  assert(sandboxAttrs.length > 0, "AppFrame sets no sandbox attribute");
  for (const value of sandboxAttrs) {
    const name = value.slice(1, -1).trim();
    assert(value.startsWith("{"), `sandbox is a literal: ${value}`);
    const direct = name === "APP_SANDBOX";
    // an alias must be bound to APP_SANDBOX itself
    const aliased = new RegExp(`const\\s+${name}\\s*=\\s*APP_SANDBOX\\s*;`)
      .test(text);
    assert(direct || aliased, `sandbox={${name}} is not APP_SANDBOX`);
  }
  assert(!/allow-scripts/.test(text), "AppFrame spells out sandbox tokens");
});

Deno.test("app capabilities: an app's frames never travel on the dashboard's socket", async () => {
  const provider = await Deno.readTextFile(
    join(ROOT, "packages/dashboard/src/client/SwampProvider.tsx"),
  );
  // the dashboard's connection offers no raw frame sender to forward through
  assert(!/\bsendFrame\b/.test(provider), "SwampProvider exposes sendFrame");
  const frame = await Deno.readTextFile(
    join(ROOT, "packages/dashboard/src/apps/AppFrame.tsx"),
  );
  const fromDashboard = /const\s*\{([^}]*)\}\s*=\s*useSwamp\(\)/.exec(frame);
  assert(fromDashboard !== null, "AppFrame reads no useSwamp() fields");
  for (const field of ["sendFrame", "requestDetached"]) {
    assert(!new RegExp(`\\b${field}\\b`).test(fromDashboard[1]), field);
  }
  assert(/new AppConnection\(/.test(frame), "AppFrame opens no app socket");
  assert(
    /sendFrame:\s*\([^)]*\)\s*=>\s*connection\.sendFrame\(/.test(frame),
    "the broker's frames go somewhere other than the app's socket",
  );
  assert(
    /request:\s*\([^)]*\)\s*=>\s*connection\.request\(/.test(frame),
    "the broker's reads go somewhere other than the app's socket",
  );
});
