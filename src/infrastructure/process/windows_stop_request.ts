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

import { getLogger } from "@logtape/logtape";

const logger = getLogger(["process", "stop-request"]);

/**
 * Deno turns signals to other processes into TerminateProcess on Windows, so a
 * stop is a session-local named event; the default DACL is acceptable as anyone
 * who can open it could terminate swamp anyway
 */

export interface Kernel32Events {
  CreateEventW(
    attributes: null,
    manualReset: number,
    initialState: number,
    name: BufferSource,
  ): Deno.PointerValue;
  OpenEventW(
    access: number,
    inherit: number,
    name: BufferSource,
  ): Deno.PointerValue;
  SetEvent(event: Deno.PointerValue): number;
  WaitForSingleObject(handle: Deno.PointerValue, milliseconds: number): number;
  CloseHandle(handle: Deno.PointerValue): number;
}

const KERNEL32_SYMBOLS = {
  CreateEventW: {
    parameters: ["pointer", "i32", "i32", "buffer"],
    result: "pointer",
  },
  OpenEventW: { parameters: ["u32", "i32", "buffer"], result: "pointer" },
  SetEvent: { parameters: ["pointer"], result: "i32" },
  WaitForSingleObject: { parameters: ["pointer", "u32"], result: "u32" },
  CloseHandle: { parameters: ["pointer"], result: "i32" },
} as const;

export const EVENT_MODIFY_STATE = 0x0002;
export const WAIT_OBJECT_0 = 0;
export const STOP_REQUEST_POLL_MS = 100;

export function stopRequestEventName(pid: number): string {
  return `Local\\swamp-stop-${pid}`;
}

export function wideString(text: string): Uint16Array<ArrayBuffer> {
  const wide = new Uint16Array(text.length + 1);
  for (let i = 0; i < text.length; i++) wide[i] = text.charCodeAt(i);
  return wide;
}

export function sendStopRequest(
  kernel32: Kernel32Events,
  pid: number,
): boolean {
  const event = kernel32.OpenEventW(
    EVENT_MODIFY_STATE,
    0,
    wideString(stopRequestEventName(pid)),
  );
  if (event === null) return false;
  try {
    return kernel32.SetEvent(event) !== 0;
  } finally {
    kernel32.CloseHandle(event);
  }
}

export interface PollScheduler {
  start(poll: () => void): () => void;
}

const intervalScheduler: PollScheduler = {
  start(poll) {
    const id = setInterval(poll, STOP_REQUEST_POLL_MS);
    Deno.unrefTimer(id);
    return () => clearInterval(id);
  },
};

export interface StopRequestListener {
  subscribe(handler: () => void): (() => void) | undefined;
}

/**
 * A listener for the stop requests sent to `pid`. Its event is created by
 * the first subscription and closed when the last one ends; a request
 * reaches every subscription, as one SIGTERM reaches every listener.
 */
export function createStopRequestListener(
  load: () => Kernel32Events | null,
  pid: number,
  scheduler: PollScheduler = intervalScheduler,
): StopRequestListener {
  const subscriptions = new Set<{ handler: () => void }>();
  let open: { kernel32: Kernel32Events; event: Deno.PointerValue } | undefined;
  let stopPolling: (() => void) | undefined;

  function poll(): void {
    if (open === undefined) return;
    if (open.kernel32.WaitForSingleObject(open.event, 0) !== WAIT_OBJECT_0) {
      return;
    }
    // One handler that throws must not keep the request from the others,
    // nor escape the interval as an uncaught error.
    for (const subscription of [...subscriptions]) {
      try {
        subscription.handler();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        logger.error`Stop request handler failed: ${reason}`;
      }
    }
  }

  function openEvent(): boolean {
    const kernel32 = load();
    if (kernel32 === null) return false;
    let event: Deno.PointerValue;
    try {
      event = kernel32.CreateEventW(
        null,
        0,
        0,
        wideString(stopRequestEventName(pid)),
      );
    } catch {
      return false;
    }
    if (event === null) return false;
    try {
      // An event already set belongs to a process that held this pid
      // before and was sent a stop it never took: it is not meant for this
      // one.
      kernel32.WaitForSingleObject(event, 0);
      stopPolling = scheduler.start(poll);
    } catch {
      kernel32.CloseHandle(event);
      return false;
    }
    open = { kernel32, event };
    return true;
  }

  function closeEvent(): void {
    stopPolling?.();
    stopPolling = undefined;
    if (open !== undefined) open.kernel32.CloseHandle(open.event);
    open = undefined;
  }

  return {
    subscribe(handler) {
      if (subscriptions.size === 0 && !openEvent()) return undefined;
      const subscription = { handler };
      subscriptions.add(subscription);
      return () => {
        if (!subscriptions.delete(subscription)) return;
        if (subscriptions.size === 0) closeEvent();
      };
    },
  };
}

let kernel32Events: Kernel32Events | null | undefined;

export function loadKernel32Events(): Kernel32Events | null {
  if (kernel32Events === undefined) {
    try {
      kernel32Events = Deno.dlopen("kernel32.dll", KERNEL32_SYMBOLS).symbols;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger
        .debug`Stop requests unavailable (${reason}); stops from swamp end this process outright`;
      kernel32Events = null;
    }
  }
  return kernel32Events;
}

let processListener: StopRequestListener | undefined;

function processStopRequests(): StopRequestListener {
  processListener ??= createStopRequestListener(loadKernel32Events, Deno.pid);
  return processListener;
}

export function listenForStopRequests(
  handler: () => void,
  os: typeof Deno.build.os = Deno.build.os,
  listener: () => StopRequestListener = processStopRequests,
): (() => void) | undefined {
  if (os !== "windows") return undefined;
  return listener().subscribe(handler);
}

/**
 * false on other platforms and when no listening process could be reached, so
 * the caller ends it another way
 */
export function requestStop(
  pid: number,
  os: typeof Deno.build.os = Deno.build.os,
  load: () => Kernel32Events | null = loadKernel32Events,
): boolean {
  if (os !== "windows") return false;
  const kernel32 = load();
  if (kernel32 === null) return false;
  try {
    return sendStopRequest(kernel32, pid);
  } catch {
    return false;
  }
}
