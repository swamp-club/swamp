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

import { registerShutdownHandler } from "../infrastructure/process/shutdown_handlers.ts";

export interface SignalSources {
  /** SIGINT, through the shared handler so it also works on Windows */
  onInterrupt(listener: () => void): { dispose(): void };
  addSignal(signal: Deno.Signal, listener: () => void): void;
  removeSignal(signal: Deno.Signal, listener: () => void): void;
  readonly os: typeof Deno.build.os;
}

const defaultSources: SignalSources = {
  onInterrupt: (listener) =>
    registerShutdownHandler({ handler: listener, includePosixSignals: false }),
  addSignal: (signal, listener) => Deno.addSignalListener(signal, listener),
  removeSignal: (signal, listener) =>
    Deno.removeSignalListener(signal, listener),
  os: Deno.build.os,
};

export interface Held<T> {
  readonly result: T | "interrupted";
  /** 130 for SIGINT, 143 for SIGTERM, 129 for SIGHUP; unset when `until` settled first */
  readonly exitCode?: number;
}

/**
 * Waits for `until` or a stop signal, whichever comes first, and always
 * removes its signal listeners before returning.
 */
export async function holdUntilSignal<T>(
  until: Promise<T>,
  sources: SignalSources = defaultSources,
): Promise<Held<T>> {
  let exitCode: number | undefined;
  const interrupted = Promise.withResolvers<"interrupted">();
  const stopWith = (code: number) => () => {
    exitCode ??= code;
    interrupted.resolve("interrupted");
  };
  const interrupt = sources.onInterrupt(stopWith(130));
  const posixSignals: Array<[Deno.Signal, () => void]> = sources.os ===
      "windows"
    ? []
    : [["SIGTERM", stopWith(143)], ["SIGHUP", stopWith(129)]];
  for (const [signal, listener] of posixSignals) {
    sources.addSignal(signal, listener);
  }
  try {
    const result = await Promise.race([until, interrupted.promise]);
    return exitCode === undefined ? { result } : { result, exitCode };
  } finally {
    interrupt.dispose();
    for (const [signal, listener] of posixSignals) {
      try {
        sources.removeSignal(signal, listener);
      } catch {
        // Already removed.
      }
    }
  }
}
