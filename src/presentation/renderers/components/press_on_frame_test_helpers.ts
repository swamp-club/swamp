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

import type { render } from "ink-testing-library";

/**
 * writes keys from inside the stdout write of the first frame that satisfies
 * shows, before React runs that render's effects, making the window before Ink
 * re-binds useInput deterministic
 */
export function pressOnFrame(
  instance: ReturnType<typeof render>,
  shows: (frame: string) => boolean,
  keys: string,
): void {
  const { stdout, stdin } = instance;
  const write = stdout.write;
  stdout.write = (frame: string) => {
    write(frame);
    if (shows(frame)) {
      stdout.write = write;
      stdin.write(keys);
    }
  };
}
