// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import type { VaultSecretBag } from "../../../vaults/vault_secret_bag.ts";
import type { ShellStrategy } from "./shell_strategy.ts";

/**
 * POSIX `sh -c` shell strategy.
 *
 * Used on Linux, macOS, and WSL — the host OS is `linux` or `darwin`
 * inside any of those. Secret resolution delegates to the existing
 * `VaultSecretBag.resolveForShell()`, which emits POSIX `${VAR}`
 * references with quoting-context-aware double quoting.
 */
export class PosixShellStrategy implements ShellStrategy {
  buildInvocation(command: string): { command: string; args: string[] } {
    return { command: "sh", args: ["-c", command] };
  }

  resolveSecrets(
    command: string,
    secretBag: VaultSecretBag,
  ): { command: string; env: Record<string, string> } {
    return secretBag.resolveForShell(command);
  }
}
