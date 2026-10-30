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

// `workflow cancel --server` trusts the CA from `--ca-cert` / `SWAMP_CA_CERT`
// (swamp-club#3702), against a real TLS server whose certificate is signed by
// a private CA. A test of `sendServerCancel` alone would pass with the command
// never handing it the certificates, so one case runs the command itself.

import "../src/domain/models/models.ts";
import "../src/cli/mod.ts";
import { join } from "@std/path";
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  buildCancelUrl,
  buildServerCancelRequest,
  sendServerCancel,
  workflowCancelCommand,
} from "../src/cli/commands/workflow_cancel.ts";
import { UserError } from "../src/domain/errors.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { generateCertChain, hasOpenssl } from "./private_ca_helpers.ts";

await initializeLogging({});

interface PrivateCaServer {
  /** The private CA that signed the server's certificate, as a path and PEM. */
  caPath: string;
  caPem: string;
  /** A second CA that signed nothing the server presents. */
  unrelatedCaPem: string;
  port: number;
  /** The `METHOD path` of each request the server received. */
  requests: string[];
}

async function withPrivateCaServer(
  fn: (server: PrivateCaServer) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-cancel-ca-cert-" });
  try {
    const { caPath, fullchainPath, leafKeyPath } = await generateCertChain(dir);
    const unrelatedDir = join(dir, "unrelated");
    await Deno.mkdir(unrelatedDir);
    const unrelated = await generateCertChain(unrelatedDir);

    const requests: string[] = [];
    const ac = new AbortController();
    const server = Deno.serve(
      {
        port: 0,
        cert: await Deno.readTextFile(fullchainPath),
        key: await Deno.readTextFile(leafKeyPath),
        signal: ac.signal,
        onListen: () => {},
        // A refused handshake is what several of these tests expect.
        onError: () => new Response(null, { status: 500 }),
      },
      (req) => {
        requests.push(`${req.method} ${new URL(req.url).pathname}`);
        return Response.json({ status: "cancelled", executionId: "run-1" });
      },
    );
    try {
      await fn({
        caPath,
        caPem: await Deno.readTextFile(caPath),
        unrelatedCaPem: await Deno.readTextFile(unrelated.caPath),
        port: (server.addr as Deno.NetAddr).port,
        requests,
      });
    } finally {
      ac.abort();
      await server.finished;
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

function cancelVia(
  server: string,
  caCerts: string[] | undefined,
): Promise<Record<string, unknown>> {
  return sendServerCancel(
    server,
    "run-1",
    buildServerCancelRequest(
      buildCancelUrl(server, "run-1"),
      undefined,
      undefined,
    ),
    caCerts,
  );
}

const CANCEL_REQUEST = "POST /api/v1/cancel/workflow-run/run-1";

Deno.test("sendServerCancel: trusts a private CA it is given and returns the answer", async () => {
  if (!(await hasOpenssl())) {
    console.warn("skipping: openssl not available");
    return;
  }
  await withPrivateCaServer(async ({ caPem, port, requests }) => {
    const body = await cancelVia(`https://localhost:${port}`, [caPem]);

    assertEquals(body.status, "cancelled");
    assertEquals(requests, [CANCEL_REQUEST]);
  });
});

Deno.test("sendServerCancel: without the CA the request never leaves and the error names --ca-cert", async () => {
  if (!(await hasOpenssl())) {
    console.warn("skipping: openssl not available");
    return;
  }
  await withPrivateCaServer(async ({ port, requests }) => {
    const error = await assertRejects(
      () => cancelVia(`https://localhost:${port}`, undefined),
      UserError,
    );

    assertStringIncludes(error.message, "TLS certificate rejected");
    assertStringIncludes(error.message, "--ca-cert");
    assertEquals(requests, []);
  });
});

Deno.test("sendServerCancel: an unrelated CA does not satisfy the server's certificate", async () => {
  if (!(await hasOpenssl())) {
    console.warn("skipping: openssl not available");
    return;
  }
  await withPrivateCaServer(async ({ unrelatedCaPem, port, requests }) => {
    const error = await assertRejects(
      () => cancelVia(`https://localhost:${port}`, [unrelatedCaPem]),
      UserError,
    );

    // Both test CAs share a subject name, so rustls finds an issuer and
    // reports a bad signature rather than an unknown issuer.
    assertStringIncludes(error.message, "TLS certificate rejected");
    assertEquals(requests, []);
  });
});

Deno.test("sendServerCancel: a trusted certificate for another name is diagnosed as a mismatch", async () => {
  if (!(await hasOpenssl())) {
    console.warn("skipping: openssl not available");
    return;
  }
  await withPrivateCaServer(async ({ caPem, port, requests }) => {
    // The leaf's only subject alternative name is DNS:localhost.
    const error = await assertRejects(
      () => cancelVia(`https://127.0.0.1:${port}`, [caPem]),
      UserError,
    );

    assertStringIncludes(error.message, "does not match the hostname");
    assertEquals(requests, []);
  });
});

Deno.test("workflow cancel --server: the command trusts the CA in SWAMP_CA_CERT", async () => {
  if (!(await hasOpenssl())) {
    console.warn("skipping: openssl not available");
    return;
  }
  await withPrivateCaServer(async ({ caPath, port, requests }) => {
    await withMockedEnv(
      { SWAMP_CA_CERT: caPath },
      () =>
        workflowCancelCommand.parse([
          "--server",
          `https://localhost:${port}`,
          "--run",
          "run-1",
          "--token",
          "name.secret",
        ]),
    );

    assertEquals(requests, [CANCEL_REQUEST]);
  });
});
