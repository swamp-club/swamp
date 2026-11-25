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
  dashboardReturnPath,
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

Deno.test("dashboardReturnPath: returns to the dashboard page the viewer left", () => {
  const origin = "https://swamp.example";
  assertEquals(
    dashboardReturnPath(
      `${origin}/dashboard/workflows/deploy?range=7d`,
      origin,
      null,
    ),
    "/dashboard/workflows/deploy?range=7d",
  );
  assertEquals(
    dashboardReturnPath(`${origin}/dashboard`, origin, null),
    "/dashboard",
  );
  assertEquals(
    dashboardReturnPath(`${origin}/dashboard/apps`, origin, null),
    "/dashboard/apps",
  );
  assertEquals(
    dashboardReturnPath(`${origin}/dashboard/w/my%20ws/runs`, origin, "my ws"),
    "/dashboard/w/my%20ws/runs",
  );
});

Deno.test("dashboardReturnPath: anything else goes to the workspace's dashboard home", () => {
  const origin = "https://swamp.example";
  const home = (referrer: string, workspace: string | null) =>
    dashboardReturnPath(referrer, origin, workspace);
  assertEquals(home("", null), "/dashboard");
  assertEquals(home("not a url", "ws"), "/dashboard/w/ws");
  assertEquals(home("https://evil.example/dashboard/runs", null), "/dashboard");
  assertEquals(home(`${origin}/apps/@acme/cost`, null), "/dashboard");
  assertEquals(home(`${origin}/start`, null), "/dashboard");
  assertEquals(home(`${origin}/dashboardx/runs`, null), "/dashboard");
  assertEquals(home(`${origin}/dashboard/w/ws/runs`, null), "/dashboard");
  assertEquals(home(`${origin}/dashboard/runs`, "ws"), "/dashboard/w/ws");
  assertEquals(
    home(`${origin}/dashboard/w/other/runs`, "ws"),
    "/dashboard/w/ws",
  );
  assertEquals(home(`${origin}/dashboard/apps/cost`, null), "/dashboard");
  assertEquals(
    home(`${origin}/dashboard/apps/@acme/cost/x`, null),
    "/dashboard",
  );
  assertEquals(
    home(`${origin}/dashboard/w/ws/apps/cost`, "ws"),
    "/dashboard/w/ws",
  );
});
