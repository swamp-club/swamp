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

export function formatTtlMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes === 0) return `${hours}h`;
  return `${hours}h${remainingMinutes}m`;
}

export interface RefreshHookData {
  command: string;
  ttlMs: number;
  ttl: string;
  lastRefreshedAt: string | null;
}

export class RefreshHook {
  readonly command: string;
  readonly ttlMs: number;
  readonly lastRefreshedAt: Date | null;

  private constructor(
    command: string,
    ttlMs: number,
    lastRefreshedAt: Date | null,
  ) {
    this.command = command;
    this.ttlMs = ttlMs;
    this.lastRefreshedAt = lastRefreshedAt;
  }

  static create(command: string, ttlMs: number): RefreshHook {
    return new RefreshHook(command, ttlMs, null);
  }

  static fromData(data: RefreshHookData): RefreshHook {
    return new RefreshHook(
      data.command,
      data.ttlMs,
      data.lastRefreshedAt ? new Date(data.lastRefreshedAt) : null,
    );
  }

  toData(): RefreshHookData {
    return {
      command: this.command,
      ttlMs: this.ttlMs,
      ttl: formatTtlMs(this.ttlMs),
      lastRefreshedAt: this.lastRefreshedAt?.toISOString() ?? null,
    };
  }

  isStale(now: number = Date.now()): boolean {
    if (this.lastRefreshedAt === null) return true;
    return (now - this.lastRefreshedAt.getTime()) >= this.ttlMs;
  }

  withRefreshedAt(timestamp: Date): RefreshHook {
    return new RefreshHook(this.command, this.ttlMs, timestamp);
  }

  equals(other: RefreshHook): boolean {
    return this.command === other.command &&
      this.ttlMs === other.ttlMs &&
      this.lastRefreshedAt?.getTime() === other.lastRefreshedAt?.getTime();
  }
}

export interface VaultRefreshHookProvider {
  getRefreshHook(secretKey: string): Promise<RefreshHook | null>;
  putRefreshHook(secretKey: string, hook: RefreshHook): Promise<void>;
  deleteRefreshHook(secretKey: string): Promise<void>;
}

export function isVaultRefreshHookProvider(
  provider: unknown,
): provider is VaultRefreshHookProvider {
  if (typeof provider !== "object" || provider === null) return false;
  const obj = provider as Record<string, unknown>;
  return typeof obj.getRefreshHook === "function" &&
    typeof obj.putRefreshHook === "function" &&
    typeof obj.deleteRefreshHook === "function";
}
