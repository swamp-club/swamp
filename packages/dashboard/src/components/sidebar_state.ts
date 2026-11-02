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

export const MOBILE_BREAKPOINT_PX = 768;

export const MOBILE_MEDIA_QUERY = `(max-width: ${MOBILE_BREAKPOINT_PX}px)`;

export const SIDEBAR_COLLAPSED_KEY = "swamp-dashboard-sidebar-collapsed";

export function parseCollapsed(raw: string | null): boolean {
  return raw === "true";
}

export type EscapeAction = "close-drawer" | "leave-detail" | "none";

/**
 * an open drawer sits on top of the detail view, so it closes first; callers
 * pass drawerOpen true only while the mobile query matches, so a stale open
 * drawer cannot swallow Escape on desktop
 */
export function resolveEscape(
  drawerOpen: boolean,
  hasDetail: boolean,
): EscapeAction {
  if (drawerOpen) return "close-drawer";
  if (hasDetail) return "leave-detail";
  return "none";
}

export interface NavOff {
  readonly hint: string;
  readonly description: string;
}

const AUDIT_OFF: NavOff = { hint: "Off", description: "Audit log is disabled" };
const SERVE_ONLY_OFF: NavOff = {
  hint: "Off",
  description: "Needs swamp serve",
};

/**
 * activity is off without an audit log; the local dashboard also turns off
 * schedules and webhooks, which only a running serve fires. agent sessions is
 * absent on purpose: with no readable session it is hidden, not off
 */
export function operationsOff(
  options: { auditEnabled: boolean; local: boolean },
): { schedules?: NavOff; webhooks?: NavOff; activity?: NavOff } {
  return {
    ...(options.local
      ? { schedules: SERVE_ONLY_OFF, webhooks: SERVE_ONLY_OFF }
      : {}),
    ...(options.auditEnabled ? {} : { activity: AUDIT_OFF }),
  };
}

export function showsLogout(local: boolean): boolean {
  return !local;
}
