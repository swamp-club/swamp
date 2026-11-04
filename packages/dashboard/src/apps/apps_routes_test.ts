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
  appPagePath,
  appsSegments,
  isAppsPath,
  resolveAppPage,
} from "./apps_routes.ts";

Deno.test("isAppsPath: only /apps and below", () => {
  assertEquals(isAppsPath("/apps"), true);
  assertEquals(isAppsPath("/apps/@acme/cost"), true);
  assertEquals(isAppsPath("/appsx"), false);
  assertEquals(isAppsPath("/dashboard/apps"), false);
});

Deno.test("appsSegments: the segments after a serve or workspace base", () => {
  assertEquals(appsSegments("/apps", "/apps"), []);
  assertEquals(appsSegments("/apps/@acme/cost/x%20y", "/apps"), [
    "@acme",
    "cost",
    "x y",
  ]);
  assertEquals(appsSegments("/apps/w/alpha/@acme/cost", "/apps/w/alpha"), [
    "@acme",
    "cost",
  ]);
});

Deno.test("resolveAppPage: the longest app name wins, the rest is the app's path", () => {
  const names = ["@acme/cost", "@acme/cost/admin"];
  assertEquals(resolveAppPage(["@acme", "cost"], names), {
    name: "@acme/cost",
    path: "/",
  });
  assertEquals(resolveAppPage(["@acme", "cost", "admin", "x y"], names), {
    name: "@acme/cost/admin",
    path: "/x%20y",
  });
  assertEquals(resolveAppPage(["@acme", "other"], names), null);
});

Deno.test("appPagePath: builds the page URL, with the app's path after it", () => {
  assertEquals(appPagePath("@acme/cost", "/", "/apps"), "/apps/@acme/cost");
  assertEquals(
    appPagePath("@acme/cost", "/runs/1", "/apps/w/alpha"),
    "/apps/w/alpha/@acme/cost/runs/1",
  );
});
