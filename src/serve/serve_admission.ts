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

export type AdmissionPhase = "starting" | "open" | "draining";

export interface AdmissionRefusal {
  readonly code: "not_ready" | "draining";
  readonly message: string;
  readonly retryAfterSeconds: number;
}

export const NOT_READY_RETRY_AFTER_SECONDS = 2;
export const DRAINING_RETRY_AFTER_SECONDS = 5;

const NOT_READY: AdmissionRefusal = {
  code: "not_ready",
  message: "Serve is still starting; try again shortly",
  retryAfterSeconds: NOT_READY_RETRY_AFTER_SECONDS,
};

const DRAINING: AdmissionRefusal = {
  code: "draining",
  message: "Serve is shutting down; try again once it is back",
  retryAfterSeconds: DRAINING_RETRY_AFTER_SECONDS,
};

export class ServeAdmission {
  #phase: AdmissionPhase = "starting";

  get phase(): AdmissionPhase {
    return this.#phase;
  }

  // a node that began draining before startup finished never opens
  open(): void {
    if (this.#phase === "starting") this.#phase = "open";
  }

  beginDraining(): void {
    this.#phase = "draining";
  }

  refusal(): AdmissionRefusal | undefined {
    if (this.#phase === "open") return undefined;
    return this.#phase === "starting" ? NOT_READY : DRAINING;
  }
}
