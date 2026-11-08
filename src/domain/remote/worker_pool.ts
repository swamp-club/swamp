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

export type PoolWorkerStatus =
  | "idle"
  | "busy"
  | "unverified"
  | "draining"
  | "disconnected";

export interface PoolWorker {
  readonly name: string;
  readonly instanceUuid: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly platform: string;
  readonly arch: string;
  // a worker that left the pool reads disconnected unless it was unverified or draining
  readonly status: PoolWorkerStatus;
  readonly connected: boolean;
}

// unique names; a worker whose token expired, was revoked, re-minted or deleted is absent
export interface WorkerPoolReader {
  readPool(): Promise<PoolWorker[]>;
  /** serve's default wait for a worker, in ms; 0 waits without end */
  readonly queueTimeoutMs?: number;
}

// module-level so a nested run, which gets a fresh execution service, still reaches serve's pool
let activeReader: WorkerPoolReader | null = null;

export function setWorkerPoolReader(reader: WorkerPoolReader | null): void {
  activeReader = reader;
}

export function getWorkerPoolReader(): WorkerPoolReader | null {
  return activeReader;
}
