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
import { ProcessRuntime } from "../src/infrastructure/runtime/process_runtime.ts";

const cleanContext = AsyncLocalStorage.snapshot();

/** sets up an actor and answers what it is sent through `post`; `stopped` aborts on terminate */
export type ProcessHost<Request, Message> = (
  post: (message: Message) => void,
  stopped: AbortSignal,
) => (request: Request) => void;

export interface ProcessHostHandle<Request> {
  postMessage(request: Request): void;
  /**
   * aborts the host's `stopped` signal and drops its later messages; services
   * a hosted serve started keep running, so a test ends a serve with its stop()
   */
  terminate(): void;
}

/**
 * plays another swamp process in this isolate: the host and everything it
 * awaits see their own writer holds, handles and env, never the test's; the
 * test's onMessage runs in the test's own context
 */
export function startProcessHost<Request, Message>(
  name: string,
  host: ProcessHost<Request, Message>,
  onMessage: (message: Message) => void,
): ProcessHostHandle<Request> {
  const runtime = new ProcessRuntime(`${name}-${crypto.randomUUID()}`);
  const stop = new AbortController();
  const inTest = AsyncLocalStorage.snapshot();
  // the host starts from a clean context, so nothing of the test's reaches it
  const inHost = <T>(fn: () => T): T => cleanContext(() => runtime.run(fn));
  // a reply is delivered after the send returns, as a Worker's would be
  const post = (message: Message) =>
    queueMicrotask(() =>
      inTest(() => {
        if (!stop.signal.aborted) onMessage(message);
      })
    );
  const send = inHost(() => host(post, stop.signal));
  return {
    postMessage: (request) => inHost(() => send(request)),
    terminate: () => stop.abort(),
  };
}
