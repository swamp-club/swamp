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
import type { ReactNode } from "react";
import { SkeletonList, SkeletonRegion } from "./Skeleton.tsx";

/**
 * Stands in for a health-backed panel while there is no snapshot to show, so
 * a refused or pending stream never reads as "nothing configured".
 *
 * While the stream has not delivered (`state="loading"`) it renders a
 * skeleton announced as "Loading <subject>": `skeleton` when given — pass
 * placeholders shaped like the panel's loaded rows — otherwise generic list
 * rows. `denied` renders the access notice.
 */
export function HealthUnavailable(
  { state, subject, skeleton }: {
    state: "denied" | "loading";
    subject: string;
    /** Decorative placeholders shaped like the loaded content. */
    skeleton?: ReactNode;
  },
) {
  if (state === "loading") {
    const label = `Loading ${subject}`;
    return skeleton === undefined
      ? <SkeletonList rows={3} label={label} />
      : <SkeletonRegion label={label}>{skeleton}</SkeletonRegion>;
  }
  return (
    <div className="notice notice-danger" role="alert">
      <div>
        Access denied: serve refused this token's health stream, so {subject}
        {" "}
        can't be shown. Log in again; if that doesn't help, this serve version
        only allows admin tokens to read health.
      </div>
    </div>
  );
}
