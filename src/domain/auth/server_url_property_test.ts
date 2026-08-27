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

import { assert, assertEquals, assertThrows } from "@std/assert";
import fc from "fast-check";
import { normalizeServerUrl } from "./server_url.ts";

const arbScheme = fc.constantFrom("http", "https");

const arbHost = fc.constantFrom(
  "example.com",
  "Example.COM",
  "SWAMP.Example.Org",
  "localhost",
  "sub.domain.io",
  "127.0.0.1",
);

const arbSegment = fc.stringOf(
  fc.constantFrom(..."abcdefgh0123-_".split("")),
  { minLength: 1, maxLength: 8 },
);

const arbPathSegments = fc.array(arbSegment, { maxLength: 3 });

interface UrlParts {
  scheme: string;
  host: string;
  port?: number;
  segments: string[];
  trailingSlashes: number;
}

const arbUrlParts: fc.Arbitrary<UrlParts> = fc.record({
  scheme: arbScheme,
  host: arbHost,
  port: fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
  segments: arbPathSegments,
  trailingSlashes: fc.integer({ min: 0, max: 3 }),
});

function buildUrl(parts: UrlParts): string {
  const port = parts.port === undefined ? "" : `:${parts.port}`;
  const path = parts.segments.length > 0 ? `/${parts.segments.join("/")}` : "";
  return `${parts.scheme}://${parts.host}${port}${path}${
    "/".repeat(parts.trailingSlashes)
  }`;
}

Deno.test("normalizeServerUrl: is idempotent", () => {
  fc.assert(
    fc.property(arbUrlParts, (parts) => {
      const once = normalizeServerUrl(buildUrl(parts));
      assertEquals(normalizeServerUrl(once), once);
      assertEquals(normalizeServerUrl(normalizeServerUrl(once)), once);
    }),
    { numRuns: 300 },
  );
});

Deno.test("normalizeServerUrl: never keeps a trailing slash and always keeps the scheme", () => {
  fc.assert(
    fc.property(arbUrlParts, (parts) => {
      const normalized = normalizeServerUrl(buildUrl(parts));
      assert(normalized.startsWith(`${parts.scheme}://`));
      assertEquals(normalized.endsWith("/"), false);
      assertEquals(normalized, normalized.toLowerCase());
    }),
    { numRuns: 300 },
  );
});

Deno.test("normalizeServerUrl: trailing slashes are insignificant", () => {
  fc.assert(
    fc.property(
      arbUrlParts,
      fc.integer({ min: 0, max: 4 }),
      (parts, extraSlashes) => {
        const base = normalizeServerUrl(
          buildUrl({ ...parts, trailingSlashes: 0 }),
        );
        assertEquals(
          normalizeServerUrl(
            buildUrl({ ...parts, trailingSlashes: extraSlashes }),
          ),
          base,
        );
      },
    ),
    { numRuns: 300 },
  );
});

Deno.test("normalizeServerUrl: host casing is insignificant", () => {
  fc.assert(
    fc.property(arbUrlParts, (parts) => {
      const lower = normalizeServerUrl(
        buildUrl({ ...parts, host: parts.host.toLowerCase() }),
      );
      const upper = normalizeServerUrl(
        buildUrl({ ...parts, host: parts.host.toUpperCase() }),
      );
      assertEquals(upper, lower);
    }),
    { numRuns: 300 },
  );
});

Deno.test("normalizeServerUrl: query strings and fragments are dropped", () => {
  fc.assert(
    fc.property(arbUrlParts, arbSegment, (parts, token) => {
      const base = buildUrl(parts);
      assertEquals(
        normalizeServerUrl(`${base}?q=${token}#${token}`),
        normalizeServerUrl(base),
      );
    }),
    { numRuns: 300 },
  );
});

Deno.test("normalizeServerUrl: default ports are stripped, others are kept", () => {
  fc.assert(
    fc.property(
      arbHost,
      arbPathSegments,
      fc.integer({ min: 1, max: 65535 }),
      (host, segments, port) => {
        const path = segments.length > 0 ? `/${segments.join("/")}` : "";
        assertEquals(
          normalizeServerUrl(`https://${host}:443${path}`),
          normalizeServerUrl(`https://${host}${path}`),
        );
        assertEquals(
          normalizeServerUrl(`http://${host}:80${path}`),
          normalizeServerUrl(`http://${host}${path}`),
        );
        if (port !== 443) {
          assert(
            normalizeServerUrl(`https://${host}:${port}${path}`).includes(
              `:${port}`,
            ),
          );
        }
        if (port !== 80) {
          assert(
            normalizeServerUrl(`http://${host}:${port}${path}`).includes(
              `:${port}`,
            ),
          );
        }
      },
    ),
    { numRuns: 300 },
  );
});

Deno.test("normalizeServerUrl: rejects non-http(s) schemes", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("ftp", "file", "swamp"),
      arbHost,
      (scheme, host) => {
        assertThrows(
          () => normalizeServerUrl(`${scheme}://${host}`),
          TypeError,
        );
      },
    ),
    { numRuns: 100 },
  );
});

Deno.test("normalizeServerUrl: rejects strings that are not URLs", () => {
  fc.assert(
    fc.property(
      fc.stringOf(fc.constantFrom(..."abcdefgh0123 ".split("")), {
        minLength: 1,
        maxLength: 20,
      }),
      (value) => {
        assertThrows(() => normalizeServerUrl(value), TypeError);
      },
    ),
    { numRuns: 200 },
  );
});
