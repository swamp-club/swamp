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
import { computeTlsTrustEnv } from "./tls_trust.ts";

Deno.test("computeTlsTrustEnv: defaults DENO_TLS_CA_STORE to system,mozilla when unset", () => {
  const mutations = computeTlsTrustEnv({});
  assertEquals(mutations["DENO_TLS_CA_STORE"], "system,mozilla");
});

Deno.test("computeTlsTrustEnv: respects an explicitly set DENO_TLS_CA_STORE", () => {
  const mutations = computeTlsTrustEnv({ DENO_TLS_CA_STORE: "mozilla" });
  assertEquals(mutations["DENO_TLS_CA_STORE"], undefined);
});

Deno.test("computeTlsTrustEnv: respects DENO_TLS_CA_STORE set to system", () => {
  const mutations = computeTlsTrustEnv({ DENO_TLS_CA_STORE: "system" });
  assertEquals(mutations["DENO_TLS_CA_STORE"], undefined);
});

Deno.test("computeTlsTrustEnv: treats empty-string DENO_TLS_CA_STORE as unset", () => {
  const mutations = computeTlsTrustEnv({ DENO_TLS_CA_STORE: "" });
  assertEquals(mutations["DENO_TLS_CA_STORE"], "system,mozilla");
});

Deno.test("computeTlsTrustEnv: maps SSL_CERT_FILE to DENO_CERT when DENO_CERT unset", () => {
  const mutations = computeTlsTrustEnv({ SSL_CERT_FILE: "/etc/ca-bundle.pem" });
  assertEquals(mutations["DENO_CERT"], "/etc/ca-bundle.pem");
});

Deno.test("computeTlsTrustEnv: does not override an explicitly set DENO_CERT", () => {
  const mutations = computeTlsTrustEnv({
    SSL_CERT_FILE: "/etc/ca-bundle.pem",
    DENO_CERT: "/etc/explicit.pem",
  });
  assertEquals(mutations["DENO_CERT"], undefined);
});

Deno.test("computeTlsTrustEnv: treats empty-string SSL_CERT_FILE as unset", () => {
  const mutations = computeTlsTrustEnv({ SSL_CERT_FILE: "" });
  assertEquals(mutations["DENO_CERT"], undefined);
});

Deno.test("computeTlsTrustEnv: ignores SSL_CERT_DIR (no DENO_CERT directory equivalent)", () => {
  // SSL_CERT_DIR is intentionally unsupported — it is not part of the snapshot
  // and must never produce a mutation. Only the CA-store default is applied.
  const mutations = computeTlsTrustEnv(
    { SSL_CERT_FILE: undefined } as Record<string, string | undefined>,
  );
  assertEquals(mutations["DENO_CERT"], undefined);
  assertEquals(mutations["DENO_TLS_CA_STORE"], "system,mozilla");
});

Deno.test("computeTlsTrustEnv: applies both mutations together", () => {
  const mutations = computeTlsTrustEnv({ SSL_CERT_FILE: "/etc/ca-bundle.pem" });
  assertEquals(mutations, {
    DENO_TLS_CA_STORE: "system,mozilla",
    DENO_CERT: "/etc/ca-bundle.pem",
  });
});

Deno.test("computeTlsTrustEnv: no mutations when user has set everything", () => {
  const mutations = computeTlsTrustEnv({
    DENO_TLS_CA_STORE: "system",
    DENO_CERT: "/etc/explicit.pem",
    SSL_CERT_FILE: "/etc/ca-bundle.pem",
  });
  assertEquals(mutations, {});
});
