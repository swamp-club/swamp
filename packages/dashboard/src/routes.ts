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
  | null;

export interface RouteState {
  view: View;
  detail: DetailView;
}

const VIEWS: ReadonlySet<string> = new Set<View>([
  "overview",
  "workflows",
  "executions",
  "models",
  "schedules",
  "webhooks",
  "approvals",
  "activity",
  "data",
  "vaults",
  "extensions",
  "system",
]);

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

  if (first === "models" && name !== undefined) {
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

  if (VIEWS.has(first)) {
    return { view: first as View, detail: null };
  }

  return { view: "overview", detail: null };
}

function detailPath(detail: NonNullable<DetailView>): string {
  switch (detail.kind) {
    case "model":
      return `${BASE}/models/${encodeSegment(detail.modelName)}`;
    case "workflow":
      return `${BASE}/workflows/${encodeSegment(detail.workflowName)}`;
    case "run": {
      const base = `${BASE}/workflows/${encodeSegment(detail.workflowName)}`;
      return detail.runId
        ? `${base}/runs/${encodeSegment(detail.runId)}`
        : base;
    }
    case "data": {
      const base = `${BASE}/models/${encodeSegment(detail.modelName)}/data/${
        encodeSegment(detail.dataName)
      }`;
      return detail.version !== undefined
        ? `${base}/versions/${detail.version}`
        : base;
    }
    case "report": {
      const base = `${BASE}/models/${encodeSegment(detail.modelName)}/reports/${
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
  }
}

export function buildPath(state: RouteState): string {
  if (state.detail) return detailPath(state.detail);
  if (state.view === "overview") return BASE;
  return `${BASE}/${state.view}`;
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
