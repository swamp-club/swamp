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

import { cyan } from "@std/fmt/colors";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 80;

/**
 * Animated terminal spinner that writes to stderr.
 * No-ops when stderr is not a TTY.
 */
export class Spinner {
  #intervalId: ReturnType<typeof setInterval> | undefined;
  #frameIndex = 0;
  #message = "";
  #encoder = new TextEncoder();
  #active = false;

  start(message: string): void {
    if (!Deno.stderr.isTerminal()) return;
    this.#message = message;
    this.#frameIndex = 0;
    this.#active = true;
    this.#render();
    this.#intervalId = setInterval(() => {
      this.#frameIndex++;
      this.#render();
    }, INTERVAL_MS);
  }

  update(message: string): void {
    this.#message = message;
  }

  stop(): void {
    if (this.#intervalId !== undefined) {
      clearInterval(this.#intervalId);
      this.#intervalId = undefined;
    }
    if (this.#active) {
      Deno.stderr.writeSync(this.#encoder.encode("\r\x1b[K"));
      this.#active = false;
    }
  }

  #render(): void {
    const frame = cyan(FRAMES[this.#frameIndex % FRAMES.length]);
    Deno.stderr.writeSync(
      this.#encoder.encode(`\r\x1b[K${frame} ${this.#message}`),
    );
  }
}
