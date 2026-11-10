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
 * a stuck sidecar fails the request rather than holding its reply for the CLI's
 * deadline
 */
export const SERVE_REQUEST_SYNC_DEADLINE_MS = 10_000;

/**
 * how long a member's reads ride out a serve node refusing them as not the
 * leader or behind, about a takeover's length; the pause allowed for work
 * that may go offline
 */
export const SERVE_READ_REFUSAL_BUDGET_MS = 15_000;
