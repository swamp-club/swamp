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

import { assert, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";

/**
 * Integration coverage for the TLS trust-store shim (issue #503).
 *
 * These tests drive the REAL `configureTlsTrust` code path in fresh
 * subprocesses — Deno reads its TLS CA environment lazily and caches the rustls
 * root store on first use, so each scenario must run in its own process. Using
 * the actual module (rather than a hand-rolled fetch client) guards the wiring:
 * if `configureTlsTrust` stopped mapping SSL_CERT_FILE, these would fail.
 *
 * Coverage boundary: the `system` trust-store branch cannot be exercised
 * without mutating the operating-system trust store, so these tests use the
 * SSL_CERT_FILE -> DENO_CERT mapping as the testable proxy for the lazy-env
 * mechanism. The public-TLS assertion is offline-tolerant.
 */

const TLS_TRUST_MODULE = toFileUrl(
  join(
    import.meta.dirname!,
    "..",
    "src",
    "infrastructure",
    "runtime",
    "tls_trust.ts",
  ),
).href;

/** Returns true if `openssl` is available on PATH. */
async function hasOpenssl(): Promise<boolean> {
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
async function generateCertChain(dir: string): Promise<{
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

/**
 * Runs a small client in a subprocess. The client optionally calls the real
 * `configureTlsTrust`, then fetches `url`. Returns the captured RESULT line.
 * The subprocess env is fully controlled (clearEnv) so the test is
 * deterministic regardless of the developer's shell.
 */
async function runClient(opts: {
  url: string;
  callShim: boolean;
  env: Record<string, string>;
}): Promise<string> {
  const script = `
import { configureTlsTrust } from ${JSON.stringify(TLS_TRUST_MODULE)};
if (${opts.callShim}) configureTlsTrust();
try {
  const r = await fetch(${JSON.stringify(opts.url)});
  console.log("RESULT:OK:" + r.status);
} catch (e) {
  console.log("RESULT:ERR:" + (e instanceof Error ? e.message : String(e)));
}
`;
  // Preserve PATH/HOME/DENO_DIR so deno can resolve its cache, but drop any
  // ambient TLS vars unless the scenario sets them explicitly.
  const baseEnv: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "DENO_DIR", "TMPDIR", "SystemRoot"]) {
    const v = Deno.env.get(key);
    if (v) baseEnv[key] = v;
  }
  const { stdout } = await spawnWithStdin(script, { ...baseEnv, ...opts.env });
  const out = new TextDecoder().decode(stdout);
  const line = out.split("\n").find((l) => l.startsWith("RESULT:")) ??
    out.trim();
  return line;
}

/** Spawns `deno run -` feeding the script via stdin. */
async function spawnWithStdin(
  script: string,
  env: Record<string, string>,
): Promise<{ stdout: Uint8Array }> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-net", "--allow-read", "--allow-env", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
    clearEnv: true,
    env,
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(script));
  await writer.close();
  const { stdout } = await child.output();
  return { stdout };
}

Deno.test("tls_trust integration: shim resolves a private-CA chain via SSL_CERT_FILE", async () => {
  if (!(await hasOpenssl())) {
    console.warn("skipping: openssl not available");
    return;
  }

  const dir = await Deno.makeTempDir({ prefix: "swamp-tls-trust-" });
  try {
    const { caPath, fullchainPath, leafKeyPath } = await generateCertChain(dir);
    const cert = await Deno.readTextFile(fullchainPath);
    const key = await Deno.readTextFile(leafKeyPath);

    const ac = new AbortController();
    const server = Deno.serve(
      { port: 0, cert, key, signal: ac.signal, onListen: () => {} },
      () => new Response("ok"),
    );
    const port = (server.addr as Deno.NetAddr).port;
    const url = `https://localhost:${port}/`;

    try {
      // (a) Default behavior with no extra trust: the private CA is unknown.
      const noTrust = await runClient({ url, callShim: false, env: {} });
      assertStringIncludes(noTrust, "RESULT:ERR:");
      assertStringIncludes(noTrust, "UnknownIssuer");

      // (b) The real shim maps SSL_CERT_FILE -> DENO_CERT and the call succeeds.
      const withShim = await runClient({
        url,
        callShim: true,
        env: { SSL_CERT_FILE: caPath },
      });
      assertStringIncludes(withShim, "RESULT:OK:200");
    } finally {
      ac.abort();
      await server.finished;
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("tls_trust integration: public TLS still works under the merged store", async () => {
  // The shim defaults DENO_TLS_CA_STORE to system,mozilla; mozilla roots must
  // still validate public endpoints. Offline-tolerant: a connection/DNS error
  // is skipped, but a certificate error is a real failure.
  const result = await runClient({
    url: "https://example.com/",
    callShim: true,
    env: {},
  });
  if (result.includes("RESULT:OK:")) {
    assert(true);
    return;
  }
  // Tolerate offline CI; fail only on certificate-trust regressions.
  assert(
    !result.includes("UnknownIssuer") &&
      !result.includes("invalid peer certificate"),
    `public TLS failed with a certificate error under the merged store: ${result}`,
  );
  console.warn(`skipping public-TLS assertion (offline?): ${result}`);
});
