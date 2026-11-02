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

export class CalVer {
  private static readonly PATTERN = /^\d{4}\.\d{2}\.\d{2}\.\d+$/;

  private constructor(readonly value: string) {}

  static create(version: string): CalVer {
    if (!CalVer.isValid(version)) {
      throw new Error(
        `Invalid CalVer version: "${version}". Expected format YYYY.MM.DD.MICRO (e.g., "2025.01.15.1")`,
      );
    }
    return new CalVer(version);
  }

  static isValid(version: string): boolean {
    if (!CalVer.PATTERN.test(version)) return false;
    const parts = version.split(".");
    const year = Number(parts[0]);
    const month = Number(parts[1]);
    const day = Number(parts[2]);
    if (month < 1 || month > 12 || day < 1) return false;
    const daysInMonth = new Date(year, month, 0).getDate();
    return day <= daysInMonth;
  }

  static compare(a: CalVer, b: CalVer): -1 | 0 | 1 {
    const aParts = a.value.split(".");
    const bParts = b.value.split(".");

    for (let i = 0; i < 3; i++) {
      if (aParts[i] < bParts[i]) return -1;
      if (aParts[i] > bParts[i]) return 1;
    }

    const aMicro = Number(aParts[3]);
    const bMicro = Number(bParts[3]);
    if (aMicro < bMicro) return -1;
    if (aMicro > bMicro) return 1;

    return 0;
  }

  toString(): string {
    return this.value;
  }

  static bump(previous?: CalVer): CalVer {
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const todayPrefix = `${yyyy}.${mm}.${dd}`;

    let micro = 1;
    if (previous) {
      const parts = previous.value.split(".");
      const prevPrefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
      if (prevPrefix === todayPrefix) {
        micro = Number(parts[3]) + 1;
      }
    }

    return new CalVer(`${todayPrefix}.${micro}`);
  }

  /**
   * for CI pipelines: each push gets a unique, monotonically increasing version
   * without prompts
   */
  static withEpochMicro(): CalVer {
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const epochSeconds = Math.floor(now.getTime() / 1000);
    return new CalVer(`${yyyy}.${mm}.${dd}.${epochSeconds}`);
  }

  static daysBehind(installed: CalVer, latest: CalVer): number {
    const iParts = installed.value.split(".");
    const lParts = latest.value.split(".");
    const iMs = Date.UTC(
      Number(iParts[0]),
      Number(iParts[1]) - 1,
      Number(iParts[2]),
    );
    const lMs = Date.UTC(
      Number(lParts[0]),
      Number(lParts[1]) - 1,
      Number(lParts[2]),
    );
    const diffMs = lMs - iMs;
    if (diffMs <= 0) return 0;
    return Math.floor(diffMs / (24 * 60 * 60 * 1000));
  }

  equals(other: CalVer): boolean {
    return this.value === other.value;
  }
}
