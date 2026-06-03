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

import { toFileUrl } from "@std/path";

interface ImportRequest {
  action: "import";
  bundlePath: string;
  fingerprint: string;
  exportKey: string;
}

interface HeapRequest {
  action: "heap";
}

type Request = ImportRequest | HeapRequest;

function respond(data: Record<string, unknown>): void {
  console.log(JSON.stringify(data));
}

const decoder = new TextDecoder("utf-8");
const buf = new Uint8Array(65536);
let remainder = "";

async function readLine(): Promise<string> {
  while (true) {
    const idx = remainder.indexOf("\n");
    if (idx !== -1) {
      const line = remainder.slice(0, idx).trim();
      remainder = remainder.slice(idx + 1);
      if (line) return line;
      continue;
    }
    const n = await Deno.stdin.read(buf);
    if (n === null) {
      const last = remainder.trim();
      remainder = "";
      return last;
    }
    remainder += decoder.decode(buf.subarray(0, n), { stream: true });
  }
}

async function main(): Promise<void> {
  respond({ status: "ready" });

  while (true) {
    const raw = await readLine();
    if (!raw) break;

    let req: Request;
    try {
      req = JSON.parse(raw) as Request;
    } catch {
      respond({ status: "error", error: "invalid JSON" });
      continue;
    }

    if (req.action === "heap") {
      // deno-lint-ignore no-explicit-any
      const mem = (performance as any).measureUserAgentSpecificMemory
        // deno-lint-ignore no-explicit-any
        ? await (performance as any).measureUserAgentSpecificMemory()
        : { bytes: Deno.memoryUsage().heapUsed };
      respond({ status: "heap", bytes: mem.bytes });
      continue;
    }

    if (req.action === "import") {
      try {
        const baseUrl = toFileUrl(req.bundlePath).href;
        const importUrl = req.fingerprint
          ? `${baseUrl}?fp=${req.fingerprint}`
          : baseUrl;
        const mod = await import(importUrl);
        const exported = mod[req.exportKey];
        const version = exported && typeof exported === "object"
          // deno-lint-ignore no-explicit-any
          ? (exported as any).version
          : undefined;
        respond({
          status: "ok",
          hasExport: exported !== undefined,
          exportKeys: Object.keys(mod),
          fingerprint: req.fingerprint,
          version: version ?? null,
        });
      } catch (error) {
        respond({
          status: "error",
          error: String(error).substring(0, 500),
        });
      }
      continue;
    }

    respond({
      status: "error",
      error: `unknown action: ${(req as Record<string, unknown>).action}`,
    });
  }
}

main();
