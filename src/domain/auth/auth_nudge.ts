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

export const AUTH_NUDGE_MESSAGE =
  "Tip: Join & participate in the community by logging in to swamp-club.com: swamp auth login";

export const AUTH_FIRST_RUN_MESSAGE_LINES = [
  "Swamp is powered by SWAMP CLUB (swamp-club.com)",
  "",
  "Connect your account to unlock:",
  "  - Higher rate limits",
  "  - Community features",
  "",
  "Get started: swamp auth login",
] as const;

export interface AuthNudgeState {
  lastShown?: string;
  firstRunShown?: boolean;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function isFirstRunNudge(state: AuthNudgeState): boolean {
  return !state.firstRunShown;
}

export function shouldShowAuthNudge(state: AuthNudgeState): boolean {
  if (!state.firstRunShown) return true;
  if (!state.lastShown) return true;
  const lastShown = new Date(state.lastShown).getTime();
  return Date.now() - lastShown >= ONE_DAY_MS;
}
