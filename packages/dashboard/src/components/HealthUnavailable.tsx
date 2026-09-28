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

/**
 * Stands in for a health-backed panel while there is no snapshot to show, so
 * a refused or pending stream never reads as "nothing configured".
 */
export function HealthUnavailable(
  { state, subject }: { state: "denied" | "loading"; subject: string },
) {
  if (state === "loading") {
    return <div className="loading">Loading {subject}…</div>;
  }
  return (
    <div className="notice notice-danger" role="alert">
      <div>
        Access denied: serve refused this token's health stream, so {subject}
        {" "}
        can't be shown.
      </div>
    </div>
  );
}
