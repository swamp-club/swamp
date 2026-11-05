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

import { assertEquals } from "@std/assert";
import { holdUntilSignal, type SignalSources } from "./hold_until_signal.ts";

function fakeSources(os: typeof Deno.build.os = "linux") {
  const listeners = new Map<string, () => void>();
  let disposed = 0;
  const sources: SignalSources = {
    onInterrupt: (listener) => {
      listeners.set("SIGINT", listener);
      return {
        dispose: () => {
          disposed++;
          listeners.delete("SIGINT");
        },
      };
    },
    addSignal: (signal, listener) => listeners.set(signal, listener),
    removeSignal: (signal) => listeners.delete(signal),
    os,
  };
  return {
    sources,
    listeners,
    fire: (signal: string) => listeners.get(signal)?.(),
    disposed: () => disposed,
  };
}

for (
  const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], [
    "SIGHUP",
    129,
  ]] as const
) {
  Deno.test(`holdUntilSignal: ${signal} interrupts with exit code ${code} and removes every listener`, async () => {
    const fake = fakeSources();
    const never = new Promise<string>(() => {});
    const held = holdUntilSignal(never, fake.sources);
    fake.fire(signal);
    fake.fire("SIGINT");
    assertEquals(await held, { result: "interrupted", exitCode: code });
    assertEquals(fake.listeners.size, 0);
    assertEquals(fake.disposed(), 1);
  });
}

Deno.test("holdUntilSignal: the awaited end wins without an exit code", async () => {
  const fake = fakeSources();
  assertEquals(await holdUntilSignal(Promise.resolve("done"), fake.sources), {
    result: "done",
  });
  assertEquals(fake.listeners.size, 0);
});

Deno.test("holdUntilSignal: Windows listens for SIGINT only", async () => {
  const fake = fakeSources("windows");
  const held = holdUntilSignal(new Promise<string>(() => {}), fake.sources);
  assertEquals([...fake.listeners.keys()], ["SIGINT"]);
  fake.fire("SIGINT");
  assertEquals(await held, { result: "interrupted", exitCode: 130 });
});
