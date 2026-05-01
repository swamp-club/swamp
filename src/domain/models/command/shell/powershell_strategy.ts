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
 * `powershell.exe -NoProfile -Command <cmd>` shell strategy.
 *
 * Selected on native Windows hosts. Uses Windows PowerShell 5.1, which
 * ships with every Windows install since Windows 8 — no extra
 * dependency required, unlike PowerShell 7 (`pwsh.exe`).
 *
 * `-NoProfile` skips loading `$PROFILE` so the invocation is
 * deterministic regardless of the user's PowerShell config. `-Command`
 * accepts the command string as a single argument.
 *
 * Users running POSIX scripts on Windows should run swamp under WSL2.
 * Inside WSL the host OS is `linux` and `PosixShellStrategy` is
 * selected automatically.
 */
export class PowerShellStrategy implements ShellStrategy {
  buildInvocation(command: string): { command: string; args: string[] } {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-Command", command],
    };
  }

  resolveSecrets(
    command: string,
    secretBag: VaultSecretBag,
  ): { command: string; env: Record<string, string> } {
    return secretBag.resolveForPowerShell(command);
  }
}
