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

import type { AppliedSettingKey } from "./serve_settings_reload.ts";
import type { ReloadFollowUp } from "./serve_settings_reloader.ts";

export interface TimedServiceSlot<S> {
  readonly name: string;
  readonly settings: readonly AppliedSettingKey[];
  get(): S | null;
  set(service: S | null): void;
  /** throws while serve is still starting, so the setting is retried */
  build(): S | Promise<S>;
  /** starts it, under the leader rules startup applies to this service */
  start(service: S): void;
  stop(service: S): Promise<void>;
  /** true once shutdown has begun: nothing starts after it */
  closed(): boolean;
}

export function timedServiceFollowUp<S>(
  slot: TimedServiceSlot<S>,
  wanted: boolean,
): ReloadFollowUp | undefined {
  const running = slot.get();
  if (wanted && running === null) {
    return {
      name: `Starting ${slot.name}`,
      settings: slot.settings,
      run: async () => {
        if (slot.closed() || slot.get() !== null) return;
        const service = await slot.build();
        if (slot.closed() || slot.get() !== null) {
          await slot.stop(service);
          return;
        }
        slot.set(service);
        slot.start(service);
      },
    };
  }
  if (!wanted && running !== null) {
    return {
      name: `Stopping ${slot.name}`,
      settings: slot.settings,
      // cleared once stopped, so shutdown still waits on a stop in flight
      run: async () => {
        await slot.stop(running);
        if (slot.get() === running) slot.set(null);
      },
    };
  }
  return undefined;
}
