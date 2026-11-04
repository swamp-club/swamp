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

import { assertEquals } from "@std/assert";
import { APP_THEME_TOKENS, readAppTheme, watchAppTheme } from "./theme.ts";

interface FakeDom {
  theme: string | null;
  prefersDark: boolean;
  /** Fires the attribute observer, as a theme toggle would. */
  toggle(theme: string): void;
  /** Fires the media listener, as a system preference change would. */
  systemChange(dark: boolean): void;
  readonly listeners: Set<() => void>;
  readonly observers: Set<() => void>;
}

// Deno has no DOM; each test file runs in its own worker, so these globals stay here
async function withFakeDom(
  initial: { theme: string | null; prefersDark: boolean },
  body: (dom: FakeDom) => void | Promise<void>,
): Promise<void> {
  const listeners = new Set<() => void>();
  const observers = new Set<() => void>();
  const dom: FakeDom = {
    ...initial,
    listeners,
    observers,
    toggle(theme) {
      dom.theme = theme;
      for (const notify of observers) notify();
    },
    systemChange(dark) {
      dom.prefersDark = dark;
      for (const notify of listeners) notify();
    },
  };
  const globals: Record<string, unknown> = {
    document: {
      documentElement: { getAttribute: () => dom.theme },
    },
    getComputedStyle: () => ({
      getPropertyValue: (name: string) => ` value-of${name} `,
    }),
    matchMedia: () => ({
      get matches() {
        return dom.prefersDark;
      },
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    }),
    MutationObserver: class {
      #notify: () => void;
      constructor(notify: () => void) {
        this.#notify = notify;
      }
      observe() {
        observers.add(this.#notify);
      }
      disconnect() {
        observers.delete(this.#notify);
      }
    },
  };
  const saved = Object.keys(globals).map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
  );
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  try {
    await body(dom);
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) {
        delete (globalThis as Record<string, unknown>)[key];
      } else Object.defineProperty(globalThis, key, descriptor);
    }
  }
}

Deno.test("readAppTheme: sends every token, trimmed, under its own name", async () => {
  await withFakeDom({ theme: "light", prefersDark: false }, () => {
    const { tokens } = readAppTheme();
    assertEquals(Object.keys(tokens), [...APP_THEME_TOKENS]);
    assertEquals(tokens["accent"], "value-of--accent");
  });
});

Deno.test("readAppTheme: a chosen theme wins over the system preference", async () => {
  await withFakeDom({ theme: "light", prefersDark: true }, () => {
    assertEquals(readAppTheme().mode, "light");
  });
  await withFakeDom({ theme: "dark", prefersDark: false }, () => {
    assertEquals(readAppTheme().mode, "dark");
  });
});

Deno.test("readAppTheme: with no choice, follows the system preference", async () => {
  await withFakeDom({ theme: null, prefersDark: true }, () => {
    assertEquals(readAppTheme().mode, "dark");
  });
  await withFakeDom({ theme: null, prefersDark: false }, () => {
    assertEquals(readAppTheme().mode, "light");
  });
});

Deno.test("watchAppTheme: reports the toggle and the system, until stopped", async () => {
  await withFakeDom({ theme: null, prefersDark: false }, (dom) => {
    const modes: string[] = [];
    const stop = watchAppTheme((theme) => modes.push(theme.mode));
    dom.toggle("dark");
    dom.toggle("auto");
    dom.systemChange(true);
    assertEquals(modes, ["dark", "light", "dark"]);
    stop();
    assertEquals(dom.listeners.size, 0);
    assertEquals(dom.observers.size, 0);
    dom.systemChange(false);
    assertEquals(modes.length, 3);
  });
});
