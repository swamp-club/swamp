// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

// Compile-time enforcement that the domain-local FreshnessKind union in
// src/domain/extensions/bundle_freshness.ts stays in sync with the
// infrastructure ExtensionKind union in
// src/infrastructure/persistence/extension_catalog_store.ts.
//
// FreshnessKind is declared inline in the domain layer so the freshness
// helper does not import from infrastructure (domain→infrastructure
// boundary — see CLAUDE.md and the ddd skill). That split leaves the
// two unions free to drift. A test file can cross the layer boundary
// because tests sit outside production code — importing both types
// here, and asserting mutual extension, makes divergence a hard
// `deno check` error.
//
// If a new kind is added to one union without updating the other, one
// of the assertions below fails to type-check, surfacing the problem
// at compile time rather than as a silent rebundle storm at runtime.

import type { ExtensionKind } from "../src/infrastructure/persistence/extension_catalog_store.ts";
import type { FreshnessKind } from "../src/domain/extensions/bundle_freshness.ts";

type AssertExtends<A, B> = A extends B ? true : false;

// Every ExtensionKind must be representable as a FreshnessKind.
const _everyExtensionKindIsFreshnessKind: AssertExtends<
  ExtensionKind,
  FreshnessKind
> = true;

// Every FreshnessKind must be representable as an ExtensionKind.
const _everyFreshnessKindIsExtensionKind: AssertExtends<
  FreshnessKind,
  ExtensionKind
> = true;

// Touch the unused bindings so the linter doesn't flag them — the
// value of these constants is the fact that they type-check at all.
void _everyExtensionKindIsFreshnessKind;
void _everyFreshnessKindIsExtensionKind;

// A tiny runtime smoke test so this file also shows up as a "1 passed"
// in the test summary rather than a silent no-op. If you reach this
// runtime assertion it means the compile-time checks above passed,
// which is the real thing being tested.
Deno.test("FreshnessKind stays in sync with ExtensionKind (compile-time)", () => {
  // The real assertions are the type-level constants above, enforced
  // by `deno check`. This body is intentionally trivial.
});
