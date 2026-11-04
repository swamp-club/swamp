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

/** Bumped when a change would break an app built against an older SDK. */
export const BRIDGE_VERSION = 1;

/** The message an app's window posts to its parent, asking for a port. */
export const APP_READY_MESSAGE = "swamp-app-ready";

/** A serve frame as it crosses the bridge. */
export interface BridgeFrame {
  readonly type: string;
  readonly id: string;
  readonly payload?: unknown;
  readonly event?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

export interface AppTheme {
  readonly mode: "light" | "dark";
  /** Dashboard token names, without the leading `--`, to CSS values. */
  readonly tokens: Readonly<Record<string, string>>;
}

export interface AppInfo {
  readonly name: string;
  readonly title: string;
  readonly capabilities: readonly string[];
  readonly run: readonly string[];
  readonly methods: readonly {
    readonly behavior: string;
    readonly type: string;
    readonly methods: readonly string[];
  }[];
  /** True on the local dashboard, where runs are refused. */
  readonly local: boolean;
}

export type HostMessage =
  | {
    readonly kind: "init";
    readonly bridge: number;
    readonly app: AppInfo;
    readonly theme: AppTheme;
    readonly connected: boolean;
    readonly path: string;
  }
  | { readonly kind: "frame"; readonly frame: BridgeFrame }
  | { readonly kind: "theme"; readonly theme: AppTheme }
  | { readonly kind: "connection"; readonly connected: boolean }
  | { readonly kind: "health"; readonly snapshot: unknown }
  | { readonly kind: "visibility"; readonly visible: boolean }
  | { readonly kind: "path"; readonly path: string };

export type AppMessage =
  | { readonly kind: "frame"; readonly frame: BridgeFrame }
  | { readonly kind: "health-subscribe" }
  | { readonly kind: "health-unsubscribe" }
  | { readonly kind: "navigate"; readonly path: string };

/** The part of a `MessagePort` the bridge uses, so tests can fake one. */
export interface BridgePort {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

export function isAppMessage(value: unknown): value is AppMessage {
  if (value === null || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "health-subscribe" || kind === "health-unsubscribe") return true;
  if (kind === "navigate") {
    return typeof (value as { path?: unknown }).path === "string";
  }
  if (kind !== "frame") return false;
  const frame = (value as { frame?: unknown }).frame;
  if (frame === null || typeof frame !== "object") return false;
  const { type, id } = frame as { type?: unknown; id?: unknown };
  return typeof type === "string" && typeof id === "string" &&
    id.length > 0 && id.length <= 128;
}
