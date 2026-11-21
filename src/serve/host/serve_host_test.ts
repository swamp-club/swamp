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
import { resolve } from "@std/path";
import {
  type ObservedServeState,
  ROOT_SERVE,
  type ServeId,
  serveIdKey,
  type WantedServeState,
  workspaceServe,
} from "../../domain/serve/managed_serve.ts";
import { HostConfig } from "./host_config.ts";
import { hostLayout } from "./host_layout.ts";
import { hostDirectory, noAuthAdmission } from "./serve_host.ts";
import type { ServeChildSpec } from "./serve_process.ts";
import type { ServeStatus } from "./supervisor.ts";

const SPEC: ServeChildSpec = {
  id: workspaceServe("edge-dns"),
  repoDir: "/r",
  address: "https://a/w/edge-dns",
  trustedHost: "a",
  env: {},
};

function config(yaml: string): HostConfig {
  return HostConfig.parse(
    yaml,
    hostLayout({ configDir: resolve("config"), dataDir: resolve("data") }),
  );
}

function status(
  id: ServeId,
  wanted: WantedServeState,
  observed: ObservedServeState,
  extra: Partial<ServeStatus> = {},
): ServeStatus {
  return {
    id,
    wanted,
    observed,
    port: null,
    authMode: null,
    refusal: null,
    crashCount: 0,
    restarts: 0,
    lastExit: null,
    ...extra,
  };
}

function lookupOf(statuses: ServeStatus[]) {
  const byKey = new Map(statuses.map((s) => [serveIdKey(s.id), s]));
  return { lookup: (id: ServeId) => byKey.get(serveIdKey(id)) };
}

Deno.test("noAuthAdmission: a loopback host admits every child", () => {
  assertEquals(
    noAuthAdmission(config("address: http://127.0.0.1:8080\n")),
    undefined,
  );
});

Deno.test("noAuthAdmission: a host behind a proxy refuses only a child in auth mode none", () => {
  const admit = noAuthAdmission(
    config("address: https://a\ntrust-proxy: true\n"),
  )!;
  assertEquals(
    admit(SPEC, { port: 1, authMode: "none" })?.includes("trust-proxy"),
    true,
  );
  assertEquals(admit(SPEC, { port: 1, authMode: "token" }), null);
  assertEquals(admit(SPEC, { port: 1, authMode: "oauth" }), null);
});

Deno.test("noAuthAdmission: an off-loopback host refuses a child in auth mode none", () => {
  const admit = noAuthAdmission(
    config(
      "address: https://a\nlisten: {host: 0.0.0.0, cert-file: c, key-file: k}\n",
    ),
  )!;
  assertEquals(
    admit(SPEC, { port: 1, authMode: "none" })?.includes("off loopback"),
    true,
  );
  assertEquals(admit(SPEC, { port: 1, authMode: "token" }), null);
});

Deno.test("hostDirectory: answers each workspace from the supervisor's status", () => {
  const directory = hostDirectory(
    config("address: http://a\nroot: ../root\n"),
    lookupOf([
      status(workspaceServe("up"), "running", "ready", { port: 41_001 }),
      status(workspaceServe("booting"), "running", "starting"),
      status(workspaceServe("crashed"), "running", "backoff"),
      status(workspaceServe("gone"), "deleted", "stopped"),
      status(workspaceServe("refused"), "suspended", "stopped", {
        refusal: "auth mode none",
      }),
      status(ROOT_SERVE, "running", "ready", { port: 41_000 }),
    ]),
  );
  assertEquals(directory.workspace("up"), { kind: "running", port: 41_001 });
  assertEquals(directory.workspace("booting"), {
    kind: "unavailable",
    state: "starting",
  });
  assertEquals(directory.workspace("crashed"), {
    kind: "unavailable",
    state: "backoff",
  });
  assertEquals(directory.workspace("gone"), undefined);
  assertEquals(directory.workspace("never"), undefined);
  assertEquals(directory.workspace("refused"), {
    kind: "unavailable",
    state: "refused",
  });
  assertEquals(directory.root(), { kind: "running", port: 41_000 });
});

Deno.test("hostDirectory: a host with no root answers nothing for the root", () => {
  const directory = hostDirectory(
    config("address: http://a\n"),
    lookupOf([status(ROOT_SERVE, "running", "ready", { port: 41_000 })]),
  );
  assertEquals(directory.root(), undefined);
});
