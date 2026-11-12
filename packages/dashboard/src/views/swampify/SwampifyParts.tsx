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
import type { SwampifySkipped } from "../../lib/agent_sessions/swampify.ts";

const SKIP_REASON = {
  newer: "written by a newer version",
  older: "written by an older version",
  invalid: "not valid",
} as const;

/** A skipped item: the reader's note, never the item's content. */
export function SkipNotice(
  { item, skipped }: { item: string; skipped: SwampifySkipped },
) {
  return (
    <div className="sw-card sw-note sw-warn" role="status">
      This {item} was skipped, {SKIP_REASON[skipped.reason]}: {skipped.note}
    </div>
  );
}

/** The arrow on every Review and build button, so they read as one action. */
export function ReviewIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}
