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

/** -k stops the running instance (SIGTERM, then SIGKILL after ExitTimeOut). */
export function launchdKickstartArgs(domain: string, label: string): string[] {
  return ["kickstart", "-k", `${domain}/${label}`];
}

/** Set for the default and for any explicit --cache-dir since the first daemon release. */
export function systemdUnitHasWorkerCacheDir(unit: string): boolean {
  return /^Environment="SWAMP_WORKER_CACHE_DIR=/m.test(unit);
}

export function plistHasWorkerCacheDir(plist: string): boolean {
  return /<key>SWAMP_WORKER_CACHE_DIR<\/key>/.test(plist);
}

export const WORKER_DAEMON_NEEDS_REENABLE =
  "enabled without a stable cache dir, so a restart would come back as a new machine that its token refuses; left running. Re-run `swamp worker daemon enable` with a new worker token to restart it on updates";
