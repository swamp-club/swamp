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
 * SIGHUP reloads on a serve nobody is attached to (a daemon, a container,
 * systemd's ExecReload) or one started with --hot-reload; a foreground serve
 * on a terminal keeps it as shutdown, so closing the terminal still stops it.
 */
export function reloadsOnHangup(options: {
  readonly os: string;
  readonly hotReload: boolean;
  readonly stdinIsTerminal: boolean;
}): boolean {
  if (options.os === "windows") return false;
  return options.hotReload || !options.stdinIsTerminal;
}
