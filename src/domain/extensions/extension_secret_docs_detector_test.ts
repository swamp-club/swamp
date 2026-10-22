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

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type ArgumentSchemas,
  detectSecretDocs,
  MAX_SCANNED_LINE_LENGTH,
} from "./extension_secret_docs_detector.ts";

const fenced = (...lines: string[]) =>
  ["# Setup", "", "```bash", ...lines, "```", ""].join("\n");

/** A key-shaped payload with no repeated run, unlike a placeholder. */
const varied = (n: number) =>
  Array.from({ length: n }, (_, i) => "aB3dE5gH7jK9mN2p"[i % 16]).join("");

/** The 1-based lines flagged in a fenced block built by {@link fenced}. */
const flaggedLines = (text: string, schemas?: ArgumentSchemas) =>
  detectSecretDocs(text, "markdown", schemas).map((f) => f.line);

Deno.test("detectSecretDocs: flags the artifactory README from swamp-club#3757", () => {
  const readme = fenced(
    'swamp vault put my-vault artifactory-token "eyJ..."',
    "swamp model create @webframp/artifactory my-artifactory \\",
    "  --global-arg url=https://packages.example.com \\",
    "  --global-arg 'token=vault://my-vault/artifactory-token'",
  );
  const findings = detectSecretDocs(readme, "markdown");
  assertEquals(findings.map((f) => f.line), [4, 5]);
  assertStringIncludes(
    findings[0].message,
    "`swamp vault put` on the command line",
  );
  assertStringIncludes(findings[1].message, "`vault://`");
  assertStringIncludes(findings[1].message, "`--global-arg token`");
  assertStringIncludes(findings[1].message, "${{ vault.get(<vault>, <key>) }}");
});

Deno.test("detectSecretDocs: each unsupported reference syntax is flagged", () => {
  for (
    const line of [
      "--global-arg url=vault://v/k",
      "value: <vault:my-vault/key>",
      'apiKey: {{ vault "my-vault" "key" }}',
      "swamp vault set my-vault key",
    ]
  ) {
    assertEquals(flaggedLines(fenced(line)), [4], line);
  }
});

Deno.test("detectSecretDocs: the vault expression passes", () => {
  const readme = fenced(
    "swamp vault put my-vault api-token",
    "swamp model create @x/y m \\",
    "  --global-arg 'apiToken=${{ vault.get(my-vault, api-token) }}'",
    'swamp model method run m sync --input token="${{ vault.get(v, k) }}"',
    "apiToken: ${{ vault.get(my-vault, api-token) }}",
  );
  assertEquals(flaggedLines(readme), []);
});

Deno.test("detectSecretDocs: a secret argument set to a literal or placeholder is flagged", () => {
  assertEquals(flaggedLines(fenced("--global-arg apiToken=abc123")), [4]);
  assertEquals(flaggedLines(fenced("--global-arg apiToken=<your-token>")), [4]);
  assertEquals(flaggedLines(fenced("--global-arg=password=$PW")), [4]);
  assertEquals(flaggedLines(fenced("--input secret_key=x")), [4]);
});

Deno.test("detectSecretDocs: non-secret and reference arguments pass", () => {
  assertEquals(
    flaggedLines(fenced("--global-arg url=https://x.example.com")),
    [],
  );
  assertEquals(flaggedLines(fenced("--global-arg secretName=prod-db")), []);
  assertEquals(flaggedLines(fenced("--input nextToken=abc")), []);
  assertEquals(flaggedLines(fenced("--input-file token.yaml")), []);
});

Deno.test("detectSecretDocs: schema-sensitive names count whatever they are called", () => {
  const readme = fenced("--global-arg jfrogIdentity=abc");
  assertEquals(flaggedLines(readme), []);
  const schemas = {
    sensitive: new Set(["jfrogIdentity"]),
    declared: new Set(["jfrogIdentity"]),
  };
  assertEquals(flaggedLines(readme, schemas), [4]);
});

Deno.test("detectSecretDocs: a declared argument the schema leaves unmarked is not a secret", () => {
  // secretKey names a vault key here; the schema, not the name, decides.
  const readme = fenced(
    "--input vaultName=exe-dev --input secretKey=API_TOKEN",
  );
  assertEquals(flaggedLines(readme), [4]);
  assertEquals(
    flaggedLines(readme, {
      sensitive: new Set(),
      declared: new Set(["vaultName", "secretKey"]),
    }),
    [],
  );
});

Deno.test("detectSecretDocs: a boolean value for a secret-named flag passes", () => {
  assertEquals(flaggedLines(fenced("--input create_project_token=true")), []);
  assertEquals(flaggedLines(fenced("--input rotate_token=FALSE \\")), []);
  assertEquals(flaggedLines(fenced("--input token=trueish")), [4]);
});

Deno.test("detectSecretDocs: swamp vault put with a value on the command line is flagged", () => {
  for (
    const line of [
      "swamp vault put my-vault api-token abc123",
      "swamp vault put my-vault API_TOKEN=abc123",
      "swamp vault put <vault> <key> <value>",
      "swamp vault put --repo-dir . my-vault key value",
      "swamp vault write-secret my-vault key value",
    ]
  ) {
    assertEquals(flaggedLines(fenced(line)), [4], line);
  }
});

Deno.test("detectSecretDocs: prompted, piped and remote vault put pass", () => {
  for (
    const line of [
      "swamp vault put my-vault api-token",
      "swamp vault put my-vault api-token --yes",
      'echo "$TOKEN" | swamp vault put my-vault api-token',
      "swamp vault put my-vault api-token < token.txt",
      "swamp vault put my-vault api-token 2>&1 | tee log",
      "swamp vault put --server wss://h.example.com my-vault key value",
      "swamp vault put my-vault key value --server=wss://h.example.com",
    ]
  ) {
    assertEquals(flaggedLines(fenced(line)), [], line);
  }
});

Deno.test("detectSecretDocs: exporting a secret into the environment is not flagged", () => {
  // Some SDKs read credentials only from the environment.
  assertEquals(flaggedLines(fenced('export GITLAB_TOKEN="abc"')), []);
  assertEquals(
    flaggedLines(fenced("export AWS_SECRET_ACCESS_KEY=wJal...")),
    [],
  );
});

Deno.test("detectSecretDocs: credential shapes are flagged anywhere in Markdown", () => {
  const token = "ghp_" + varied(36);
  const prose = `Use the token ${token} to log in.\n`;
  assertEquals(flaggedLines(prose), [1]);
  for (
    const shape of [
      "glpat-" + varied(20),
      "sk-ant-api03-" + varied(30),
      "AKIA" + varied(16).toUpperCase(),
      "xoxb-" + varied(12),
      "hvs." + varied(24),
      "Bearer " + varied(24),
      "postgres://admin:hunter2@db.acme.io/app",
    ]
  ) {
    assertEquals(flaggedLines(`text ${shape}\n`), [1], shape);
  }
});

Deno.test("detectSecretDocs: placeholders and short prefixes are not credential shapes", () => {
  for (
    const line of [
      "Token: glpat-xxxxxxxxxxxxxxxxxxxx",
      "Key: AKIAXXXXXXXXXXXXXXXX",
      'POSTGRES_TEST_URL="postgres://test:test@localhost:5432/test"',
      "mysql://root:pw@127.0.0.1/app",
      "https://user:pw@db.example.com/x",
      "Paste your token, which starts with eyJ...",
      "Tokens look like ghp_xxxx.",
      "Authorization: Bearer $TOKEN",
      "postgres://admin:${{ vault.get(v, pw) }}@db.example.com",
      "postgres://admin:$PASSWORD@db.example.com",
      "https://packages.example.com/artifactory",
    ]
  ) {
    assertEquals(flaggedLines(fenced(line)), [], line);
  }
});

Deno.test("detectSecretDocs: prose that names a wrong form outside a fence passes", () => {
  const readme = [
    "Tokens in vault references (`vault://`) are refreshed automatically.",
    "Never run `swamp vault put my-vault key value` or `export API_KEY=x`.",
  ].join("\n");
  assertEquals(flaggedLines(readme), []);
});

Deno.test("detectSecretDocs: fences close only on a matching marker", () => {
  const readme = [
    "````md",
    "```",
    "not closed yet",
    "```",
    "swamp vault set v k",
    "````",
    "swamp vault set v k",
  ].join("\n");
  assertEquals(flaggedLines(readme), [5]);
});

Deno.test("detectSecretDocs: inline code in prose ends a vault put command", () => {
  const description =
    "Store it with `swamp vault put typesafe API_KEY` (it prompts), then run.";
  assertEquals(detectSecretDocs(description, "plain"), []);
  assertEquals(
    detectSecretDocs("Never `swamp vault put v k value` here.", "plain")
      .map((f) => f.line),
    [1],
  );
});

Deno.test("detectSecretDocs: plain text is checked on every line", () => {
  const description = [
    "Artifactory models.",
    "",
    "    swamp model create @x/artifactory a \\",
    "      --global-arg 'token=vault://v/k'",
  ].join("\n");
  assertEquals(
    detectSecretDocs(description, "plain").map((f) => f.line),
    [3],
  );
});

Deno.test("detectSecretDocs: source form reads describe and description strings only", () => {
  const source = [
    "const token = 'vault://not-docs';",
    '  token: z.string().describe("vault:// reference to the token"),',
    "  description: 'Set with swamp vault set',",
    '  url: z.string().describe("Base URL"),',
  ].join("\n");
  assertEquals(
    detectSecretDocs(source, "source").map((f) => f.line),
    [2, 3],
  );
});

Deno.test("detectSecretDocs: lines over the cap are skipped", () => {
  const long = "swamp vault set v k " + "x".repeat(MAX_SCANNED_LINE_LENGTH);
  assertEquals(flaggedLines(fenced(long)), []);
  assertEquals(detectSecretDocs(long, "plain"), []);
});
