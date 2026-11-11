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
import { sessionRefTarget } from "../../lib/swampify_view.ts";

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
    <div className="as-notice as-sw-skip" role="status">
      This {item} was skipped, {SKIP_REASON[skipped.reason]}: {skipped.note}
    </div>
  );
}

/**
 * A session a candidate was seen in: a link that opens it on this page when
 * the page loaded that session, plain text otherwise. The href is built from
 * the checked data name, never from item text as given.
 */
export function SessionRef(
  { sessionRef, loaded, onOpen }: {
    sessionRef: { readonly harness: string; readonly sessionId: string };
    loaded: ReadonlySet<string>;
    onOpen: (name: string) => void;
  },
) {
  const name = sessionRefTarget(sessionRef, loaded);
  const label = `${sessionRef.harness} ${sessionRef.sessionId.slice(0, 8)}`;
  if (name === null) {
    return (
      <span
        className="as-muted"
        title={`${sessionRef.harness} ${sessionRef.sessionId}: not in the sessions this page loaded`}
      >
        {label}
      </span>
    );
  }
  return (
    <a
      href={`?${new URLSearchParams({ session: name })}`}
      title={`Open ${sessionRef.harness} session ${sessionRef.sessionId}`}
      onClick={(e) => {
        e.preventDefault();
        onOpen(name);
      }}
    >
      {label}
    </a>
  );
}
