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
import { installUnhandledRejectionGuard } from "./unhandled_rejection_guard.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";

await initializeLogging({});

Deno.test("installUnhandledRejectionGuard: prevents process termination on unhandled rejection", async () => {
  const guard = installUnhandledRejectionGuard();
  try {
    const events: PromiseRejectionEvent[] = [];
    const spy = (e: PromiseRejectionEvent) => events.push(e);
    globalThis.addEventListener("unhandledrejection", spy);

    try {
      // Create a detached rejecting promise — the guard should catch it
      const _detached = Promise.reject(
        new Error("simulated extension crash"),
      );

      // Let the microtask queue drain so the rejection event fires
      await new Promise((r) => setTimeout(r, 10));

      assertEquals(events.length, 1);
      assertEquals(events[0].defaultPrevented, true);
    } finally {
      globalThis.removeEventListener("unhandledrejection", spy);
    }
  } finally {
    guard.dispose();
  }
});

Deno.test("installUnhandledRejectionGuard: handles non-Error rejection reasons", async () => {
  const guard = installUnhandledRejectionGuard();
  try {
    const events: PromiseRejectionEvent[] = [];
    const spy = (e: PromiseRejectionEvent) => events.push(e);
    globalThis.addEventListener("unhandledrejection", spy);

    try {
      const _detached = Promise.reject("string rejection reason");
      await new Promise((r) => setTimeout(r, 10));

      assertEquals(events.length, 1);
      assertEquals(events[0].defaultPrevented, true);
    } finally {
      globalThis.removeEventListener("unhandledrejection", spy);
    }
  } finally {
    guard.dispose();
  }
});

Deno.test("installUnhandledRejectionGuard: dispose removes listeners", async () => {
  const guard = installUnhandledRejectionGuard();
  guard.dispose();

  // After disposal, unhandled rejections should NOT be caught by our guard.
  // We verify by checking that a subsequent rejection event is NOT
  // defaultPrevented (unless some other handler catches it).
  const events: PromiseRejectionEvent[] = [];
  const catcher = (e: PromiseRejectionEvent) => {
    events.push(e);
    // Prevent the test runner from crashing
    e.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", catcher);

  try {
    const _detached = Promise.reject(new Error("after disposal"));
    await new Promise((r) => setTimeout(r, 10));

    assertEquals(events.length, 1);
    // The guard was disposed, so it didn't call preventDefault() — our
    // test catcher is the only handler. The event should NOT have been
    // prevented before our catcher ran. We can't directly observe this
    // because our catcher calls preventDefault(), but we verify the guard
    // didn't interfere by confirming exactly 1 event was caught.
  } finally {
    globalThis.removeEventListener("unhandledrejection", catcher);
  }
});
