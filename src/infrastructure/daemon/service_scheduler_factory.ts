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

import type { ServiceScheduler } from "../../domain/serve/service_scheduler.ts";
import type { LaunchdMode } from "../update/launchd_scheduler.ts";
import { UserError } from "../../domain/errors.ts";
import { detectBinaryOwnership } from "../update/scheduler_factory.ts";
import { LaunchdServiceScheduler } from "./launchd_service_scheduler.ts";
import { SystemdServiceScheduler } from "./systemd_service_scheduler.ts";
import { hasSystemctl } from "./has_systemctl.ts";

export async function resolveServiceMode(
  options?: { user?: boolean },
): Promise<LaunchdMode> {
  if (options?.user) {
    return "agent";
  }

  let currentUid: number | null = null;
  let binaryUid: number | null = null;
  try {
    currentUid = Deno.uid();
    const stat = await Deno.stat(Deno.execPath());
    binaryUid = stat.uid;
  } catch {
    return "agent";
  }

  const result = detectBinaryOwnership(binaryUid, currentUid);
  if (result === "foreign") {
    throw new UserError(
      `The swamp binary at ${Deno.execPath()} is owned by uid ${binaryUid}, ` +
        `not the current user or root.\n` +
        `Fix the installation so the binary is owned by your user or root:\n\n` +
        `  Option 1: sudo chown $(whoami) ${Deno.execPath()}\n` +
        `  Option 2: sudo chown root ${Deno.execPath()}`,
    );
  }
  return result;
}

export interface ServiceSchedulerOptions {
  mode?: LaunchdMode;
}

export async function createServiceScheduler(
  options?: ServiceSchedulerOptions,
): Promise<ServiceScheduler> {
  const mode = options?.mode ?? "agent";
  switch (Deno.build.os) {
    case "darwin":
      return new LaunchdServiceScheduler(mode);
    case "linux":
      if (await hasSystemctl()) {
        return new SystemdServiceScheduler(mode);
      }
      throw new UserError(
        "swamp serve daemon currently requires systemd on Linux, but systemctl was not found.\n" +
          "If you need support for your init system, please file a feature request:\n\n" +
          "  swamp issue feature",
      );
    default:
      throw new UserError(
        `swamp serve daemon is not yet supported on ${Deno.build.os}`,
      );
  }
}
