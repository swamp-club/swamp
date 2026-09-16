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

export const AUTH_ENFORCEMENT_DEADLINE = "October 1st, 2026";

export const AUTH_WARNING_MESSAGE =
  `swamp will require authentication from ${AUTH_ENFORCEMENT_DEADLINE}. Run \`swamp auth login\` to authenticate.`;

export const AUTH_WARNING_FIRST_RUN_LINES = [
  `Authentication required from ${AUTH_ENFORCEMENT_DEADLINE}`,
  "",
  "Starting October 1st, swamp will require authentication.",
  "",
  "Sign in now: swamp auth login",
] as const;

export const AUTH_HARD_BLOCK_MESSAGE =
  "swamp requires a swamp-club.com account.";

export const AUTH_HARD_BLOCK_HINT =
  "Run `swamp auth login` to create an account or sign in.";

export interface AuthNudgeState {
  lastShown?: string;
  firstRunShown?: boolean;
}

export function isFirstRunNudge(state: AuthNudgeState): boolean {
  return !state.firstRunShown && !state.lastShown;
}
