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
import type { CSSProperties } from "react";

/**
 * A request failed and there is nothing to show: says what couldn't load,
 * serve's message, and offers a retry (pass the request's `refetch`). Use
 * it for `loadState(...) === "error"`; never fall back to an empty state.
 * `inset` adds the margin it needs inside a panel body.
 */
export function LoadError(
  { subject, message, onRetry, inset = false, style }: {
    /** What failed to load, e.g. "vaults" → "Couldn't load vaults." */
    subject: string;
    message: string | null;
    onRetry: () => void;
    inset?: boolean;
    style?: CSSProperties;
  },
) {
  return (
    <div
      className="notice notice-danger"
      role="alert"
      style={{ ...(inset ? { margin: "12px 18px" } : {}), ...style }}
    >
      <div>
        <strong>Couldn't load {subject}.</strong>
        {message ? ` ${message}` : ""}
      </div>
      <div className="notice-links">
        <button type="button" className="btn-sm" onClick={onRetry}>
          Retry
        </button>
      </div>
    </div>
  );
}
