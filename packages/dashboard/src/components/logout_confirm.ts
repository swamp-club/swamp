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

export type LogoutStep = "idle" | "confirming";

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

export function logoutConfirmed(step: LogoutStep, event: LogoutEvent): boolean {
  return step === "confirming" && event === "confirm";
}
