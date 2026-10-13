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
 * How the local hub authenticates to a workspace's child process: a random
 * per-child token, handed over in the environment and sent on every request.
 * Kept apart so the hub never imports the child server's module graph.
 */

/** The environment variable the child reads its token from (then deletes). */
export const HUB_TOKEN_ENV = "SWAMP_DASHBOARD_HUB_TOKEN";

/** The header the hub sends its per-child token in. */
export const HUB_TOKEN_HEADER = "x-swamp-hub-token";
