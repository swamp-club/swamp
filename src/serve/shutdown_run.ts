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

/**
 * one shutdown per process, shared by every trigger; a run that fails partway
 * hands its error to onFailed so the caller can still let the process go
 */
export class ShutdownRun {
  readonly #shutdown: () => Promise<void>;
  readonly #onFailed: (error: unknown) => void;
  #run: Promise<void> | undefined;

  constructor(
    shutdown: () => Promise<void>,
    onFailed: (error: unknown) => void,
  ) {
    this.#shutdown = shutdown;
    this.#onFailed = onFailed;
  }

  start(): Promise<void> {
    // shutdown's first steps run in the trigger's own turn, as a direct call would
    this.#run ??= new Promise<void>((resolve) => resolve(this.#shutdown()))
      .catch((error) => {
        this.#onFailed(error);
        throw error;
      });
    return this.#run;
  }

  /** rejects with a started run's failure; resolves if it succeeded or never started */
  async finished(): Promise<void> {
    await this.#run;
  }
}
