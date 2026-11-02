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

import type { SecretOriginLookup } from "../../../vaults/secret_occurrences.ts";
import type {
  ShellPlacementPlan,
  ShellSecretResolution,
  VaultSecretBag,
} from "../../../vaults/vault_secret_bag.ts";
import { PosixShellStrategy } from "./posix_shell_strategy.ts";
import { PowerShellStrategy } from "./powershell_strategy.ts";

/**
 * host-OS driven: POSIX (Linux, macOS, WSL) uses sh -c, native Windows uses
 * PowerShell; each owns its wrapper args and secret resolution; POSIX scripts
 * on Windows should run under WSL2
 */
export interface ShellStrategy {
  /**
   * Whether the shell ends every output line with CRLF, so captured output
   * is normalised to LF to read the same as POSIX output. A shell whose
   * lines end in LF leaves any CR a command writes as part of its output.
   */
  readonly normalizesCrlfOutput: boolean;

  buildInvocation(command: string): {
    command: string;
    args: string[];
  };

  /**
   * plans where each sentinel is placed from references alone: the expanding
   * env reference, a literal reference in single quotes, or a refusal; reads no
   * value, so a destination policy can run it before the load
   */
  planSecrets(
    command: string,
    authoredEnvKeys: Iterable<string>,
    originOf: SecretOriginLookup,
  ): ShellPlacementPlan;

  resolveSecrets(
    command: string,
    secretBag: VaultSecretBag,
    authoredEnvKeys?: Iterable<string>,
  ): ShellSecretResolution;
}

export function selectShellStrategy(): ShellStrategy {
  if (Deno.build.os === "windows") {
    return new PowerShellStrategy();
  }
  return new PosixShellStrategy();
}
