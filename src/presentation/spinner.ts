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

import { swampColor } from "./swamp_colors.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 80;

/** Where the spinner draws; replaced in tests. */
export interface SpinnerOptions {
  /** Writes raw text to stderr. */
  write?: (text: string) => void;
  /** True when stderr is a terminal; the spinner draws nothing otherwise. */
  isTerminal?: () => boolean;
}

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
  #write: (text: string) => void;
  #isTerminal: () => boolean;

  constructor(options: SpinnerOptions = {}) {
    this.#write = options.write ??
      ((text) => Deno.stderr.writeSync(this.#encoder.encode(text)));
    this.#isTerminal = options.isTerminal ?? (() => Deno.stderr.isTerminal());
  }

  start(message: string): void {
    if (!this.#isTerminal()) return;
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

  /** Stops and clears the spinner's row. */
  stop(): void {
    this.#settle("");
  }

  /**
   * Stops and leaves `line` in place of the spinner, followed by a newline,
   * so whatever is written next starts on a fresh row.
   */
  finish(line: string): void {
    this.#settle(`${line}\n`);
  }

  #settle(text: string): void {
    if (this.#intervalId !== undefined) {
      clearInterval(this.#intervalId);
      this.#intervalId = undefined;
    }
    if (this.#active) {
      this.#write(`\r\x1b[K${text}`);
      this.#active = false;
    }
  }

  #render(): void {
    const frame = swampColor("cyan", FRAMES[this.#frameIndex % FRAMES.length]);
    this.#write(`\r\x1b[K${frame} ${this.#message}`);
  }
}
