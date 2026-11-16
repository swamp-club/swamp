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

/** the first message every Worker script started here posts */
export const LOADED = { kind: "loaded" } as const;

export interface LoadedWorkerOptions<T> {
  /** how long one start may take to post LOADED */
  readonly loadTimeoutMs: number;
  /** starts in all, each on a fresh Worker */
  readonly attempts: number;
  /** every message after LOADED */
  readonly onMessage?: (message: T) => void;
  /** a Worker error after LOADED; one before it fails the start */
  readonly onError?: (event: ErrorEvent) => void;
}

function isLoaded(data: unknown): boolean {
  return typeof data === "object" && data !== null &&
    (data as { kind?: unknown }).kind === LOADED.kind;
}

// Deno's process-wide npm resolution queue can lose a cross-thread wakeup;
// the stuck load holds it until its Worker is terminated, so a load that
// misses its bound is retried on a fresh Worker rather than waited out.
export async function startLoadedWorker<T>(
  url: string | URL,
  options: LoadedWorkerOptions<T>,
): Promise<Worker> {
  const href = new URL(url).href;
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    const worker = new Worker(href, { type: "module" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await new Promise<"loaded" | "timeout" | Error>(
      (resolve) => {
        let loaded = false;
        timer = setTimeout(() => resolve("timeout"), options.loadTimeoutMs);
        worker.onmessage = (event: MessageEvent<T>) => {
          if (!loaded && isLoaded(event.data)) {
            loaded = true;
            resolve("loaded");
            return;
          }
          options.onMessage?.(event.data);
        };
        worker.onerror = (event) => {
          if (loaded) {
            options.onError?.(event);
            return;
          }
          event.preventDefault();
          resolve(new Error(`${href} failed to load: ${event.message}`));
        };
      },
    );
    clearTimeout(timer);
    if (outcome === "loaded") return worker;
    worker.terminate();
    if (outcome instanceof Error) throw outcome;
  }
  throw new Error(
    `${href} did not load within ${options.loadTimeoutMs}ms in ${options.attempts} attempt(s)`,
  );
}
