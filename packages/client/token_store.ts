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

import type { DelegatedTokenSet } from "./integration_client.ts";

/**
 * where an app keeps each person's tokens. Refresh tokens don't rotate, so a
 * plain load and save is enough even when several copies of an app share it.
 */
export interface TokenStore {
  load(delegationId: string): Promise<DelegatedTokenSet | null>;
  save(delegationId: string, tokens: DelegatedTokenSet): Promise<void>;
}

/** keeps tokens in this process only; they are gone when it exits */
export function memoryTokenStore(): TokenStore {
  const tokens = new Map<string, DelegatedTokenSet>();
  return {
    load: (id) => Promise.resolve(tokens.get(id) ?? null),
    save: (id, set) => {
      tokens.set(id, { ...set });
      return Promise.resolve();
    },
  };
}
