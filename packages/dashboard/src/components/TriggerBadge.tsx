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
const STYLED_TRIGGERS = new Set(["schedule", "webhook", "manual", "api"]);

export function TriggerBadge({ trigger }: { trigger: string | undefined }) {
  const label = trigger ?? "manual";
  const variant = STYLED_TRIGGERS.has(label) ? label : "manual";
  return (
    <span className={`trigger-badge trigger-badge--${variant}`}>
      {label}
    </span>
  );
}
