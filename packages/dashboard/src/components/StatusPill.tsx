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
const STYLED_STATUSES = new Set([
  "succeeded",
  "failed",
  "running",
  "suspended",
  "cancelled",
  "pending",
  "healthy",
  "degraded",
  "active",
  "idle",
]);

export function StatusPill({ status }: { status: string }) {
  const variant = STYLED_STATUSES.has(status) ? status : "pending";
  return (
    <span className={`status-pill status-pill--${variant}`}>
      {status}
    </span>
  );
}
