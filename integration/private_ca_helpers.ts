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

import { join } from "@std/path";

/** Returns true if `openssl` is available on PATH. */
export async function hasOpenssl(): Promise<boolean> {
  try {
    const { success } = await new Deno.Command("openssl", {
      args: ["version"],
      stdout: "null",
      stderr: "null",
    }).output();
    return success;
  } catch {
    return false;
  }
}

/** Generates a private CA and a localhost leaf cert signed by it. */
export async function generateCertChain(dir: string): Promise<{
  caPath: string;
  fullchainPath: string;
  leafKeyPath: string;
}> {
  const run = async (args: string[]) => {
    const { success, stderr } = await new Deno.Command("openssl", {
      args,
      stdout: "null",
      stderr: "piped",
    }).output();
    if (!success) {
      throw new Error(
        `openssl ${args.join(" ")} failed: ${new TextDecoder().decode(stderr)}`,
      );
    }
  };

  const caKey = join(dir, "ca.key");
  const caPath = join(dir, "ca.pem");
  const leafKeyPath = join(dir, "leaf.key");
  const leafCsr = join(dir, "leaf.csr");
  const leafPath = join(dir, "leaf.pem");
  const fullchainPath = join(dir, "fullchain.pem");
  const extPath = join(dir, "leaf.ext");

  await run([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    caKey,
    "-out",
    caPath,
    "-days",
    "1",
    "-subj",
    "/CN=Test Private Root CA",
    // Without an explicit basicConstraints extension LibreSSL (the system
    // openssl on macOS) emits a v1 certificate, which rustls rejects while
    // parsing the chain as UnsupportedCertVersion before trust is ever
    // evaluated. OpenSSL 3.x adds this by default; LibreSSL does not.
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  await run([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    leafKeyPath,
    "-out",
    leafCsr,
    "-subj",
    "/CN=localhost",
  ]);
  await Deno.writeTextFile(extPath, "subjectAltName=DNS:localhost\n");
  await run([
    "x509",
    "-req",
    "-in",
    leafCsr,
    "-CA",
    caPath,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-out",
    leafPath,
    "-days",
    "1",
    "-extfile",
    extPath,
  ]);

  const leaf = await Deno.readTextFile(leafPath);
  const ca = await Deno.readTextFile(caPath);
  await Deno.writeTextFile(fullchainPath, leaf + ca);

  return { caPath, fullchainPath, leafKeyPath };
}
