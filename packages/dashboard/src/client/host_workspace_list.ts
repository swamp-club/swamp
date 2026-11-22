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

import { dashboardBaseFor } from "./workspace_path.ts";

/** A hosted workspace's state as `workspace.list` reports it; null before the host wrote one. */
export type HostWorkspaceState =
  | "stopped"
  | "starting"
  | "ready"
  | "backoff"
  | "failed"
  | null;

export interface HostWorkspace {
  readonly name: string;
  readonly state: HostWorkspaceState;
}

/** Re-read while the tab is visible: workspaces are resumed and suspended under the page. */
export const HOST_LIST_INTERVAL_MS = 30_000;

const STATES: ReadonlySet<unknown> = new Set([
  "stopped",
  "starting",
  "ready",
  "backoff",
  "failed",
]);

/**
 * Reads a `workspace.list` reply down to each workspace's name and state, so
 * fields the root adds later never reach the switcher. Null for a reply it
 * cannot read; an entry it cannot read is dropped.
 */
export function parseHostWorkspaceList(
  payload: unknown,
): HostWorkspace[] | null {
  const data = (payload as { data?: unknown } | null | undefined)?.data;
  const workspaces = (data as { workspaces?: unknown } | null | undefined)
    ?.workspaces;
  if (!Array.isArray(workspaces)) return null;
  const listed: HostWorkspace[] = [];
  for (const entry of workspaces) {
    const { name, state } = (entry ?? {}) as Record<string, unknown>;
    if (typeof name !== "string" || name === "") continue;
    listed.push({
      name,
      state: STATES.has(state) ? state as HostWorkspaceState : null,
    });
  }
  return listed;
}

/** The word the switcher puts beside a workspace that is not ready; the workspace's own page says the same. */
export function hostStateMark(state: HostWorkspaceState): string | null {
  switch (state) {
    case "ready":
      return null;
    case "starting":
    case "backoff":
      return "starting";
    case null:
      return "not running";
    default:
      return state;
  }
}

/** The root's option value: no workspace name is empty. */
export const ROOT_ENTRY_VALUE = "";

export interface HostSwitcherEntry {
  readonly value: string;
  readonly label: string;
  readonly href: string;
}

/**
 * The switcher's options under a host: the root first, then the workspaces by
 * name. The page's own workspace is always an entry, even when the list could
 * not be read or leaves it out.
 */
export function hostSwitcherEntries(
  current: string | null,
  workspaces: readonly HostWorkspace[] | null,
): HostSwitcherEntry[] {
  const listed = [...(workspaces ?? [])];
  if (current !== null && !listed.some((w) => w.name === current)) {
    listed.push({ name: current, state: "ready" });
  }
  listed.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return [
    {
      value: ROOT_ENTRY_VALUE,
      label: "Host root",
      href: `${dashboardBaseFor(null)}/`,
    },
    ...listed.map((w) => {
      const mark = hostStateMark(w.state);
      return {
        value: w.name,
        label: mark === null ? w.name : `${w.name} (${mark})`,
        href: `${dashboardBaseFor(w.name)}/`,
      };
    }),
  ];
}

/** What the switcher can do with the root's list. */
export type RootListAccess = "read" | "sign-in";

/**
 * A root in auth mode none answers anyone; any other root only a browser
 * holding its session, so without one the switcher asks nothing of it.
 */
export function rootListAccess(
  rootMode: "none" | "token" | "oauth",
  signedIn: boolean,
): RootListAccess {
  return rootMode === "none" || signedIn ? "read" : "sign-in";
}
