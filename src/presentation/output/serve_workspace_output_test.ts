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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import type { HostedWorkspaceSummaryData } from "../../serve/protocol.ts";
import {
  renderWorkspaceChange,
  renderWorkspaceCreate,
  renderWorkspaceGet,
  renderWorkspaceList,
  renderWorkspaceRmCancelled,
} from "./serve_workspace_output.ts";

function captured(fn: () => void): string {
  const lines: string[] = [];
  const original = console.log;
  console.log = (message: string) => lines.push(message);
  try {
    fn();
  } finally {
    console.log = original;
  }
  return stripAnsiCode(lines.join("\n"));
}

function summary(
  overrides: Partial<HostedWorkspaceSummaryData> = {},
): HostedWorkspaceSummaryData {
  return {
    name: "edge-dns",
    address: "https://host.example/w/edge-dns",
    wanted: "active",
    state: "ready",
    restarts: 0,
    reason: null,
    ...overrides,
  };
}

const TARGET = " --server https://host.example";

Deno.test("renderWorkspaceCreate: json reports the workspace stopped and the command that starts it", () => {
  const out = captured(() =>
    renderWorkspaceCreate(
      {
        name: "edge-dns",
        address: "https://host.example/w/edge-dns",
        wanted: "suspended",
      },
      "json",
      TARGET,
    )
  );
  assertEquals(JSON.parse(out), {
    name: "edge-dns",
    address: "https://host.example/w/edge-dns",
    wanted: "suspended",
    state: "stopped",
    start:
      "swamp serve workspace resume edge-dns --server https://host.example",
  });
});

Deno.test("renderWorkspaceCreate: log names the address, says stopped and names resume", () => {
  const out = captured(() =>
    renderWorkspaceCreate(
      {
        name: "edge-dns",
        address: "https://host.example/w/edge-dns",
        wanted: "suspended",
      },
      "log",
      TARGET,
    )
  );
  assertStringIncludes(out, "Created: edge-dns");
  assertStringIncludes(out, "Address: https://host.example/w/edge-dns");
  assertStringIncludes(out, "State: stopped");
  assertStringIncludes(
    out,
    "swamp serve workspace resume edge-dns --server https://host.example",
  );
});

Deno.test("renderWorkspaceList: json carries each workspace as the root sent it", () => {
  const workspaces = [summary(), summary({ name: "b", state: null })];
  const out = captured(() => renderWorkspaceList(workspaces, "json", ""));
  assertEquals(JSON.parse(out), { workspaces });
});

Deno.test("renderWorkspaceList: log shows names, addresses and states", () => {
  const out = captured(() =>
    renderWorkspaceList(
      [
        summary(),
        summary({
          name: "batch",
          address: "https://host.example/w/batch",
          wanted: "active",
          state: "backoff",
          restarts: 3,
        }),
      ],
      "log",
      "",
    )
  );
  const lines = out.split("\n");
  assertEquals(lines[0].split(/\s+/), ["NAME", "ADDRESS", "STATE", "RESTARTS"]);
  assertEquals(lines[1].split(/\s+/), [
    "edge-dns",
    "https://host.example/w/edge-dns",
    "ready",
    "0",
  ]);
  assertEquals(lines[2].split(/\s+/), [
    "batch",
    "https://host.example/w/batch",
    "backoff",
    "3",
  ]);
});

Deno.test("renderWorkspaceList: a suspended workspace the host has not reported on reads stopped in log and null in json", () => {
  const fresh = summary({ wanted: "suspended", state: null, restarts: null });
  const log = captured(() => renderWorkspaceList([fresh], "log", ""));
  assertEquals(log.split("\n")[1].split(/\s+/).slice(2), ["stopped", "-"]);
  const json = captured(() => renderWorkspaceList([fresh], "json", ""));
  assertEquals(JSON.parse(json).workspaces[0].state, null);
});

Deno.test("renderWorkspaceList: a wanted state the host has not reached is shown beside the observed one", () => {
  const out = captured(() =>
    renderWorkspaceList(
      [
        summary({ wanted: "suspended", state: "ready" }),
        summary({ name: "gone", wanted: "deleted", state: "stopped" }),
        summary({ name: "odd", wanted: null, state: null }),
      ],
      "log",
      "",
    )
  );
  assertStringIncludes(out, "ready → suspended");
  assertStringIncludes(out, "stopped → deleted");
  assertStringIncludes(out, "unknown (wanted file unreadable)");
});

Deno.test("renderWorkspaceList: log with no workspaces says so and names create", () => {
  const out = captured(() => renderWorkspaceList([], "log", TARGET));
  assertStringIncludes(out, "No hosted workspaces.");
  assertStringIncludes(
    out,
    "swamp serve workspace create <name> --server https://host.example",
  );
});

Deno.test("renderWorkspaceList: escapes control characters the root sent", () => {
  const out = captured(() =>
    renderWorkspaceList(
      [summary({ name: "a\x1b[2Jb", address: "https://h\x07" })],
      "log",
      "",
    )
  );
  assert(!out.includes("\x1b"));
  assert(!out.includes("\x07"));
  assertStringIncludes(out, "a\\x1b[2Jb");
  assertStringIncludes(out, "https://h\\x07");
});

Deno.test("renderWorkspaceList: an owner column appears only when the root sends owners", () => {
  const older = captured(() => renderWorkspaceList([summary()], "log", TARGET));
  assertEquals(older.includes("OWNER"), false);
  const newer = captured(() =>
    renderWorkspaceList(
      [
        summary({ owner: "host" }),
        summary({ name: "mine", owner: "operator" }),
        summary({ name: "pending" }),
      ],
      "log",
      TARGET,
    )
  );
  const lines = newer.split("\n");
  assertStringIncludes(lines[0], "OWNER");
  assert(lines[1].trimEnd().endsWith("host"), lines[1]);
  assert(lines[2].trimEnd().endsWith("operator"), lines[2]);
  assert(lines[3].trimEnd().endsWith("-"), lines[3]);
});

Deno.test("renderWorkspaceGet: log says whose a workspace is when the root says, and json carries it", () => {
  const operator = captured(() =>
    renderWorkspaceGet(summary({ owner: "operator" }), "log")
  );
  assertStringIncludes(operator, "Owner: the host's user");
  assertEquals(
    captured(() => renderWorkspaceGet(summary(), "log")).includes("Owner:"),
    false,
  );
  assertEquals(
    JSON.parse(
      captured(() => renderWorkspaceGet(summary({ owner: "host" }), "json")),
    ).owner,
    "host",
  );
});

Deno.test("renderWorkspaceGet: json is the summary as the root sent it", () => {
  const data = summary({ state: "failed", restarts: 5, reason: "It failed." });
  const out = captured(() => renderWorkspaceGet(data, "json"));
  assertEquals(JSON.parse(out), data);
});

Deno.test("renderWorkspaceGet: log shows state, restarts and the reason when not ready", () => {
  const out = captured(() =>
    renderWorkspaceGet(
      summary({
        state: "backoff",
        restarts: 2,
        reason: "Its serve keeps exiting.\x1b[31m",
      }),
      "log",
    )
  );
  assertStringIncludes(out, "State: backoff");
  assertStringIncludes(out, "Wanted: active");
  assertStringIncludes(out, "Restarts: 2");
  assertStringIncludes(out, "Reason: Its serve keeps exiting.\\x1b[31m");
});

Deno.test("renderWorkspaceGet: log leaves the reason out when ready", () => {
  const out = captured(() =>
    renderWorkspaceGet(summary({ reason: "stale" }), "log")
  );
  assert(!out.includes("Reason"));
});

Deno.test("renderWorkspaceChange: json is the change as the root sent it", () => {
  const data = {
    name: "edge-dns",
    wanted: "suspended" as const,
    changedAt: "2026-11-18T00:00:00.000Z",
  };
  for (const verb of ["suspend", "resume", "rm"] as const) {
    const out = captured(() => renderWorkspaceChange(verb, data, "json", ""));
    assertEquals(JSON.parse(out), data);
  }
});

Deno.test("renderWorkspaceChange: log says what the host does next and how to watch it", () => {
  const change = (verb: "suspend" | "resume" | "rm") =>
    captured(() =>
      renderWorkspaceChange(
        verb,
        { name: "edge-dns", wanted: "active", changedAt: null },
        "log",
        TARGET,
      )
    );
  const suspended = change("suspend");
  assertStringIncludes(suspended, "stops its serve on its next scan");
  assertStringIncludes(
    suspended,
    "swamp serve workspace get edge-dns --server https://host.example",
  );
  assertStringIncludes(change("resume"), "starts its serve on its next scan");
  const removed = change("rm");
  assertStringIncludes(removed, "removes its folder on its next scan");
  assertStringIncludes(
    removed,
    "swamp serve workspace list --server https://host.example",
  );
});

Deno.test("renderWorkspaceRmCancelled: says nothing was removed in both modes", () => {
  assertStringIncludes(
    captured(() => renderWorkspaceRmCancelled("edge-dns", "log")),
    "Nothing was removed",
  );
  assertEquals(
    JSON.parse(captured(() => renderWorkspaceRmCancelled("edge-dns", "json"))),
    { name: "edge-dns", removed: false },
  );
});
