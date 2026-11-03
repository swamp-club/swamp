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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { hostname } from "node:os";
import {
  checkOpenFileLimit,
  getOpenFileSoftLimit,
  isProcessGone,
  type Kernel32Liveness,
  processGoneWith,
  processHostIdentity,
  tryRaiseOpenFileLimit,
  windowsProcessGone,
} from "./process.ts";

Deno.test("processGoneWith: answers alive for its own pid without probing", () => {
  let probes = 0;
  const probe = () => {
    probes++;
    return true;
  };
  assertEquals(processGoneWith(4242, 4242, probe), false);
  assertEquals(probes, 0);
});

Deno.test("processGoneWith: probes any other pid once and returns its answer", () => {
  const probed: number[] = [];
  const probe = (pid: number) => {
    probed.push(pid);
    return pid === 7;
  };
  assertEquals(processGoneWith(7, 4242, probe), true);
  assertEquals(processGoneWith(8, 4242, probe), false);
  assertEquals(probed, [7, 8]);
});

function fakeKernel32(
  options: { open: boolean; exitCode?: number; readExitCode?: boolean },
): { kernel32: Kernel32Liveness; closed: () => number } {
  const handle = Deno.UnsafePointer.create(1n);
  let closed = 0;
  return {
    kernel32: {
      OpenProcess: () => options.open ? handle : null,
      GetExitCodeProcess: (_process, exitCode) => {
        if (options.readExitCode === false) return 0;
        if (!(exitCode instanceof Uint32Array)) {
          throw new Error("exit code must be read into a Uint32Array");
        }
        exitCode[0] = options.exitCode ?? 0;
        return 1;
      },
      CloseHandle: () => {
        closed++;
        return 1;
      },
    },
    closed: () => closed,
  };
}

const noFallback = () => {
  throw new Error("fallback must not run");
};

Deno.test("windowsProcessGone: a still-active process is alive and its handle is closed", () => {
  const fake = fakeKernel32({ open: true, exitCode: 259 });
  assertEquals(windowsProcessGone(10, fake.kernel32, noFallback), false);
  assertEquals(fake.closed(), 1);
});

Deno.test("windowsProcessGone: a process with an exit code is gone and its handle is closed", () => {
  const fake = fakeKernel32({ open: true, exitCode: 0 });
  assertEquals(windowsProcessGone(10, fake.kernel32, noFallback), true);
  assertEquals(fake.closed(), 1);
});

Deno.test("windowsProcessGone: an unreadable exit code reads alive and the handle is closed", () => {
  const fake = fakeKernel32({ open: true, readExitCode: false });
  assertEquals(windowsProcessGone(10, fake.kernel32, noFallback), false);
  assertEquals(fake.closed(), 1);
});

Deno.test("windowsProcessGone: a process it cannot open is judged by the fallback", () => {
  const fake = fakeKernel32({ open: false });
  for (const answer of [true, false]) {
    const asked: number[] = [];
    const fallback = (pid: number) => {
      asked.push(pid);
      return answer;
    };
    assertEquals(windowsProcessGone(10, fake.kernel32, fallback), answer);
    assertEquals(asked, [10]);
  }
  assertEquals(fake.closed(), 0);
});

Deno.test("windowsProcessGone: without kernel32 every pid is judged by the fallback", () => {
  const asked: number[] = [];
  const fallback = (pid: number) => {
    asked.push(pid);
    return true;
  };
  assertEquals(windowsProcessGone(10, null, fallback), true);
  assertEquals(asked, [10]);
});

Deno.test("isProcessGone: false for a live process, true for a pid no process can hold", () => {
  assertEquals(isProcessGone(Deno.pid), false);
  assertEquals(isProcessGone(Deno.ppid), false);
  assertEquals(isProcessGone(2147483647), true);
});

Deno.test("isProcessGone: false for a live process of another user", () => {
  if (Deno.build.os === "windows") return;
  assertEquals(isProcessGone(1), false);
});

Deno.test("processHostIdentity: is the hostname, plus the pid namespace on Linux", () => {
  const identity = processHostIdentity();
  if (Deno.build.os === "linux") {
    assertStringIncludes(identity, `${hostname()}#pid:[`);
  } else {
    assertEquals(identity, hostname());
  }
  assertEquals(processHostIdentity(), identity, "stable within a process");
});

Deno.test("getOpenFileSoftLimit: returns a positive number or null on POSIX", () => {
  if (Deno.build.os === "windows") return;
  const limit = getOpenFileSoftLimit();
  if (limit === null) return;
  assertEquals(typeof limit, "number");
  assertEquals(limit > 0, true);
});

Deno.test("checkOpenFileLimit: returns null when limit is sufficient", () => {
  if (Deno.build.os === "windows") return;
  const limit = getOpenFileSoftLimit();
  if (limit === null || limit < 8192) return;
  assertEquals(checkOpenFileLimit(), null);
});

Deno.test("tryRaiseOpenFileLimit: returns without throwing", () => {
  const result = tryRaiseOpenFileLimit();
  assertEquals(typeof result.raised, "boolean");
  if (!result.raised) {
    assertEquals(typeof result.reason, "string");
  }
});

Deno.test("tryRaiseOpenFileLimit: is idempotent", () => {
  const first = tryRaiseOpenFileLimit();
  const second = tryRaiseOpenFileLimit();
  if (first.raised) {
    assertEquals(second.raised, false);
    assertEquals(
      (second as { raised: false; reason: string }).reason,
      "already sufficient",
    );
  }
});

Deno.test("tryRaiseOpenFileLimit: returns raised=false on Windows", () => {
  if (Deno.build.os !== "windows") return;
  const result = tryRaiseOpenFileLimit();
  assertEquals(result.raised, false);
  assertEquals(
    (result as { raised: false; reason: string }).reason,
    "windows",
  );
});
