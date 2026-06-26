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

export interface AuthNudgeState {
  lastShown?: string;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function shouldShowAuthNudge(state: AuthNudgeState): boolean {
  if (!state.lastShown) return true;
  const lastShown = new Date(state.lastShown).getTime();
  return Date.now() - lastShown >= ONE_DAY_MS;
}
