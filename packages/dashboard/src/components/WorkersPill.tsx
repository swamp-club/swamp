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
import type { WorkerSummary } from "../lib/host_map_model.ts";
import { RouteLink } from "./RouteLink.tsx";

/** The pool at a glance — busy, idle, unavailable — linking to the Workers view. */
export function WorkersPill({ summary }: { summary: WorkerSummary }) {
  return (
    <RouteLink
      to={{ view: "workers", detail: null }}
      className="workers-pill"
      title="Open the worker map"
    >
      <span className="workers-pill-label">Workers</span>
      <span className="workers-pill-part">
        <span className="workers-pill-dot is-busy" />
        <strong>{summary.busy}</strong> busy
      </span>
      <span className="workers-pill-part">
        <span className="workers-pill-dot is-idle" />
        <strong>{summary.idle}</strong> idle
      </span>
      <span className="workers-pill-part">
        <span
          className={`workers-pill-dot ${
            summary.unavailable > 0 ? "is-unavailable" : "is-idle"
          }`}
        />
        <strong>{summary.unavailable}</strong> unavailable
      </span>
    </RouteLink>
  );
}
