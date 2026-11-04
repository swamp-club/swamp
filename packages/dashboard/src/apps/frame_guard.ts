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
 * One port per document: a frame can navigate itself, so a second ready could be
 * someone else's page. Only a dev server reloads its own page.
 */
export class FrameGuard {
  #portGiven = false;
  #loads = 0;

  constructor(private readonly dev: boolean) {}

  /** Whether this ready message gets a port. */
  mayGrantPort(): boolean {
    if (this.#portGiven && !this.dev) return false;
    this.#portGiven = true;
    return true;
  }

  /** Records a load; true means a built app has left its page. */
  loaded(): boolean {
    return ++this.#loads > 1 && !this.dev;
  }
}

/** A dev launch is an absolute loopback URL; a built one is a server path. */
export function isDevLaunch(url: string): boolean {
  return /^https?:/.test(url);
}

/** One launch per open: a second would restart the frame on a new URL. */
export function needsLaunch(connected: boolean, launch: unknown): boolean {
  return connected && launch === null;
}
