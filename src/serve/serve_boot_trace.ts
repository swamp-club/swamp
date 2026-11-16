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

import { getTracer, type Span } from "../infrastructure/tracing/tracer.ts";

export const SERVE_BOOT_SPAN = "swamp.serve.boot";
export const SERVE_BOOT_PHASE_EVENT = "swamp.serve.boot.phase";

/**
 * serve's boot from its action's start to /ready, one event as each phase ends,
 * so the time no other span covers is attributed without nesting the boot
 */
export class ServeBootTrace implements Disposable {
  readonly #span: Span;
  #ended = false;

  constructor() {
    this.#span = getTracer().startSpan(SERVE_BOOT_SPAN);
  }

  phase(name: string): void {
    if (this.#ended) return;
    this.#span.addEvent(SERVE_BOOT_PHASE_EVENT, {
      "swamp.serve.boot.phase.name": name,
    });
  }

  end(ready: boolean): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#span.setAttribute("swamp.serve.boot.ready", ready);
    this.#span.end();
  }

  /** a boot that threw or returned before ready still exports its span */
  [Symbol.dispose](): void {
    this.end(false);
  }
}
