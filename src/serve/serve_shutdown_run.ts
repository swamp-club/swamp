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

export interface ServeShutdownRunDeps {
  readonly body: () => Promise<void>;
  /** best effort: what it throws is dropped, and the exit still follows */
  readonly onEscaped: (error: unknown) => void;
  readonly exit: (code: number) => void;
}

/**
 * every trigger shares one run of serve's shutdown, which ends by completing or
 * by exiting the process: an error that escapes it never leaves serve waiting
 * on a listener nothing will close, nor returns into the CLI's teardown
 */
export class ServeShutdownRun {
  readonly #body: () => Promise<void>;
  readonly #onEscaped: (error: unknown) => void;
  readonly #exit: (code: number) => void;
  #run: Promise<void> | undefined;

  constructor(deps: ServeShutdownRunDeps) {
    this.#body = deps.body;
    this.#onEscaped = deps.onEscaped;
    this.#exit = deps.exit;
  }

  start(): Promise<void> {
    return this.#run ??= this.#runOnce();
  }

  /** the run once a trigger started it */
  get started(): Promise<void> | undefined {
    return this.#run;
  }

  async #runOnce(): Promise<void> {
    try {
      // called in the triggering turn: the body's preamble before its first
      // await must run before the trigger returns
      await this.#body();
    } catch (error) {
      try {
        this.#onEscaped(error);
      } catch {
        // the exit below matters more than the report
      }
      // crash-style: either CLI teardown would compact while runs or
      // background passes may still write; recovery handles a killed serve
      this.#exit(1);
      throw error;
    }
  }
}
