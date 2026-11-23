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

import type { ForwardedCommitClass } from "../domain/datastore_v3/forwarded_commit_class.ts";

interface Waiter {
  readonly kind: ForwardedCommitClass;
  readonly grant: () => void;
}

/**
 * Shared sections run together, an exclusive one alone. Entry is first come,
 * first served: a shared section arriving behind a waiting exclusive one waits
 * too, so a steady shared stream cannot starve it.
 */
export class ForwardedCommitGate {
  #shared = 0;
  #exclusive = false;
  readonly #waiting: Waiter[] = [];

  async run<T>(kind: ForwardedCommitClass, fn: () => Promise<T>): Promise<T> {
    await this.#enter(kind);
    try {
      return await fn();
    } finally {
      if (kind === "exclusive") this.#exclusive = false;
      else this.#shared--;
      this.#admit();
    }
  }

  /** sections running and waiting, for spans and tests */
  get state(): { shared: number; exclusive: boolean; waiting: number } {
    return {
      shared: this.#shared,
      exclusive: this.#exclusive,
      waiting: this.#waiting.length,
    };
  }

  #enter(kind: ForwardedCommitClass): Promise<void> {
    if (this.#waiting.length === 0 && this.#admits(kind)) {
      this.#take(kind);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#waiting.push({ kind, grant: resolve });
    });
  }

  #admits(kind: ForwardedCommitClass): boolean {
    return kind === "exclusive"
      ? !this.#exclusive && this.#shared === 0
      : !this.#exclusive;
  }

  #take(kind: ForwardedCommitClass): void {
    if (kind === "exclusive") this.#exclusive = true;
    else this.#shared++;
  }

  #admit(): void {
    while (this.#waiting.length > 0 && this.#admits(this.#waiting[0].kind)) {
      const next = this.#waiting.shift()!;
      this.#take(next.kind);
      next.grant();
    }
  }
}

const gates = new WeakMap<object, ForwardedCommitGate>();

/** one gate per datastore handle, shared by every request to it */
export function forwardedCommitGateOf(v3: object): ForwardedCommitGate {
  let gate = gates.get(v3);
  if (gate === undefined) {
    gate = new ForwardedCommitGate();
    gates.set(v3, gate);
  }
  return gate;
}
