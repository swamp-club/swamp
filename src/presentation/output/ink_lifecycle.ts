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

import process from "node:process";

function isWouldBlock(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  return (
    e.name === "WouldBlock" ||
    (typeof e.message === "string" && e.message.includes("os error 11"))
  );
}

/**
 * works around a Deno bug where EAGAIN on non-blocking TTY reads during ink's
 * stdin cleanup crashes instead of retrying; suppresses WouldBlock on stdin
 * error, unhandledrejection and error.
 */
export function suppressInkTtyErrors(): () => void {
  const onStdinError = (err: Error) => {
    if (!isWouldBlock(err)) throw err;
  };

  const onRejection = (event: PromiseRejectionEvent) => {
    if (isWouldBlock(event.reason)) event.preventDefault();
  };

  const onError = (event: ErrorEvent) => {
    if (isWouldBlock(event.error)) event.preventDefault();
  };

  process.stdin.on("error", onStdinError);
  globalThis.addEventListener("unhandledrejection", onRejection);
  globalThis.addEventListener("error", onError);

  return () => {
    // Delay removal to catch late-firing errors from ink's async cleanup
    setTimeout(() => {
      process.stdin.removeListener("error", onStdinError);
      globalThis.removeEventListener("unhandledrejection", onRejection);
      globalThis.removeEventListener("error", onError);
    }, 100);
  };
}
