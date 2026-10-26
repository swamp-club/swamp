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
import { hasBareImport } from "./extension_project.ts";
import { bareFromImports, scanImportSites } from "./import_sites.ts";

Deno.test("scanImportSites: reports each import with its quoted span", () => {
  const source = "import ms from \"ms\";\nexport { x } from './x.ts';\n";
  assertEquals(scanImportSites(source), [
    {
      specifier: "ms",
      span: {
        start: { line: 0, character: 15 },
        end: { line: 0, character: 19 },
      },
      offset: 15,
    },
    {
      specifier: "./x.ts",
      span: {
        start: { line: 1, character: 18 },
        end: { line: 1, character: 26 },
      },
      offset: 39,
    },
  ]);
});

Deno.test("scanImportSites: counts columns in code points after astral characters and comments", () => {
  const source = '// 🎉 note\n/* 😀 */ import a from "a"; const s = "🎉";\n';
  const [site] = scanImportSites(source);
  assertEquals(site.specifier, "a");
  assertEquals(site.span, {
    start: { line: 1, character: 22 },
    end: { line: 1, character: 25 },
  });
  const line = Array.from(source.split("\n")[1]);
  assertEquals(line.slice(22, 25).join(""), '"a"');
});

Deno.test("scanImportSites: reads side-effect, dynamic, type and multi-line imports", () => {
  const source = [
    'import "side";',
    'const m = await import("lazy");',
    'type T = typeof import("types");',
    "import {",
    "  a,",
    "  b,",
    '} from "multi";',
    'export * from "star";',
  ].join("\n");
  assertEquals(
    scanImportSites(source).map((s) => [s.specifier, s.span.start.line]),
    [["side", 0], ["lazy", 1], ["types", 2], ["multi", 6], ["star", 7]],
  );
});

Deno.test("scanImportSites: ignores import text in comments, strings and template literals", () => {
  const source = [
    '// import a from "a";',
    '/* import b from "b"; */',
    "const s = \"import c from 'c'\";",
    'const t = `import d from "d"`;',
    'import real from "real";',
  ].join("\n");
  assertEquals(scanImportSites(source).map((s) => s.specifier), [
    "real",
  ]);
});

Deno.test("scanImportSites: leaves out an unterminated specifier", () => {
  assertEquals(scanImportSites('import a from "a\nconst x = 1;'), []);
});

Deno.test("hasBareImport returns true for bare zod import", () => {
  assertEquals(hasBareImport('import { z } from "zod";'), true);
});

Deno.test("hasBareImport returns true for bare scoped import", () => {
  assertEquals(
    hasBareImport(
      'import { Client } from "@aws-sdk/client-secrets-manager";',
    ),
    true,
  );
});

Deno.test("hasBareImport returns false for npm: prefixed import", () => {
  assertEquals(
    hasBareImport('import { z } from "npm:zod@4";'),
    false,
  );
});

Deno.test("hasBareImport returns false for relative import", () => {
  assertEquals(
    hasBareImport('import { helper } from "./helpers.ts";'),
    false,
  );
});

Deno.test("hasBareImport returns false for jsr: import", () => {
  assertEquals(
    hasBareImport('import { assert } from "jsr:@std/assert";'),
    false,
  );
});

Deno.test("hasBareImport returns false for node: import", () => {
  assertEquals(
    hasBareImport('import { readFile } from "node:fs";'),
    false,
  );
});

Deno.test("hasBareImport returns false for https: import", () => {
  assertEquals(
    hasBareImport(
      'import { delay } from "https://deno.land/std@0.224.0/async/delay.ts";',
    ),
    false,
  );
});

Deno.test("hasBareImport returns false for http: import", () => {
  assertEquals(
    hasBareImport(
      'import { x } from "http://example.com/mod.ts";',
    ),
    false,
  );
});

Deno.test("hasBareImport returns false when only relative and npm imports", () => {
  const source = `
import { z } from "npm:zod@4";
import { helper } from "./helpers.ts";
export { foo } from "../shared.ts";
`;
  assertEquals(hasBareImport(source), false);
});

// --- extractBareSpecifierNames unit tests ---

Deno.test("bareFromImports: returns bare specifier names", () => {
  assertEquals(
    bareFromImports('import { z } from "zod";'),
    ["zod"],
  );
});

Deno.test("bareFromImports: returns scoped bare specifiers", () => {
  assertEquals(
    bareFromImports(
      'import { Client } from "@aws-sdk/client-secrets-manager";',
    ),
    ["@aws-sdk/client-secrets-manager"],
  );
});

Deno.test("bareFromImports: collects multiple unique specifiers", () => {
  const source = `
import { z } from "zod";
import { decode } from "he";
import { z as z2 } from "zod";
`;
  const result = bareFromImports(source);
  assertEquals(result.sort(), ["he", "zod"]);
});

Deno.test("bareFromImports: ignores npm: prefixed imports", () => {
  assertEquals(
    bareFromImports('import { z } from "npm:zod@4";'),
    [],
  );
});

Deno.test("bareFromImports: ignores jsr: prefixed imports", () => {
  assertEquals(
    bareFromImports('import { assert } from "jsr:@std/assert";'),
    [],
  );
});

Deno.test("bareFromImports: ignores relative imports", () => {
  assertEquals(
    bareFromImports('import { helper } from "./helpers.ts";'),
    [],
  );
});

Deno.test("bareFromImports: ignores parent-relative imports", () => {
  assertEquals(
    bareFromImports('import { shared } from "../shared.ts";'),
    [],
  );
});

Deno.test("bareFromImports: ignores node: imports", () => {
  assertEquals(
    bareFromImports('import { readFile } from "node:fs";'),
    [],
  );
});

Deno.test("bareFromImports: ignores https: imports", () => {
  assertEquals(
    bareFromImports(
      'import { delay } from "https://deno.land/std@0.224.0/async/delay.ts";',
    ),
    [],
  );
});

Deno.test("bareFromImports: ignores http: imports", () => {
  assertEquals(
    bareFromImports('import { x } from "http://example.com/mod.ts";'),
    [],
  );
});

Deno.test("bareFromImports: returns empty for no bare specifiers", () => {
  const source = `
import { z } from "npm:zod@4";
import { helper } from "./helpers.ts";
export { foo } from "../shared.ts";
`;
  assertEquals(bareFromImports(source), []);
});

Deno.test("bareFromImports: handles re-exports", () => {
  assertEquals(
    bareFromImports('export { z } from "zod";'),
    ["zod"],
  );
});

// --- comment stripping regression tests (swamp-club#602) ---

Deno.test("bareFromImports: ignores quoted phrases in single-line comments", () => {
  const source = `import { z } from "npm:zod@4";

export function check() {
  // Distinguish "policy attached but unreadable" from "no policy". When
  // the value is absent it keeps its existing "no policy" behavior.
  return z.object({}).parse({});
}
`;
  assertEquals(bareFromImports(source), []);
});

Deno.test("bareFromImports: ignores from patterns in block comments", () => {
  const source = `import { z } from "npm:zod@4";

/*
 * This export is derived from "legacy-pkg" but we no longer
 * import from "legacy-pkg" directly.
 */
export function check() {
  return z.object({}).parse({});
}
`;
  assertEquals(bareFromImports(source), []);
});

Deno.test("bareFromImports: detects real bare imports adjacent to comments", () => {
  const source = `// this comment mentions "no policy"
import { z } from "zod";
`;
  assertEquals(bareFromImports(source), ["zod"]);
});

Deno.test("bareFromImports: preserves string literals containing //", () => {
  const source = `import { fetch } from "npm:undici@6";
const url = "https://example.com/api";
export function get() { return fetch(url); }
`;
  assertEquals(bareFromImports(source), []);
});

// --- string-literal false-positive regression tests (swamp-club#657) ---

Deno.test("bareFromImports: ignores from-pattern in template literal", () => {
  const source = `export function getAdvice(mode: string): string {
  if (mode === "flexible") {
    return \`You should upgrade from "flexible" to "full" for security\`;
  }
  return "";
}
`;
  assertEquals(bareFromImports(source), []);
});

Deno.test("bareFromImports: ignores from-pattern in single-quoted string", () => {
  const source = `export function logMessage(mode: string): void {
  const msg = 'Migrate from "flexible" to "full"';
  console.log(msg);
}
`;
  assertEquals(bareFromImports(source), []);
});

Deno.test("bareFromImports: ignores template interpolation as specifier", () => {
  const source = `export function getAdvice(mode: string): string {
  return \`You should migrate from "\${mode}" to "full"\`;
}
`;
  assertEquals(bareFromImports(source), []);
});

Deno.test("bareFromImports: real-world mixed imports with string false positives", () => {
  const source =
    `import { CloudflareClient } from "npm:@webframp/cloudflare@1.0.0";
import { z } from "npm:zod@4";

export function analyzeZones(client: CloudflareClient): Finding[] {
  const zones = client.getZones();
  for (const zone of zones) {
    const ssl = zone.sslMode;
    if (ssl === "off") {
      findings.push({ severity: "critical" });
    } else if (ssl === "flexible") {
      findings.push({
        severity: "warn",
        message: \`SSL mode is "flexible" — upgrade from "flexible" to "full"\`,
      });
    }
  }
  return findings;
}
`;
  assertEquals(bareFromImports(source), []);
});

Deno.test("hasBareImport: ignores from-pattern in string literals", () => {
  const source = `export function getMessage(): string {
  return 'Migrate from "flexible" to "full"';
}
`;
  assertEquals(hasBareImport(source), false);
});

Deno.test("bareFromImports: multi-line import spanning 4+ lines still detected", () => {
  const source = `import {
  foo,
  bar,
  baz,
  qux,
} from "zod";
`;
  assertEquals(bareFromImports(source), ["zod"]);
});

Deno.test("hasBareImport: ignores quoted phrases in comments", () => {
  const source = `import { z } from "npm:zod@4";

export function check() {
  // existing "no policy" behavior
  return z.object({}).parse({});
}
`;
  assertEquals(hasBareImport(source), false);
});

// --- generated-code false-positive regression tests (swamp-club#1490) ---

Deno.test("bareFromImports: ignores an interpolated specifier in generated code", () => {
  // The reported shape: an eval script built as a template literal, whose
  // second import resolves to a valid npm: specifier only at runtime.
  const source = `export function buildScript(pkg: string): string {
  return \`
import * as modeling from "npm:@jscad/modeling@2.12.0";
import * as serializer from "\${pkg}";
console.log(serializer, modeling);
\`;
}
`;
  assertEquals(bareFromImports(source), []);
});

Deno.test("bareFromImports: ignores a static bare specifier in generated code", () => {
  // No interpolation at all — the specifier is bare in the generated script,
  // which is the generated module's problem, not this module's.
  const source = `export function buildScript(): string {
  return \`import { z } from "zod";\`;
}
`;
  assertEquals(bareFromImports(source), []);
});

Deno.test("bareFromImports: detects a real bare import alongside generated code", () => {
  const source = `import { helper } from "my-helpers";

export function buildScript(pkg: string): string {
  return \`import * as s from "\${pkg}";\`;
}

export const h = helper;
`;
  assertEquals(bareFromImports(source), ["my-helpers"]);
});

Deno.test("bareFromImports: handles a nested template inside an interpolation", () => {
  const source = `export function buildScript(names: string[]): string {
  return \`\${names.map((n) => \`import "\${n}";\`).join("\\n")}\`;
}

import { z } from "zod";
`;
  assertEquals(bareFromImports(source), ["zod"]);
});

Deno.test("bareFromImports: handles object-literal braces inside an interpolation", () => {
  const source = `export function buildScript(): string {
  return \`config = \${JSON.stringify({ mode: "full" })};
import { x } from "generated";\`;
}

import { z } from "zod";
`;
  assertEquals(bareFromImports(source), ["zod"]);
});

Deno.test("bareFromImports: handles an unbalanced brace quoted inside an interpolation", () => {
  const source = `export function buildScript(): string {
  return \`\${"}"} import { x } from "generated";\`;
}

import { z } from "zod";
`;
  assertEquals(bareFromImports(source), ["zod"]);
});

Deno.test("bareFromImports: handles an escaped backtick inside a template", () => {
  const source = `export function buildScript(): string {
  return \`echo \\\` import { x } from "generated";\`;
}

import { z } from "zod";
`;
  assertEquals(bareFromImports(source), ["zod"]);
});

Deno.test("bareFromImports: still detects imports after a backtick in a regex literal", () => {
  // The scanner cannot recognise regex literals, so this backtick has no
  // closing partner. The span must be preserved verbatim rather than blanked,
  // or the real import below it would go unreported.
  const source = `const BACKTICK = /\`/;
import { z } from "zod";
`;
  assertEquals(bareFromImports(source), ["zod"]);
});

Deno.test("bareFromImports: preserves the tail after an unterminated template", () => {
  const source = `const broken = \`unterminated
import { z } from "zod";
`;
  // Degrades to the pre-fix reading rather than blanking the rest of the file.
  assertEquals(bareFromImports(source), ["zod"]);
});

Deno.test("hasBareImport: ignores an interpolated specifier in generated code", () => {
  const source = `export function buildScript(pkg: string): string {
  return \`import * as s from "\${pkg}";\`;
}
`;
  assertEquals(hasBareImport(source), false);
});

Deno.test("bareFromImports: ignores an interpolated specifier outside a template", () => {
  // Valid TypeScript — double quotes do not interpolate — so isBareSpecifier
  // must reject it on its own, without help from the template stripping.
  const source = `import * as s from "\${pkg}";`;
  assertEquals(bareFromImports(source), []);
});
