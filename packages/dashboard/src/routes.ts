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

import type { View } from "./types.ts";

const BASE = "/dashboard";

/**
 * The detail a URL addresses. Model-scoped kinds (`data`, `report`) and the
 * run-scoped `runReport` are the shareable deep links: `data` with a
 * `version` is the permalink for any single data item, including a step's
 * report output.
 */
export type DetailView =
  | { kind: "run"; workflowName: string; runId?: string }
  | { kind: "workflow"; workflowName: string }
  | { kind: "model"; modelName: string }
  | { kind: "data"; modelName: string; dataName: string; version?: number }
  | {
    kind: "report";
    modelName: string;
    reportName: string;
    variant?: string;
  }
  | {
    kind: "runReport";
    workflowName: string;
    runId: string;
    reportName: string;
  }
  | { kind: "schedule"; workflowName: string }
  | { kind: "webhook"; route: string }
  | null;

export interface RouteState {
  view: View;
  detail: DetailView;
}

/**
 * The URL segment of each list view. The view id stays `models` (code,
 * not product language); its pages live under `behaviors`, the product
 * term. Every link the dashboard builds goes through this map.
 */
const VIEW_SEGMENTS: Readonly<Record<Exclude<View, "overview">, string>> = {
  workflows: "workflows",
  executions: "executions",
  models: "behaviors",
  schedules: "schedules",
  webhooks: "webhooks",
  approvals: "approvals",
  activity: "activity",
  data: "data",
  vaults: "vaults",
  extensions: "extensions",
  system: "system",
};

/**
 * Old spellings of a view's segment that still resolve, so links shared
 * before a rename keep working forever.
 */
const LEGACY_SEGMENTS: Readonly<Record<string, Exclude<View, "overview">>> = {
  models: "models",
  behaviours: "models",
};

/** Every segment that names a list view, current and legacy. */
const SEGMENT_VIEWS = new Map<string, View>(Object.entries(LEGACY_SEGMENTS));
for (const [view, segment] of Object.entries(VIEW_SEGMENTS)) {
  SEGMENT_VIEWS.set(segment, view as View);
}

const BEHAVIORS = `${BASE}/${VIEW_SEGMENTS.models}`;

/**
 * The canonical path for a link that uses an old segment for the behaviors
 * view (`/dashboard/models/...` or `/dashboard/behaviours/...`), or null
 * when the path needs no rewrite. Only the leading segment changes; the
 * rest of the raw path is kept byte for byte, so encoded names survive.
 */
export function legacyRedirectPath(pathname: string): string | null {
  const match = /^\/dashboard\/(models|behaviours)(?=\/|$)/.exec(pathname);
  return match ? `${BEHAVIORS}${pathname.slice(match[0].length)}` : null;
}

/**
 * True for the `swamp start` page. It is served by `swamp start`'s own
 * loopback server, not by `swamp serve`, so the app renders it before any
 * serve connection, auth probe or sidebar is set up.
 */
export function isStartPath(pathname: string): boolean {
  return pathname === `${BASE}/start` || pathname === `${BASE}/start/`;
}

/**
 * Percent-encodes one path segment. `@` stays readable (it is legal in a
 * path segment) so scoped names read as `@swamp%2Fworkflow-summary`; `/`
 * must be encoded as `%2F`. Links built by hand for scoped names have to
 * follow the same rule, or the extra `/` shifts every later segment.
 */
export function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(/%40/g, "@");
}

/** Decodes one segment, or returns null for a malformed escape. */
function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function parseVersion(segment: string | undefined): number | undefined {
  if (segment === undefined || !/^[1-9][0-9]*$/.test(segment)) {
    return undefined;
  }
  const version = Number(segment);
  return Number.isSafeInteger(version) ? version : undefined;
}

export function parseRoute(pathname: string): RouteState {
  const raw = pathname.startsWith(BASE)
    ? pathname.slice(BASE.length)
    : pathname;
  const path = raw.startsWith("/") ? raw.slice(1) : raw;

  // A truncated or garbled link (e.g. cut off mid-escape in a chat message)
  // keeps the segments before the bad one, so it lands on the nearest
  // valid parent instead of failing to load.
  const segments: string[] = [];
  for (const rawSegment of path.split("/").filter(Boolean)) {
    const decoded = safeDecode(rawSegment);
    if (decoded === null) break;
    segments.push(decoded);
  }

  if (segments.length === 0) {
    return { view: "overview", detail: null };
  }

  const [first, name, section, item, sub, subItem] = segments;

  const firstView = SEGMENT_VIEWS.get(first);

  if (firstView === "models" && name !== undefined) {
    if (section === "data" && item !== undefined) {
      const version = sub === "versions" ? parseVersion(subItem) : undefined;
      return {
        view: "models",
        detail: {
          kind: "data",
          modelName: name,
          dataName: item,
          ...(version !== undefined && { version }),
        },
      };
    }
    if (section === "reports" && item !== undefined) {
      const variant = sub === "variants" && subItem !== undefined
        ? subItem
        : undefined;
      return {
        view: "models",
        detail: {
          kind: "report",
          modelName: name,
          reportName: item,
          ...(variant !== undefined && { variant }),
        },
      };
    }
    return { view: "models", detail: { kind: "model", modelName: name } };
  }

  if (first === "workflows" && name !== undefined) {
    if (section === "runs" && item !== undefined) {
      if (sub === "reports" && subItem !== undefined) {
        return {
          view: "workflows",
          detail: {
            kind: "runReport",
            workflowName: name,
            runId: item,
            reportName: subItem,
          },
        };
      }
      return {
        view: "workflows",
        detail: { kind: "run", workflowName: name, runId: item },
      };
    }
    return {
      view: "workflows",
      detail: { kind: "workflow", workflowName: name },
    };
  }

  if (first === "schedules" && name !== undefined) {
    return {
      view: "schedules",
      detail: { kind: "schedule", workflowName: name },
    };
  }

  // A webhook's route is one segment: its slashes are encoded as `%2F`.
  if (first === "webhooks" && name !== undefined) {
    return { view: "webhooks", detail: { kind: "webhook", route: name } };
  }

  if (firstView !== undefined) {
    return { view: firstView, detail: null };
  }

  return { view: "overview", detail: null };
}

function detailPath(detail: NonNullable<DetailView>): string {
  switch (detail.kind) {
    case "model":
      return `${BEHAVIORS}/${encodeSegment(detail.modelName)}`;
    case "workflow":
      return `${BASE}/workflows/${encodeSegment(detail.workflowName)}`;
    case "run": {
      const base = `${BASE}/workflows/${encodeSegment(detail.workflowName)}`;
      return detail.runId
        ? `${base}/runs/${encodeSegment(detail.runId)}`
        : base;
    }
    case "data": {
      const base = `${BEHAVIORS}/${encodeSegment(detail.modelName)}/data/${
        encodeSegment(detail.dataName)
      }`;
      return detail.version !== undefined
        ? `${base}/versions/${detail.version}`
        : base;
    }
    case "report": {
      const base = `${BEHAVIORS}/${encodeSegment(detail.modelName)}/reports/${
        encodeSegment(detail.reportName)
      }`;
      return detail.variant !== undefined
        ? `${base}/variants/${encodeSegment(detail.variant)}`
        : base;
    }
    case "runReport":
      return `${BASE}/workflows/${encodeSegment(detail.workflowName)}/runs/${
        encodeSegment(detail.runId)
      }/reports/${encodeSegment(detail.reportName)}`;
    case "schedule":
      return `${BASE}/schedules/${encodeSegment(detail.workflowName)}`;
    case "webhook":
      return `${BASE}/webhooks/${encodeSegment(detail.route)}`;
  }
}

export function buildPath(state: RouteState): string {
  if (state.detail) return detailPath(state.detail);
  if (state.view === "overview") return BASE;
  return `${BASE}/${VIEW_SEGMENTS[state.view]}`;
}

/** The sidebar view a detail belongs to. */
export function viewForDetail(detail: NonNullable<DetailView>): View {
  switch (detail.kind) {
    case "model":
    case "data":
    case "report":
      return "models";
    case "workflow":
    case "run":
    case "runReport":
      return "workflows";
    case "schedule":
      return "schedules";
    case "webhook":
      return "webhooks";
  }
}

/**
 * Where Back and Escape go from a deep-linked item: a data item or report
 * returns to its model, a run's report to its run. Existing details have no
 * parent here — they keep closing to their list view.
 */
export function parentOf(detail: DetailView): DetailView {
  if (!detail) return null;
  switch (detail.kind) {
    case "data":
    case "report":
      return { kind: "model", modelName: detail.modelName };
    case "runReport":
      return {
        kind: "run",
        workflowName: detail.workflowName,
        runId: detail.runId,
      };
    default:
      return null;
  }
}

/** The full URL of a route, for copying a link to share. */
export function absoluteUrl(state: RouteState, origin: string): string {
  return `${origin}${buildPath(state)}`;
}

/** The pointer-event fields needed to tell a plain click from a modified one. */
export interface ClickLike {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}

/**
 * True for an unmodified primary-button click — the only click a nav link
 * should turn into in-app navigation. Modified or middle clicks are left to
 * the browser so they open the link in a new tab or window.
 */
export function isPlainLeftClick(event: ClickLike): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey &&
    !event.shiftKey && !event.altKey && !event.defaultPrevented;
}
