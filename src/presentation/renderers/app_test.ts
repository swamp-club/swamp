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
import {
  appApprovePrompt,
  renderAppApprove,
  renderAppApproveCancelled,
  renderAppBuild,
  renderAppDevReady,
  renderAppInit,
  renderAppList,
  renderAppRevoke,
} from "./app.ts";

function captured(body: () => void): string {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    body();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

Deno.test("renderAppList: json mode prints the data as is", () => {
  const data = { apps: [], problems: [] };
  assertEquals(JSON.parse(captured(() => renderAppList("json", data))), data);
});

Deno.test("renderAppRevoke: json mode says whether anything changed", () => {
  const data = { name: "@acme/cost", revoked: false };
  assertEquals(JSON.parse(captured(() => renderAppRevoke("json", data))), data);
});

Deno.test("renderAppBuild: json mode reports the build", () => {
  assertEquals(
    JSON.parse(
      captured(() => renderAppBuild("json", { name: "@a/b", directory: "/d" })),
    ),
    { name: "@a/b", directory: "/d", built: true },
  );
});

Deno.test("renderAppBuild: json mode carries the build's warnings", () => {
  const warning =
    'app.yaml names no platform. Add platform: "1.4" to app.yaml.';
  assertEquals(
    JSON.parse(
      captured(() =>
        renderAppBuild("json", {
          name: "@a/b",
          directory: "/d",
          warnings: [warning],
        })
      ),
    ),
    { name: "@a/b", directory: "/d", built: true, warnings: [warning] },
  );
});

Deno.test("renderAppDevReady: json mode is one line for a watching tool", () => {
  const out = captured(() =>
    renderAppDevReady("json", { name: "@a/b", url: "http://127.0.0.1:1/" })
  );
  assertEquals(out.includes("\n"), false);
  assertEquals(JSON.parse(out).url, "http://127.0.0.1:1/");
});

Deno.test("appApprovePrompt: shows the grant, pinned types and the warning before enabling", () => {
  const { question, details } = appApprovePrompt({
    name: "@acme/cost",
    title: "Cost",
    state: "pending",
    origin: "local",
    built: true,
    dev: false,
    platform: "1",
    capabilities: ["runs:read"],
    run: [],
    methods: [{
      behavior: "plan",
      type: "@acme/plan",
      methods: ["setMeta", "tick"],
    }],
    capabilityKey: "k",
  });
  assertEquals(question, "Enable @acme/cost?");
  const text = stripAnsiCode(details.join("\n"));
  assert(text.includes("runs:read"));
  assert(text.includes("methods of plan (@acme/plan): [setMeta, tick]"));
  assert(text.includes("send anything it reads to external sites"));
});

Deno.test("renderAppApproveCancelled: json mode says nothing was approved", () => {
  const out = captured(() => renderAppApproveCancelled("json", "@acme/cost"));
  assertEquals(JSON.parse(out), { name: "@acme/cost", approved: false });
});

Deno.test("renderAppList: an app this swamp cannot serve says why", () => {
  const out = captured(() =>
    renderAppList("log", {
      apps: [{
        name: "@acme/cost",
        title: "Cost",
        state: "enabled",
        origin: "local",
        built: true,
        dev: false,
        platform: "2",
        platformProblem:
          "It needs app platform 2, which this swamp does not have. Upgrade swamp.",
        capabilities: [],
        run: [],
        methods: [],
        capabilityKey: "k",
      }],
      problems: [],
    })
  );
  assertStringIncludes(out, "Cannot open here.");
  assertStringIncludes(out, "Upgrade swamp.");
});

Deno.test("renderAppInit: the next step serves Bun users and mise users", () => {
  const out = stripAnsiCode(captured(() =>
    renderAppInit("log", {
      name: "@acme/cost",
      directory: "/repo/apps/cost",
      template: "dashboard",
      platform: "1.4",
    })
  ));
  assertStringIncludes(
    out,
    "Next: cd /repo/apps/cost && bun install, then swamp app dev",
  );
  assertStringIncludes(out, "With mise, run mise install first");
});

Deno.test("renderAppApprove: json mode says the app was approved", () => {
  const out = captured(() =>
    renderAppApprove("json", {
      name: "@acme/cost",
      capabilities: [],
      run: [],
      methods: [],
      capabilityKey: "k",
      approvedBy: "adam",
      approvedAt: "2026-01-01T00:00:00.000Z",
    })
  );
  const parsed = JSON.parse(out);
  assertEquals(parsed.approved, true);
  assertEquals(parsed.name, "@acme/cost");
});
