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

export interface UpdateCheckCacheData {
  latestVersion: string;
  checkedAt: string;
}

export interface UpdateCheckCacheRepository {
  read(): Promise<UpdateCheckCacheData | null>;
  write(data: UpdateCheckCacheData): Promise<void>;
}

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function isCacheStale(
  cache: UpdateCheckCacheData | null,
  now: Date,
): boolean {
  if (!cache) return true;

  const checkedAt = new Date(cache.checkedAt);
  if (isNaN(checkedAt.getTime())) return true;

  return now.getTime() - checkedAt.getTime() >= CHECK_INTERVAL_MS;
}
