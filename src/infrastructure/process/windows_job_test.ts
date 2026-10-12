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

import { assert, assertEquals } from "@std/assert";
import {
  attachProcessJob,
  createProcessJob,
  EXTENDED_LIMIT_INFORMATION_CLASS,
  EXTENDED_LIMIT_INFORMATION_SIZE,
  extendedLimitInformation,
  JOB_ASSIGN_ACCESS,
  JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
  type Kernel32Jobs,
  LIMIT_FLAGS_OFFSET,
  STEP_JOB_LIMITS,
} from "./windows_job.ts";

/** Handles a fake kernel32 hands out, named so calls read clearly. */
const JOB = Deno.UnsafePointer.create(0x10n);
const PROCESS = Deno.UnsafePointer.create(0x20n);

function handleName(handle: Deno.PointerValue): string {
  if (handle === null) return "null";
  const address = Deno.UnsafePointer.value(handle);
  if (address === 0x10n) return "job";
  if (address === 0x20n) return "process";
  return String(address);
}

function limitFlagsOf(info: BufferSource): number {
  const bytes = ArrayBuffer.isView(info)
    ? new DataView(info.buffer, info.byteOffset, info.byteLength)
    : new DataView(info);
  return bytes.getUint32(LIMIT_FLAGS_OFFSET, true);
}

/** A fake kernel32 that records calls; `fail` names calls that fail. */
function fakeKernel32(fail: ReadonlySet<string> = new Set()) {
  const calls: string[] = [];
  let setCount = 0;
  const kernel32: Kernel32Jobs = {
    CreateJobObjectW: () => {
      calls.push("CreateJobObjectW");
      return fail.has("CreateJobObjectW") ? null : JOB;
    },
    SetInformationJobObject: (job, infoClass, info, length) => {
      setCount++;
      calls.push(
        `SetInformationJobObject ${
          handleName(job)
        } class=${infoClass} flags=0x${
          limitFlagsOf(info).toString(16)
        } length=${length}`,
      );
      const name = setCount === 1 ? "SetKillOnClose" : "ClearKillOnClose";
      return fail.has(name) ? 0 : 1;
    },
    OpenProcess: (access, inherit, pid) => {
      calls.push(
        `OpenProcess access=0x${access.toString(16)} ${inherit} ${pid}`,
      );
      return fail.has("OpenProcess") ? null : PROCESS;
    },
    AssignProcessToJobObject: (job, process) => {
      calls.push(
        `AssignProcessToJobObject ${handleName(job)} ${handleName(process)}`,
      );
      return fail.has("AssignProcessToJobObject") ? 0 : 1;
    },
    TerminateJobObject: (job, exitCode) => {
      calls.push(`TerminateJobObject ${handleName(job)} ${exitCode}`);
      return 1;
    },
    CloseHandle: (handle) => {
      calls.push(`CloseHandle ${handleName(handle)}`);
      return 1;
    },
  };
  return { kernel32, calls };
}

const CREATED = [
  "CreateJobObjectW",
  "SetInformationJobObject job class=9 flags=0x2800 length=144",
  "OpenProcess access=0x101 0 4242",
  "AssignProcessToJobObject job process",
  "CloseHandle process",
];

Deno.test("extendedLimitInformation: sets LimitFlags in a 64-bit JOBOBJECT_EXTENDED_LIMIT_INFORMATION", () => {
  const info = extendedLimitInformation(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE);

  assertEquals(info.byteLength, 144);
  assertEquals(EXTENDED_LIMIT_INFORMATION_SIZE, 144);
  assertEquals(EXTENDED_LIMIT_INFORMATION_CLASS, 9);
  assertEquals(JOB_ASSIGN_ACCESS, 0x0101);
  assertEquals(limitFlagsOf(info), 0x2000);
  assertEquals(STEP_JOB_LIMITS, 0x2800, "kill on close, breakaway allowed");
  assertEquals(
    [...info].filter((byte) => byte !== 0).length,
    1,
    "only LimitFlags is set",
  );
});

Deno.test("createProcessJob: puts the pid in a kill-on-close job", () => {
  const { kernel32, calls } = fakeKernel32();

  assert(createProcessJob(kernel32, 4242));

  assertEquals(calls, CREATED);
});

Deno.test("createProcessJob: terminate ends the job's processes, then closes it once", () => {
  const { kernel32, calls } = fakeKernel32();
  const job = createProcessJob(kernel32, 4242)!;

  job.terminate();
  job.terminate();
  job.release();

  assertEquals(calls.slice(CREATED.length), [
    "TerminateJobObject job 1",
    "CloseHandle job",
  ]);
});

Deno.test("createProcessJob: release clears kill-on-close before closing, so nothing is ended", () => {
  const { kernel32, calls } = fakeKernel32();
  const job = createProcessJob(kernel32, 4242)!;

  job.release();
  job.terminate();

  assertEquals(calls.slice(CREATED.length), [
    "SetInformationJobObject job class=9 flags=0x0 length=144",
    "CloseHandle job",
  ]);
});

Deno.test("createProcessJob: release keeps the job open when kill-on-close cannot be cleared", () => {
  const { kernel32, calls } = fakeKernel32(new Set(["ClearKillOnClose"]));
  const job = createProcessJob(kernel32, 4242)!;

  job.release();

  assertEquals(calls.slice(CREATED.length), [
    "SetInformationJobObject job class=9 flags=0x0 length=144",
  ]);
});

Deno.test("createProcessJob: holds no handle when a step fails", () => {
  const cases: [string, string[]][] = [
    ["CreateJobObjectW", ["CreateJobObjectW"]],
    ["SetKillOnClose", [
      "CreateJobObjectW",
      "SetInformationJobObject job class=9 flags=0x2800 length=144",
      "CloseHandle job",
    ]],
    ["OpenProcess", [
      "CreateJobObjectW",
      "SetInformationJobObject job class=9 flags=0x2800 length=144",
      "OpenProcess access=0x101 0 4242",
      "CloseHandle job",
    ]],
    ["AssignProcessToJobObject", [...CREATED, "CloseHandle job"]],
  ];
  for (const [failing, expected] of cases) {
    const { kernel32, calls } = fakeKernel32(new Set([failing]));

    assertEquals(createProcessJob(kernel32, 4242), undefined, failing);

    assertEquals(calls, expected, failing);
  }
});

Deno.test("attachProcessJob: makes no job outside Windows", () => {
  let loaded = false;
  for (const os of ["darwin", "linux"] as const) {
    assertEquals(
      attachProcessJob(4242, os, () => {
        loaded = true;
        return fakeKernel32().kernel32;
      }),
      undefined,
    );
  }
  assertEquals(loaded, false);
});

Deno.test("attachProcessJob: makes a job on Windows", () => {
  const { kernel32, calls } = fakeKernel32();

  assert(attachProcessJob(4242, "windows", () => kernel32));

  assertEquals(calls, CREATED);
});

Deno.test("attachProcessJob: runs without a job when kernel32 cannot be loaded or throws", () => {
  assertEquals(attachProcessJob(4242, "windows", () => null), undefined);

  const { kernel32 } = fakeKernel32();
  const throwing: Kernel32Jobs = {
    ...kernel32,
    CreateJobObjectW: () => {
      throw new Error("ffi failure");
    },
  };
  assertEquals(attachProcessJob(4242, "windows", () => throwing), undefined);
});
