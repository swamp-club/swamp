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
import { assert, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppEntry } from "../apps/app_types.ts";
import { AppRow } from "./ManageApps.tsx";

const APP: AppEntry = {
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
  platform: "1.4",
};

function render(app: AppEntry): string {
  return renderToStaticMarkup(
    <AppRow
      app={app}
      canManage
      busy={false}
      onApprove={() => {}}
      onRevoke={() => {}}
    />,
  );
}

Deno.test("AppRow: names the app platform the app was built for", () => {
  assertStringIncludes(render(APP), "app platform 1.4");
});

Deno.test("AppRow: says why an app cannot open on this server", () => {
  const html = render({
    ...APP,
    platformProblem: "It needs app platform 1.4, and this swamp has 1.0.",
  });
  assertStringIncludes(html, "cannot open on this server");
  assertStringIncludes(html, "and this swamp has 1.0.");
  assert(!render(APP).includes("cannot open"));
});
