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
 * The message for a request a swamp serve refused because the caller is not
 * authenticated, naming the command that signs in to that serve. Shared by
 * the remote-run client and the datastore API client so both say the same
 * thing.
 *
 * @param serverUrl - The serve URL as the client connected to it (`ws(s)://`
 *   or `http(s)://`), shown in the command verbatim.
 */
export function serverLoginHint(serverUrl: string): string {
  return `Authentication failed — run: swamp auth server-login --server ${serverUrl}`;
}
