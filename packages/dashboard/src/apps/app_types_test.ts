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
  type AppEntry,
  capabilityLabels,
  launchableApps,
} from "./app_types.ts";

const entry = (over: Partial<AppEntry>): AppEntry => ({
  name: "@acme/cost",
  title: "Cost",
  state: "enabled",
  origin: "local",
  built: true,
  dev: false,
  capabilities: [],
  run: [],
  methods: [],
  capabilityKey: "k",
  platform: "1",
  ...over,
});

Deno.test("launchableApps: only enabled, built apps this swamp can serve open", () => {
  assertEquals(
    launchableApps([
      entry({ name: "@a/on" }),
      entry({ name: "@a/pending", state: "pending" }),
      entry({ name: "@a/changed", state: "changed" }),
      entry({ name: "@a/unbuilt", built: false }),
      entry({ name: "@a/old", platformProblem: "Upgrade swamp." }),
    ]).map((app) => app.name),
    ["@a/on"],
  );
});

Deno.test("capabilityLabels: names what a run may start", () => {
  assertEquals(
    capabilityLabels({
      capabilities: ["runs:read"],
      run: ["@a/nightly"],
      methods: [{
        behavior: "plan",
        type: "@a/plan",
        methods: ["tick", "add"],
      }],
    }),
    [
      "runs:read",
      "run: @a/nightly",
      "methods of plan (@a/plan): [tick, add]",
    ],
  );
});
