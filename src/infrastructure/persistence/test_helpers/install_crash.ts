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

import {
  defaultInstallFsOps,
  type InstallFsOps,
} from "../extension_install_transaction.ts";

/**
 * Thrown by a test's ops step to model the process dying at that step.
 * Ops built with {@link crashAware} report it through
 * `InstallFsOps.isSimulatedCrash`, so the transaction neither undoes nor
 * settles and the journal is left as a real crash would leave it.
 */
export class SimulatedInstallCrash extends Error {
  constructor(step: string) {
    super(`simulated crash at ${step}`);
    this.name = "SimulatedInstallCrash";
  }
}

/** `ops` (the real filesystem by default) that recognise simulated crashes. */
export function crashAware(
  ops: Partial<InstallFsOps> = {},
): InstallFsOps {
  return {
    ...defaultInstallFsOps,
    ...ops,
    isSimulatedCrash: (error) => error instanceof SimulatedInstallCrash,
  };
}
