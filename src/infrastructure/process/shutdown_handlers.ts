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
 * Windows supports only SIGINT (SIGTERM or SIGHUP listeners throw), so it
 * listens for other swamp processes' stop requests instead; POSIX registers all
 * three unless includePosixSignals is false
 */
import { listenForStopRequests } from "./windows_stop_request.ts";
import {
  DATA_WRITE_STOP_GRACE_MS,
  type InFlightDataWrites,
} from "../../domain/data/in_flight_data_writes.ts";
import { getSwampLogger } from "../logging/logger.ts";

export interface ShutdownHandlerOptions {
  /**
   * Handler invoked once per signal arrival. Errors thrown synchronously
   * are not caught here; the caller is responsible for error handling
   * inside the handler.
   */
  handler: () => void | Promise<void>;
  /**
   * also registers SIGTERM and SIGHUP on POSIX; on Windows it decides whether
   * the handler listens for stop requests, the SIGTERM swamp sends there
   */
  includePosixSignals?: boolean;
  /**
   * a second signal force-exits with code 130, preventing a stuck process when
   * in-flight work ignores the abort the handler fires
   */
  forceExitOnRepeat?: boolean;
  /**
   * with forceExitOnRepeat, a second signal first lets these started writes
   * land, up to DATA_WRITE_STOP_GRACE_MS; a third exits at once
   */
  dataWrites?: Pick<InFlightDataWrites, "size" | "settle">;
}

export interface ShutdownHandlerHandle {
  dispose: () => void;
}

export interface ShutdownHandlerDeps {
  os?: typeof Deno.build.os;
  listenForStopRequests?: (handler: () => void) => (() => void) | undefined;
  exit?: (code: number) => void;
}

const POSIX_ONLY_SIGNALS: readonly Deno.Signal[] = ["SIGTERM", "SIGHUP"];

/**
 * a Windows stop request counts as a signal for forceExitOnRepeat; the disposer
 * removes only listeners actually registered and stops listening for stop
 * requests
 */
export function registerShutdownHandler(
  options: ShutdownHandlerOptions,
  {
    os = Deno.build.os,
    listenForStopRequests: listen = listenForStopRequests,
    exit = Deno.exit,
  }: ShutdownHandlerDeps = {},
): ShutdownHandlerHandle {
  const {
    handler,
    includePosixSignals = true,
    forceExitOnRepeat = false,
    dataWrites,
  } = options;

  const registered: Deno.Signal[] = [];

  let fired = 0;
  const wrappedHandler = forceExitOnRepeat
    ? () => {
      fired++;
      if (fired === 1) {
        handler();
        return;
      }
      if (fired === 2 && dataWrites !== undefined && dataWrites.size > 0) {
        getSwampLogger(["shutdown"]).warn(
          "Waiting for {count} data write(s) to finish before exiting; signal again to exit now",
          { count: dataWrites.size },
        );
        dataWrites.settle(DATA_WRITE_STOP_GRACE_MS).then(
          () => exit(130),
          () => exit(130),
        );
        return;
      }
      exit(130);
    }
    : handler;

  Deno.addSignalListener("SIGINT", wrappedHandler);
  registered.push("SIGINT");

  let stopListening: (() => void) | undefined;
  if (includePosixSignals && os === "windows") {
    stopListening = listen(wrappedHandler);
  } else if (includePosixSignals) {
    for (const signal of POSIX_ONLY_SIGNALS) {
      Deno.addSignalListener(signal, wrappedHandler);
      registered.push(signal);
    }
  }

  let disposed = false;

  function removeAll(): void {
    if (disposed) return;
    disposed = true;
    stopListening?.();
    for (const signal of registered) {
      try {
        Deno.removeSignalListener(signal, wrappedHandler);
      } catch {
        // Listener may have already been removed (e.g. if Deno's
        // signal infrastructure tore it down). Best-effort cleanup.
      }
    }
  }

  return { dispose: removeAll };
}
