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

import {
  type ApiCallRecord,
  classifyApiCallService,
} from "../../domain/extensions/extension_publish_checks.ts";

/** The `fetch` signature the HTTP clients and the trust checker accept. */
export type Fetcher = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Collects the HTTP calls made through a {@link recordingFetcher}. */
export interface ApiCallRecorder {
  readonly calls: ApiCallRecord[];
  record(call: ApiCallRecord): void;
}

/** A recorder that keeps every call in order. */
export function createApiCallRecorder(): ApiCallRecorder {
  const calls: ApiCallRecord[] = [];
  return {
    calls,
    record: (call) => {
      calls.push(call);
    },
  };
}

/**
 * Wraps a fetcher so every request is recorded, whether it answered or threw.
 * The record names the service by host (`registryUrl` identifies the
 * registry), and carries the method and URL only — never headers, and never
 * userinfo embedded in the URL.
 */
function withoutUserinfo(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username === "" && parsed.password === "") return url;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

export function recordingFetcher(
  recorder: ApiCallRecorder,
  registryUrl: string,
  base: Fetcher = globalThis.fetch,
): Fetcher {
  return async (url, init) => {
    const target = withoutUserinfo(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    const service = classifyApiCallService(target, registryUrl);
    try {
      const res = await base(url, init);
      recorder.record({
        service,
        method,
        url: target,
        outcome: res.status === 404 ? "not-found" : res.ok ? "ok" : "error",
        status: res.status,
      });
      return res;
    } catch (error) {
      recorder.record({ service, method, url: target, outcome: "error" });
      throw error;
    }
  };
}
