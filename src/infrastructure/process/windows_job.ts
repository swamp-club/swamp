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

const logger = getLogger(["process", "job"]);

/**
 * A Windows Job Object holding a spawned command and every process it
 * starts. The job ends them all when its last handle closes, so a swamp
 * process that is killed outright — and Windows has no signal another
 * process can catch, so every stop from outside is outright — takes the
 * commands it was running with it (swamp-club#3241).
 */
export interface ProcessJob {
  /** Ends every process in the job, then closes it. */
  terminate(): void;
  /** Closes the job and leaves its processes running: a command that
   *  exited on its own keeps what it deliberately started. */
  release(): void;
}

/** The kernel32 functions a job needs. Handles are opaque pointers. */
export interface Kernel32Jobs {
  CreateJobObjectW(attributes: null, name: null): Deno.PointerValue;
  SetInformationJobObject(
    job: Deno.PointerValue,
    infoClass: number,
    info: BufferSource,
    length: number,
  ): number;
  OpenProcess(access: number, inherit: number, pid: number): Deno.PointerValue;
  AssignProcessToJobObject(
    job: Deno.PointerValue,
    process: Deno.PointerValue,
  ): number;
  TerminateJobObject(job: Deno.PointerValue, exitCode: number): number;
  CloseHandle(handle: Deno.PointerValue): number;
}

const KERNEL32_SYMBOLS = {
  CreateJobObjectW: { parameters: ["pointer", "pointer"], result: "pointer" },
  SetInformationJobObject: {
    parameters: ["pointer", "i32", "buffer", "u32"],
    result: "i32",
  },
  OpenProcess: { parameters: ["u32", "i32", "u32"], result: "pointer" },
  AssignProcessToJobObject: {
    parameters: ["pointer", "pointer"],
    result: "i32",
  },
  TerminateJobObject: { parameters: ["pointer", "u32"], result: "i32" },
  CloseHandle: { parameters: ["pointer"], result: "i32" },
} as const;

/** `JobObjectExtendedLimitInformation`. */
export const EXTENDED_LIMIT_INFORMATION_CLASS = 9;
/** `sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)` on 64-bit Windows. */
export const EXTENDED_LIMIT_INFORMATION_SIZE = 144;
/** Offset of `BasicLimitInformation.LimitFlags` in that struct. */
export const LIMIT_FLAGS_OFFSET = 16;
export const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
/** Lets a process that asks for `CREATE_BREAKAWAY_FROM_JOB` leave the job,
 *  as some installers and service launchers do; without it their spawn
 *  fails with access denied. */
export const JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x0800;
/** The limits a step's job starts with. */
export const STEP_JOB_LIMITS = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
  JOB_OBJECT_LIMIT_BREAKAWAY_OK;
/** `PROCESS_SET_QUOTA | PROCESS_TERMINATE`, what assigning a job needs. */
export const JOB_ASSIGN_ACCESS = 0x0100 | 0x0001;

/** A `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` with only `LimitFlags` set. */
export function extendedLimitInformation(
  limitFlags: number,
): Uint8Array<ArrayBuffer> {
  const info = new Uint8Array(EXTENDED_LIMIT_INFORMATION_SIZE);
  new DataView(info.buffer).setUint32(LIMIT_FLAGS_OFFSET, limitFlags, true);
  return info;
}

function setLimitFlags(
  kernel32: Kernel32Jobs,
  job: Deno.PointerValue,
  limitFlags: number,
): boolean {
  const info = extendedLimitInformation(limitFlags);
  return kernel32.SetInformationJobObject(
    job,
    EXTENDED_LIMIT_INFORMATION_CLASS,
    info,
    info.byteLength,
  ) !== 0;
}

/**
 * Puts `pid` in a new kill-on-close job. Returns undefined, holding no
 * handle, when any step fails: the command then runs without a job, as it
 * did before. The job handle is not inheritable, so no child keeps the job
 * open after swamp is gone.
 */
export function createProcessJob(
  kernel32: Kernel32Jobs,
  pid: number,
): ProcessJob | undefined {
  const job = kernel32.CreateJobObjectW(null, null);
  if (job === null) return undefined;
  let assigned = false;
  try {
    if (setLimitFlags(kernel32, job, STEP_JOB_LIMITS)) {
      const process = kernel32.OpenProcess(JOB_ASSIGN_ACCESS, 0, pid);
      if (process !== null) {
        try {
          assigned = kernel32.AssignProcessToJobObject(job, process) !== 0;
        } finally {
          kernel32.CloseHandle(process);
        }
      }
    }
  } finally {
    if (!assigned) kernel32.CloseHandle(job);
  }
  if (!assigned) return undefined;

  let closed = false;
  return {
    terminate: () => {
      if (closed) return;
      closed = true;
      kernel32.TerminateJobObject(job, 1);
      kernel32.CloseHandle(job);
    },
    release: () => {
      if (closed) return;
      closed = true;
      // Closing a job that still kills on close would end what the command
      // left running. If the flag cannot be cleared, the handle stays open
      // until swamp exits instead.
      if (setLimitFlags(kernel32, job, 0)) kernel32.CloseHandle(job);
    },
  };
}

let kernel32Jobs: Kernel32Jobs | null | undefined;

function loadKernel32(): Kernel32Jobs | null {
  if (kernel32Jobs === undefined) {
    try {
      kernel32Jobs = Deno.dlopen("kernel32.dll", KERNEL32_SYMBOLS).symbols;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger
        .debug`Job Objects unavailable (${reason}); commands run without one`;
      kernel32Jobs = null;
    }
  }
  return kernel32Jobs;
}

/**
 * Puts a spawned command in a kill-on-close job on Windows. Returns
 * undefined elsewhere, where process groups do this job, and wherever a job
 * cannot be made.
 */
export function attachProcessJob(
  pid: number,
  os: typeof Deno.build.os = Deno.build.os,
  load: () => Kernel32Jobs | null = loadKernel32,
): ProcessJob | undefined {
  if (os !== "windows") return undefined;
  const kernel32 = load();
  if (kernel32 === null) return undefined;
  try {
    return createProcessJob(kernel32, pid);
  } catch {
    return undefined;
  }
}
