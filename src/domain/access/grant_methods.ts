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

import { isVaultMethod, VAULT_METHODS } from "./access_resources.ts";
import type { ResourceSelector } from "./resource_selector.ts";

export interface GrantMethodFinding {
  readonly message: string;
}

export interface MethodScopedGrant {
  readonly resource: ResourceSelector;
  readonly methods?: readonly string[];
}

// a scoped allow matches only requests naming one of its methods, so a methods
// list on a kind whose requests name none, or a verb no vault request names,
// makes the allow match nothing
export function findGrantMethodIssues(
  grant: MethodScopedGrant,
): GrantMethodFinding[] {
  const methods = grant.methods ?? [];
  if (methods.length === 0) return [];
  const kind = grant.resource.kind;
  if (kind === "workflow" || kind === "data") {
    return [{
      message:
        `methods has no effect on a ${kind} grant: ${kind} requests name no method, so a methods-scoped allow matches nothing and a deny applies to every request; remove methods`,
    }];
  }
  if (kind !== "vault") return [];
  return methods.filter((method) => !isVaultMethod(method)).map((method) => ({
    message: `'${method}' is not a vault verb (one of ${
      VAULT_METHODS.join(", ")
    }), so no vault request matches it`,
  }));
}
