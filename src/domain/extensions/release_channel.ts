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

const CHANNEL_ORDER = { beta: 0, rc: 1, stable: 2 } as const;

export type ReleaseChannelName = keyof typeof CHANNEL_ORDER;

const VALID_NAMES = new Set<string>(Object.keys(CHANNEL_ORDER));

export class ReleaseChannel {
  static readonly BETA = new ReleaseChannel("beta");
  static readonly RC = new ReleaseChannel("rc");
  static readonly STABLE = new ReleaseChannel("stable");

  private constructor(readonly name: ReleaseChannelName) {}

  static create(name: string): ReleaseChannel {
    if (!VALID_NAMES.has(name)) {
      throw new Error(
        `Invalid release channel: "${name}". Must be one of: beta, rc, stable`,
      );
    }
    return new ReleaseChannel(name as ReleaseChannelName);
  }

  static isValid(name: string): boolean {
    return VALID_NAMES.has(name);
  }

  static isPrereleaseName(name: string): boolean {
    return name === "beta" || name === "rc";
  }

  private get order(): number {
    return CHANNEL_ORDER[this.name];
  }

  isPrerelease(): boolean {
    return this.name !== "stable";
  }

  canPromoteTo(target: ReleaseChannel): boolean {
    return target.order > this.order;
  }

  equals(other: ReleaseChannel): boolean {
    return this.name === other.name;
  }

  toString(): string {
    return this.name;
  }
}
