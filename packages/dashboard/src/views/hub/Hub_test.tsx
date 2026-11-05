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

/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { HubOverviewView, hubStateText } from "./Hub.tsx";
import { type HubOverview, parseOverview } from "./helpers.ts";

const NOW = Date.parse("2026-11-05T12:00:00Z");

function overview(autoExit: boolean, log: unknown = null): HubOverview {
  return parseOverview({
    hub: {
      info: {
        pid: 10,
        port: 4100,
        version: "20261105.1",
        engine: "/opt/swamp",
        autoExit,
      },
      startedAt: "2026-11-05T11:00:00Z",
      exitWhenIdle: "1m0s",
    },
    workspaces: [
      {
        name: "infra",
        path: "/repos/infra",
        trusted: true,
        engine: {
          id: "e1",
          state: "ready",
          running: true,
          pid: 55,
          pages: 2,
          startedAt: "2026-11-05T11:30:00Z",
        },
      },
      { name: "docs", path: "/repos/docs", trusted: false, engine: null },
      {
        name: "loose",
        path: "/tmp/loose",
        trusted: true,
        temporary: true,
        engine: null,
      },
    ],
    leases: [
      { id: "l1", client: "hub", scope: "all", manage: true, self: true },
      {
        id: "l2",
        client: "dashboard",
        pid: 4121,
        scope: "workspace",
        workspace: "loose",
        path: "/tmp/loose",
        pages: 1,
      },
    ],
    log,
  });
}

function render(data: HubOverview, actionError: string | null = null): string {
  return renderToStaticMarkup(
    <HubOverviewView
      overview={data}
      now={NOW}
      act={() => {}}
      actionError={actionError}
    />,
  );
}

Deno.test("HubOverviewView: shows the hub, its workspaces with engines, and its sessions", () => {
  const html = render(
    overview(true, { path: "/h/hub.log", lines: ["started", "ready"] }),
  );
  assertStringIncludes(html, "127.0.0.1:4100");
  assertStringIncludes(html, "after 1m0s with no sessions or engines");
  assertStringIncludes(html, `href="/dashboard/w/infra"`);
  assertStringIncludes(html, "running");
  assertStringIncludes(html, "pid 55");
  assertStringIncludes(html, "untrusted");
  assertStringIncludes(html, "swamp dashboard");
  assertStringIncludes(html, "pid 4121");
  assertStringIncludes(html, "This page");
  assertStringIncludes(html, "End session");
  assertStringIncludes(html, "Stop engine");
  assertStringIncludes(html, "started\nready");
  assertEquals(html.includes(`href="/dashboard/w/loose"`), false);
});

Deno.test("HubOverviewView: a service hub can't be stopped here and keeps its log in the journal", () => {
  const html = render(overview(false));
  assertStringIncludes(html, "never: runs as a user service");
  assertStringIncludes(html, "journalctl --user -u swamp-hub");
  assertStringIncludes(html, "disabled");
});

Deno.test("HubOverviewView: an action's refusal is shown above the overview", () => {
  assertStringIncludes(
    render(overview(true), "That session has already ended."),
    "That session has already ended.",
  );
});

Deno.test("hubStateText: explains each page state that has no overview", () => {
  assertEquals(hubStateText(null, false), null);
  assertEquals(
    hubStateText({ kind: "ok", overview: overview(true) }, false),
    null,
  );
  assertStringIncludes(
    hubStateText({ kind: "unauthorized" }, false)!,
    "access has ended",
  );
  assertStringIncludes(
    hubStateText({ kind: "forbidden" }, false)!,
    "can't manage the hub",
  );
  assertStringIncludes(
    hubStateText({ kind: "unavailable" }, false)!,
    "swampd",
  );
  assertEquals(
    hubStateText({ kind: "error", message: "boom" }, false),
    "boom",
  );
  assertStringIncludes(hubStateText(null, true)!, "stopped");
});
