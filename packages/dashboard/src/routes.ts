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

import type { View } from "./components/Sidebar";

const BASE = "/dashboard";

export type DetailView =
  | { kind: "run"; workflowName: string; runId?: string }
  | { kind: "workflow"; workflowName: string }
  | { kind: "model"; modelName: string }
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

  if (first === "models" && segments.length >= 2) {
    return {
      view: "models",
      detail: { kind: "model", modelName: decodeURIComponent(segments[1]) },
    };
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
    }
  }

  if (state.view === "overview") return BASE;
  return `${BASE}/${state.view}`;
}
