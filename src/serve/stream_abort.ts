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
 * Ending a forwarded response body when the forwarder shuts down.
 *
 * @module
 */

/**
 * Passes a forwarded body through, ending it when `signal` aborts.
 * Aborting the upstream fetch alone does not end a body already handed to
 * a response: the browser's stream (the health SSE) would run on and the
 * server's shutdown would wait for it forever.
 */
export function endOnAbort(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEnd: () => void = () => {},
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let ended = false;
  let told = false;
  const tell = () => {
    if (told) return;
    told = true;
    onEnd();
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const end = () => {
        if (ended) return;
        ended = true;
        reader.cancel().catch(() => {});
        try {
          controller.close();
        } catch {
          // Already closed.
        }
        tell();
      };
      if (signal.aborted) end();
      else signal.addEventListener("abort", end, { once: true });
    },
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (ended) return;
        if (done) {
          ended = true;
          controller.close();
          tell();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        if (!ended) {
          ended = true;
          controller.error(error);
        }
        tell();
      }
    },
    cancel(reason) {
      ended = true;
      tell();
      return reader.cancel(reason);
    },
  });
}
