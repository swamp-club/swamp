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

/** Where the sidebar's Logout is in its two-step confirm. */
export type LogoutStep = "idle" | "confirming";

/**
 * What moved it: a click on Logout, Keep or Log out, or a dismiss (a click
 * outside, or the rail toggled).
 */
export type LogoutEvent = "ask" | "keep" | "confirm" | "dismiss";

/**
 * The next step of the confirm. Asking again while confirming stays put, so
 * a double-click on Logout leaves the confirm open instead of toggling it.
 */
export function nextLogoutStep(
  _step: LogoutStep,
  event: LogoutEvent,
): LogoutStep {
  return event === "ask" ? "confirming" : "idle";
}

/** Only Log out from an open confirm logs out; one click never does. */
export function logoutConfirmed(step: LogoutStep, event: LogoutEvent): boolean {
  return step === "confirming" && event === "confirm";
}
