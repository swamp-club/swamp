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
import type { DisplayStatus } from "./run_graph_model.ts";

const LABELS: Record<DisplayStatus, string> = {
  succeeded: "Succeeded",
  failed: "Failed",
  running: "Running",
  waiting: "Waiting",
  pending: "Queued",
  skipped: "Skipped",
  cancelled: "Did not finish",
  unknown: "Unknown",
};

export function statusLabel(status: DisplayStatus): string {
  return LABELS[status];
}

/**
 * One glyph per run status, drawn in the status color: a check, a cross, a
 * spinner, a clock, a hollow ring, a slashed circle, a stop square. Shape as
 * well as color carries the status, so it reads without color too.
 */
export function RunStatusIcon(
  { status, size = 16, label }: {
    status: DisplayStatus;
    size?: number;
    /** Announced name; defaults to the status. Pass "" when text says it. */
    label?: string;
  },
) {
  const name = label ?? LABELS[status];
  return (
    <svg
      className={`rs-icon rs-${status}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      role={name ? "img" : undefined}
      aria-label={name || undefined}
      aria-hidden={name ? undefined : true}
      focusable="false"
    >
      {glyph(status)}
    </svg>
  );
}

function glyph(status: DisplayStatus) {
  switch (status) {
    case "succeeded":
      return (
        <>
          <circle cx="8" cy="8" r="8" className="rs-fill" />
          <path
            d="M4.6 8.3l2.2 2.2 4.6-4.8"
            className="rs-mark"
            fill="none"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );
    case "failed":
      return (
        <>
          <circle cx="8" cy="8" r="8" className="rs-fill" />
          <path
            d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2"
            className="rs-mark"
            fill="none"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </>
      );
    case "running":
      return (
        <>
          <circle
            cx="8"
            cy="8"
            r="6.2"
            fill="none"
            className="rs-track"
            strokeWidth="2"
          />
          <path
            d="M8 1.8a6.2 6.2 0 0 1 6.2 6.2"
            fill="none"
            className="rs-spin"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </>
      );
    case "waiting":
      return (
        <>
          <circle
            cx="8"
            cy="8"
            r="6.6"
            fill="none"
            className="rs-stroke"
            strokeWidth="1.8"
          />
          <path
            d="M8 4.6V8l2.3 1.5"
            fill="none"
            className="rs-stroke"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );
    case "pending":
      return (
        <circle
          cx="8"
          cy="8"
          r="6.4"
          fill="none"
          className="rs-stroke"
          strokeWidth="1.8"
          strokeDasharray="3 2.2"
        />
      );
    case "skipped":
      return (
        <>
          <circle
            cx="8"
            cy="8"
            r="6.6"
            fill="none"
            className="rs-stroke"
            strokeWidth="1.6"
          />
          <path
            d="M4.6 11.4l6.8-6.8"
            className="rs-stroke"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </>
      );
    case "cancelled":
      return (
        <>
          <circle
            cx="8"
            cy="8"
            r="6.6"
            fill="none"
            className="rs-stroke"
            strokeWidth="1.6"
          />
          <rect
            x="5.6"
            y="5.6"
            width="4.8"
            height="4.8"
            rx="0.8"
            className="rs-solid"
          />
        </>
      );
    case "unknown":
      return (
        <>
          <circle
            cx="8"
            cy="8"
            r="6.6"
            fill="none"
            className="rs-stroke"
            strokeWidth="1.6"
          />
          <path
            d="M6.3 6.3a1.8 1.8 0 1 1 2.5 1.6c-.5.3-.8.6-.8 1.2"
            fill="none"
            className="rs-stroke"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <circle cx="8" cy="11.4" r=".9" className="rs-solid" />
        </>
      );
  }
}
