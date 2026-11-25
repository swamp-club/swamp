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

import {
  appsBaseFor,
  dashboardBaseFor,
  PAGE_WORKSPACE,
  workspaceFromPath,
} from "../client/workspace_path.ts";

/** Where this page's apps live: `/apps`, or a local workspace's. */
export const APPS_BASE = appsBaseFor(PAGE_WORKSPACE);

/** Whether a path is in the apps area rather than the dashboard. */
export function isAppsPath(pathname: string): boolean {
  return pathname === "/apps" || pathname.startsWith("/apps/");
}

/** The decoded segments after the apps base; empty for the index. */
export function appsSegments(pathname: string, base = APPS_BASE): string[] {
  if (pathname !== base && !pathname.startsWith(`${base}/`)) return [];
  return pathname.slice(base.length).split("/").filter((s) => s !== "")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

/** an app's name spans segments (`@acme/cost`), so the longest name the path starts with wins */
export function resolveAppPage(
  segments: readonly string[],
  names: readonly string[],
): { name: string; path: string } | null {
  let best: string[] | null = null;
  for (const name of names) {
    const parts = name.split("/");
    if (
      parts.length <= segments.length &&
      parts.every((part, i) => part === segments[i]) &&
      (best === null || parts.length > best.length)
    ) {
      best = parts;
    }
  }
  if (best === null) return null;
  const rest = segments.slice(best.length).map(encodeURIComponent).join("/");
  return { name: best.join("/"), path: `/${rest}` };
}

/** The URL of an app's page; a name's characters need no escaping. */
export function appPagePath(
  name: string,
  path = "/",
  base = APPS_BASE,
): string {
  const page = `${base}/${name}`;
  return path === "/" ? page : `${page}${path}`;
}

/** The dashboard page the viewer came from, or the dashboard's home. */
export function dashboardReturnPath(
  referrer: string,
  origin: string,
  workspace: string | null = PAGE_WORKSPACE,
): string {
  const base = dashboardBaseFor(workspace);
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return base;
  }
  const path = url.pathname;
  if (url.origin !== origin) return base;
  if (path !== base && !path.startsWith(`${base}/`)) return base;
  // serve's /dashboard is a prefix of every workspace's /dashboard/w/<name>
  if (workspaceFromPath(path) !== workspace) return base;
  // a dashboard app address hands off to /apps, so returning there loops back
  if (path.startsWith(`${base}/apps/`)) return base;
  return `${path}${url.search}`;
}
