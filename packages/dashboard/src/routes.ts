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

export type DetailView =
  | { kind: "run"; workflowName: string; runId?: string }
  | { kind: "workflow"; workflowName: string }
  | { kind: "model"; modelName: string }
  | { kind: "data"; modelName: string; dataName: string; version?: number }
  | {
    kind: "runData";
    workflowName: string;
    runId: string;
    dataName: string;
    version?: number;
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
 * Parses the optional `versions/<n>` suffix starting at `index`. Anything
 * other than a positive integer means "latest" rather than a different view.
 */
function parseVersion(
  segments: string[],
  index: number,
): number | undefined {
  if (segments[index] !== "versions") return undefined;
  const raw = segments[index + 1];
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) return undefined;
  return Number(raw);
}

function versionSuffix(version: number | undefined): string {
  return version === undefined ? "" : `/versions/${version}`;
}

export function parseRoute(pathname: string): RouteState {
  const raw = pathname.startsWith(BASE)
    ? pathname.slice(BASE.length)
    : pathname;
  const path = raw.startsWith("/") ? raw.slice(1) : raw;
  const segments = path.split("/").filter(Boolean);

  if (segments.length === 0) {
    return { view: "overview", detail: null };
  }

  const first = segments[0];

  if (first === "models" && segments.length >= 4 && segments[2] === "data") {
    const version = parseVersion(segments, 4);
    return {
      view: "models",
      detail: {
        kind: "data",
        modelName: decodeURIComponent(segments[1]),
        dataName: decodeURIComponent(segments[3]),
        ...(version !== undefined ? { version } : {}),
      },
    };
  }

  if (first === "models" && segments.length >= 2) {
    return {
      view: "models",
      detail: { kind: "model", modelName: decodeURIComponent(segments[1]) },
    };
  }

  if (
    first === "workflows" && segments.length >= 6 && segments[2] === "runs"
  ) {
    const workflowName = decodeURIComponent(segments[1]);
    const runId = decodeURIComponent(segments[3]);
    if (segments[4] === "data") {
      const version = parseVersion(segments, 6);
      return {
        view: "workflows",
        detail: {
          kind: "runData",
          workflowName,
          runId,
          dataName: decodeURIComponent(segments[5]),
          ...(version !== undefined ? { version } : {}),
        },
      };
    }
    if (segments[4] === "reports") {
      return {
        view: "workflows",
        detail: {
          kind: "runReport",
          workflowName,
          runId,
          // Report names are usually scoped (`@swamp/method-summary`), and
          // links pasted through chat or terminals often arrive with the
          // `%2F` decoded, so the name is everything after `reports/`.
          reportName: segments.slice(5).map(decodeURIComponent).join("/"),
        },
      };
    }
  }

  if (first === "workflows" && segments.length >= 4 && segments[2] === "runs") {
    return {
      view: "workflows",
      detail: {
        kind: "run",
        workflowName: decodeURIComponent(segments[1]),
        runId: decodeURIComponent(segments[3]),
      },
    };
  }

  if (first === "workflows" && segments.length >= 2) {
    return {
      view: "workflows",
      detail: {
        kind: "workflow",
        workflowName: decodeURIComponent(segments[1]),
      },
    };
  }

  if (VIEWS.has(first)) {
    return { view: first as View, detail: null };
  }

  return { view: "overview", detail: null };
}

export function buildPath(state: RouteState): string {
  if (state.detail) {
    switch (state.detail.kind) {
      case "model":
        return `${BASE}/models/${encodeURIComponent(state.detail.modelName)}`;
      case "workflow":
        return `${BASE}/workflows/${
          encodeURIComponent(state.detail.workflowName)
        }`;
      case "run": {
        const base = `${BASE}/workflows/${
          encodeURIComponent(state.detail.workflowName)
        }`;
        return state.detail.runId
          ? `${base}/runs/${encodeURIComponent(state.detail.runId)}`
          : base;
      }
      case "data":
        return `${BASE}/models/${
          encodeURIComponent(state.detail.modelName)
        }/data/${encodeURIComponent(state.detail.dataName)}${
          versionSuffix(state.detail.version)
        }`;
      case "runData":
        return `${BASE}/workflows/${
          encodeURIComponent(state.detail.workflowName)
        }/runs/${encodeURIComponent(state.detail.runId)}/data/${
          encodeURIComponent(state.detail.dataName)
        }${versionSuffix(state.detail.version)}`;
      case "runReport":
        return `${BASE}/workflows/${
          encodeURIComponent(state.detail.workflowName)
        }/runs/${encodeURIComponent(state.detail.runId)}/reports/${
          state.detail.reportName.split("/").map(encodeURIComponent).join("/")
        }`;
    }
  }

  if (state.view === "overview") return BASE;
  return `${BASE}/${state.view}`;
}

/** The route state that shows `detail`, with the sidebar view it belongs to. */
export function routeForDetail(detail: NonNullable<DetailView>): RouteState {
  const view: View = detail.kind === "model" || detail.kind === "data"
    ? "models"
    : "workflows";
  return { view, detail };
}

/**
 * Where "Back" goes from a detail view: a data item returns to its model, a
 * run's data or report returns to the run. Other details close to their list.
 */
export function parentDetail(detail: NonNullable<DetailView>): DetailView {
  switch (detail.kind) {
    case "data":
      return { kind: "model", modelName: detail.modelName };
    case "runData":
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
