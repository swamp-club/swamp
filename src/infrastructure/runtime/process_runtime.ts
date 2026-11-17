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

import { AsyncLocalStorage } from "node:async_hooks";
import { keepAcrossAmbientReset } from "./ambient_context.ts";

/**
 * the state one swamp process keeps for itself: writer holds, open datastore
 * handles, serve registrations, its stop signal. Production has exactly one; a
 * test that plays a second process in the same isolate runs it in another
 */
export class ProcessRuntime {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  run<T>(fn: () => T): T {
    return current.run(this, fn);
  }
}

export const PROCESS_RUNTIME = new ProcessRuntime("process");

const current = new AsyncLocalStorage<ProcessRuntime>();
keepAcrossAmbientReset(current);

export function currentProcessRuntime(): ProcessRuntime {
  return current.getStore() ?? PROCESS_RUNTIME;
}

/**
 * Declares a piece of per-runtime state, created on first use in each runtime.
 * Pass the runtime a timer or listener captured when it was set up: callbacks
 * must not depend on which runtime happens to be current when they fire.
 */
export function processRuntimeSlot<T>(
  create: () => T,
): (runtime?: ProcessRuntime) => T {
  const states = new WeakMap<ProcessRuntime, T>();
  return (runtime = currentProcessRuntime()) => {
    let state = states.get(runtime);
    if (state === undefined) {
      state = create();
      states.set(runtime, state);
    }
    return state;
  };
}
