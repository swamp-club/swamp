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
  engineStatus,
  formatDuration,
  type HubLease,
  type HubServe,
  parseOverview,
  serveAuthNote,
  serveDashboardUrl,
  serveIsLive,
  serveStatus,
  sessionLabel,
  sessionScope,
  since,
} from "./helpers.ts";

const lease = (fields: Partial<HubLease>): HubLease => ({
  id: "l",
  scope: "all",
  manage: false,
  pages: 0,
  backend: false,
  createdAt: "",
  renewedAt: "",
  self: false,
  ...fields,
});

Deno.test("parseOverview: reads the hub, workspaces, leases and log", () => {
  const overview = parseOverview({
    hub: {
      info: { pid: 10, port: 4100, version: "dev", autoExit: true },
      startedAt: "2026-11-05T10:00:00Z",
      exitWhenIdle: "1m0s",
    },
    workspaces: [
      {
        name: "a",
        path: "/repos/a",
        trusted: true,
        engine: { id: "e1", state: "ready", running: true, pid: 55, pages: 2 },
      },
      { name: "b", path: "/repos/b", engine: null },
      { name: 3, path: "/bad" },
    ],
    leases: [{
      id: "l1",
      client: "hub",
      scope: "all",
      manage: true,
      self: true,
    }, {}],
    log: { path: "/x/hub.log", lines: ["one", 2, "three"] },
  });
  assertEquals(overview.hub.pid, 10);
  assertEquals(overview.hub.autoExit, true);
  assertEquals(overview.hub.exitWhenIdle, "1m0s");
  assertEquals(overview.workspaces.map((w) => w.name), ["a", "b"]);
  assertEquals(overview.workspaces[0].engine?.pid, 55);
  assertEquals(overview.workspaces[0].engine?.pages, 2);
  assertEquals(overview.workspaces[1].engine, null);
  assertEquals(overview.leases.length, 1);
  assertEquals(overview.leases[0].self, true);
  assertEquals(overview.log, { path: "/x/hub.log", lines: ["one", "three"] });
});

Deno.test("parseOverview: an empty or odd reply gives an empty overview", () => {
  const overview = parseOverview(null);
  assertEquals(overview.workspaces, []);
  assertEquals(overview.leases, []);
  assertEquals(overview.log, null);
  assertEquals(overview.hub.autoExit, false);
  assertEquals(parseOverview({ log: null }).log, null);
});

Deno.test("engineStatus: maps engine states to a pill tone and word", () => {
  assertEquals(engineStatus(null), { tone: "idle", label: "stopped" });
  const engine = {
    id: "e",
    ready: true,
    running: true,
    sessions: 0,
    pages: 0,
    starts: 1,
  };
  assertEquals(engineStatus({ ...engine, state: "ready" }), {
    tone: "active",
    label: "running",
  });
  assertEquals(engineStatus({ ...engine, state: "ready", running: false }), {
    tone: "idle",
    label: "stopped",
  });
  assertEquals(engineStatus({ ...engine, state: "starting" }).tone, "running");
  assertEquals(engineStatus({ ...engine, state: "broken" }).tone, "failed");
  assertEquals(engineStatus({ ...engine, state: "draining" }).tone, "degraded");
});

Deno.test("sessionLabel and sessionScope: name the command and what it reaches", () => {
  assertEquals(sessionLabel(lease({ client: "start" })), "swamp start");
  assertEquals(
    sessionLabel(lease({ client: "dashboard", scope: "workspace" })),
    "swamp dashboard",
  );
  assertEquals(sessionLabel(lease({ client: "hub" })), "swamp hub open");
  assertEquals(sessionLabel(lease({})), "every workspace");
  assertEquals(
    sessionScope(lease({ manage: true })),
    "all workspaces, manages the hub",
  );
  assertEquals(
    sessionScope(lease({ scope: "workspace", workspace: "infra" })),
    "infra",
  );
});

Deno.test("formatDuration and since: two largest units, a dash for nothing", () => {
  assertEquals(formatDuration(-5), "0s");
  assertEquals(formatDuration(45_000), "45s");
  assertEquals(formatDuration(12 * 60_000), "12m");
  assertEquals(formatDuration(3 * 3_600_000 + 5 * 60_000), "3h 5m");
  assertEquals(formatDuration(2 * 3_600_000), "2h");
  assertEquals(formatDuration(52 * 3_600_000), "2d 4h");
  assertEquals(since(undefined, 0), "—");
  assertEquals(since("not a date", 0), "—");
  assertEquals(
    since("2026-11-05T10:00:00Z", Date.parse("2026-11-05T10:01:30Z")),
    "1m",
  );
});

Deno.test("parseOverview: reads each workspace's swamp serves and drops odd ones", () => {
  const overview = parseOverview({
    workspaces: [{
      name: "a",
      path: "/repos/a",
      serves: [
        { id: "s1", owner: "hub", state: "failed", exitCode: 1, reason: "x" },
        { owner: "someone", state: "running", port: 9190 },
        { state: 3 },
      ],
    }, { name: "b", path: "/repos/b" }],
    servesError: "nope",
  });
  assertEquals(overview.workspaces[0].serves.length, 2);
  assertEquals(overview.workspaces[0].serves[0].exitCode, 1);
  assertEquals(overview.workspaces[0].serves[1].owner, "other");
  assertEquals(overview.workspaces[1].serves, []);
  assertEquals(overview.servesError, "nope");
});

Deno.test("serve labels: state tones, dashboard link only while live, auth notes", () => {
  const serve = (fields: Partial<HubServe>): HubServe => ({
    owner: "hub",
    state: "running",
    dashboard: true,
    url: "http://127.0.0.1:9190",
    ...fields,
  });
  assertEquals(serveStatus(serve({})), { tone: "active", label: "running" });
  assertEquals(serveStatus(serve({ state: "starting" })).tone, "running");
  assertEquals(serveStatus(serve({ state: "failed" })).tone, "failed");
  assertEquals(serveIsLive(serve({ state: "exited" })), false);
  assertEquals(
    serveDashboardUrl(serve({})),
    "http://127.0.0.1:9190/dashboard",
  );
  assertEquals(serveDashboardUrl(serve({ dashboard: false })), undefined);
  assertEquals(serveDashboardUrl(serve({ state: "exited" })), undefined);
  assertEquals(serveAuthNote(serve({ authMode: "none" })), "no login");
  assertEquals(serveAuthNote(serve({ authMode: "token" })), "token login");
  assertEquals(serveAuthNote(serve({})), undefined);
});
