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
import { hasCaTrue, validateEndEntityCert } from "./tls_cert_validation.ts";

async function generateCert(
  extraArgs: string[] = [],
): Promise<string> {
  const cmd = new Deno.Command("openssl", {
    args: [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-keyout",
      "/dev/null",
      "-out",
      "/dev/stdout",
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=test",
      ...extraArgs,
    ],
    stdout: "piped",
    stderr: "null",
  });
  const { stdout } = await cmd.output();
  return new TextDecoder().decode(stdout);
}

Deno.test("hasCaTrue: returns true for default openssl req -x509 cert", async () => {
  const cert = await generateCert();
  assertEquals(hasCaTrue(cert), true);
});

Deno.test("hasCaTrue: returns false for CA:FALSE cert", async () => {
  const cert = await generateCert([
    "-addext",
    "basicConstraints=critical,CA:FALSE",
  ]);
  assertEquals(hasCaTrue(cert), false);
});

Deno.test("hasCaTrue: returns false for RSA CA:FALSE cert", async () => {
  const cmd = new Deno.Command("openssl", {
    args: [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      "/dev/null",
      "-out",
      "/dev/stdout",
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=test",
      "-addext",
      "basicConstraints=critical,CA:FALSE",
    ],
    stdout: "piped",
    stderr: "null",
  });
  const { stdout } = await cmd.output();
  const cert = new TextDecoder().decode(stdout);
  assertEquals(hasCaTrue(cert), false);
});

Deno.test("hasCaTrue: returns false for invalid PEM", () => {
  assertEquals(hasCaTrue("not a cert"), false);
  assertEquals(hasCaTrue(""), false);
});

Deno.test("validateEndEntityCert: returns ca-true warning for CA:TRUE cert", async () => {
  const cert = await generateCert();
  const warnings = validateEndEntityCert(cert);
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].code, "ca-true");
});

Deno.test("validateEndEntityCert: returns no warnings for CA:FALSE cert", async () => {
  const cert = await generateCert([
    "-addext",
    "basicConstraints=critical,CA:FALSE",
  ]);
  const warnings = validateEndEntityCert(cert);
  assertEquals(warnings.length, 0);
});
