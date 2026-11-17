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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join, resolve } from "@std/path";
import { UserError } from "../../domain/errors.ts";
import { assertPathEquals } from "../../infrastructure/persistence/path_test_helpers.ts";
import { HostConfig } from "./host_config.ts";

const HOST_DIR = resolve("host-folder");

function parse(yaml: string): HostConfig {
  return HostConfig.parse(yaml, HOST_DIR);
}

function refusal(yaml: string): string {
  return assertThrows(() => parse(yaml), UserError).message;
}

Deno.test("HostConfig.parse: a minimal file listens on loopback over http", () => {
  const config = parse("address: http://127.0.0.1:8080\n");
  assertEquals(config.listen, {
    host: "127.0.0.1",
    port: 8080,
    certFile: null,
    keyFile: null,
  });
  assertEquals(config.protocol, "http");
  assertEquals(config.offLoopback, false);
  assertEquals(config.root, null);
  assertEquals(config.trustProxy, false);
  assertEquals(config.oauthClient, null);
  assertPathEquals(config.workspacesDir, join(HOST_DIR, "workspaces"));
});

Deno.test("HostConfig.parse: TLS resolves both files against the host folder and defaults to 443", () => {
  const config = parse(
    [
      "listen:",
      "  host: 0.0.0.0",
      "  cert-file: tls/cert.pem",
      "  key-file: /etc/swamp/key.pem",
      "address: https://serve.acme.internal",
      "root: ../root-repo",
    ].join("\n"),
  );
  assertEquals(config.listen.port, 443);
  assertEquals(config.protocol, "https");
  assertEquals(config.offLoopback, true);
  assertPathEquals(config.listen.certFile!, join(HOST_DIR, "tls", "cert.pem"));
  assertPathEquals(config.listen.keyFile!, resolve("/etc/swamp/key.pem"));
  assertPathEquals(config.root!, resolve(HOST_DIR, "..", "root-repo"));
});

Deno.test("HostConfig: derives each child's address and the trusted host from the public address", () => {
  const plain = parse("address: https://Serve.Acme.Internal/\n");
  assertEquals(plain.address, "https://serve.acme.internal");
  assertEquals(plain.trustedHost, "serve.acme.internal");
  assertEquals(
    plain.childAddress("edge-dns"),
    "https://serve.acme.internal/w/edge-dns",
  );

  const proxied = parse("address: https://acme.example:8443/swamp/\n");
  assertEquals(proxied.trustedHost, "acme.example:8443");
  assertEquals(
    proxied.childAddress("edge-dns"),
    "https://acme.example:8443/swamp/w/edge-dns",
  );
});

Deno.test("HostConfig.parse: names the field that is wrong", () => {
  const cases: Array<[string, string]> = [
    ["", "address"],
    ["address: 7\n", "address"],
    ["address: http://a\nlisten:\n  port: 70000\n", "listen.port"],
    ["address: http://a\nlisten:\n  port: 1.5\n", "listen.port"],
    ["address: http://a\nlisten:\n  bind: x\n", "listen"],
    ["address: http://a\nextra: true\n", "extra"],
    ["address: http://a\ntrust-proxy: yes please\n", "trust-proxy"],
    ["address: not a url\n", "address not a url is not a URL"],
    ["address: ftp://a\n", "must be an http or https URL"],
    ["address: https://u:p@a\n", "credentials"],
    ["address: https://a/?x=1\n", "query or fragment"],
    ["address: http://a\nlisten:\n  cert-file: c.pem\n", "given together"],
    ["address: [\n", "not valid YAML"],
    ["address: http://a\noauth-client:\n  id: c\n", "oauth-client.secret-file"],
    [
      "address: http://a\noauth-client:\n  secret-file: s\n",
      "oauth-client.id",
    ],
    [
      "address: http://a\noauth-client:\n  id: c\n  secret-file: s\n  secret: x\n",
      "oauth-client",
    ],
  ];
  for (const [yaml, expected] of cases) {
    const message = refusal(yaml);
    assertStringIncludes(message, "Invalid host.yaml", yaml);
    assertStringIncludes(message, expected, yaml);
  }
});

Deno.test("HostConfig.parse: refuses an off-loopback listener without TLS, as serve does", () => {
  assertStringIncludes(
    refusal("address: http://a\nlisten:\n  host: 0.0.0.0\n"),
    "requires TLS",
  );
});

Deno.test("HostConfig.parse: refuses a root inside workspaces/", () => {
  for (
    const root of ["workspaces", "workspaces/edge-dns", "./workspaces/x/y"]
  ) {
    assertStringIncludes(
      refusal(`address: http://a\nroot: ${root}\n`),
      "inside workspaces/",
      root,
    );
  }
  assertEquals(
    parse("address: http://a\nroot: workspaces-root\n").root !== null,
    true,
  );
});

Deno.test("HostConfig.parse: refuses a root that contains workspaces/", () => {
  for (const root of [".", "./", "..", "../..", resolve(HOST_DIR, "..")]) {
    assertStringIncludes(
      refusal(`address: http://a\nroot: ${root}\n`),
      "contains workspaces/",
      root,
    );
  }
  assertEquals(
    parse("address: http://a\nroot: root-repo\n").root !== null,
    true,
  );
  assertEquals(
    parse("address: http://a\nroot: ../sibling-repo\n").root !== null,
    true,
  );
});

Deno.test("HostConfig.parse: allow-unauthenticated-behind-proxy needs a loopback host behind a proxy", () => {
  for (
    const address of [
      "http://127.0.0.1:8080",
      "http://localhost",
      "http://[::1]",
    ]
  ) {
    assertStringIncludes(
      refusal(
        `address: ${address}\nallow-unauthenticated-behind-proxy: true\n`,
      ),
      "allow-unauthenticated-behind-proxy applies only",
      address,
    );
  }
  assertEquals(
    parse(
      "address: https://serve.acme.internal\nallow-unauthenticated-behind-proxy: true\n",
    ).allowUnauthenticatedBehindProxy,
    true,
  );
  assertStringIncludes(
    refusal(
      [
        "address: https://a",
        "listen: {host: 0.0.0.0, cert-file: c, key-file: k}",
        "trust-proxy: true",
        "allow-unauthenticated-behind-proxy: true",
      ].join("\n"),
    ),
    "allow-unauthenticated-behind-proxy applies only",
  );
});

Deno.test("HostConfig.noAuthRefusal: refuses auth mode none off loopback and behind a proxy unless overridden", () => {
  for (
    const address of [
      "http://127.0.0.1:8080",
      "http://localhost",
      "http://127.0.0.2",
      "http://[::1]:8080",
    ]
  ) {
    assertEquals(parse(`address: ${address}\n`).noAuthRefusal(), null, address);
  }
  assertStringIncludes(
    parse(
      "address: https://a\nlisten: {host: 0.0.0.0, cert-file: c, key-file: k}\n",
    ).noAuthRefusal()!,
    "off loopback",
  );
  const proxied = parse("address: https://a\ntrust-proxy: true\n");
  assertStringIncludes(proxied.noAuthRefusal()!, "trust-proxy: true");
  assertStringIncludes(
    proxied.noAuthRefusal()!,
    "allow-unauthenticated-behind-proxy",
  );
  assertEquals(
    parse(
      "address: https://a\ntrust-proxy: true\nallow-unauthenticated-behind-proxy: true\n",
    ).noAuthRefusal(),
    null,
  );
});

Deno.test("HostConfig.noAuthRefusal: a loopback host whose address is a public name is behind an undeclared proxy", () => {
  const undeclared = parse("address: https://serve.acme.internal\n");
  assertStringIncludes(undeclared.noAuthRefusal()!, "serve.acme.internal");
  assertStringIncludes(undeclared.noAuthRefusal()!, "not loopback");
  assertStringIncludes(
    undeclared.noAuthRefusal()!,
    "allow-unauthenticated-behind-proxy",
  );
  assertEquals(
    parse(
      "address: https://serve.acme.internal\nallow-unauthenticated-behind-proxy: true\n",
    ).noAuthRefusal(),
    null,
  );
});

Deno.test("HostConfig.parse: an OAuth client keeps its id and resolves the secret file against the host folder", () => {
  const config = parse(
    "address: http://a\noauth-client:\n  id: client-123\n  secret-file: secrets/oauth\n",
  );
  assertEquals(config.oauthClient?.id, "client-123");
  assertPathEquals(
    config.oauthClient!.secretFile,
    join(HOST_DIR, "secrets", "oauth"),
  );
  const absolute = parse(
    "address: http://a\noauth-client:\n  id: c\n  secret-file: /run/secrets/oauth\n",
  );
  assertPathEquals(
    absolute.oauthClient!.secretFile,
    resolve("/run/secrets/oauth"),
  );
});

Deno.test("HostConfig.parse: refuses an OAuth client secret file inside workspaces/ or the root repo", () => {
  const cases: Array<[string, string]> = [
    ["workspaces/edge-dns/secret", "inside workspaces/"],
    ["./workspaces/secret", "inside workspaces/"],
    ["root-repo/secret", "inside the root repo"],
    ["root-repo/.swamp/secret", "inside the root repo"],
  ];
  for (const [secretFile, expected] of cases) {
    const message = refusal(
      `address: http://a\nroot: root-repo\noauth-client:\n  id: c\n  secret-file: ${secretFile}\n`,
    );
    assertStringIncludes(message, "oauth-client.secret-file", secretFile);
    assertStringIncludes(message, expected, secretFile);
  }
  assertEquals(
    parse(
      "address: http://a\nroot: root-repo\noauth-client:\n  id: c\n  secret-file: root-repo-secret\n",
    ).oauthClient !== null,
    true,
  );
});
