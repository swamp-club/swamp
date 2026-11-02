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

// FreshnessKind is inline in the domain to avoid importing infrastructure;
// asserting mutual extension with ExtensionKind here makes drift a type-check
// error, not a silent rebundle storm

import type { ExtensionKind } from "../src/infrastructure/persistence/extension_catalog_store.ts";
import type { FreshnessKind } from "../src/domain/extensions/bundle_freshness.ts";

type AssertExtends<A, B> = A extends B ? true : false;

const _everyExtensionKindIsFreshnessKind: AssertExtends<
  ExtensionKind,
  FreshnessKind
> = true;

const _everyFreshnessKindIsExtensionKind: AssertExtends<
  FreshnessKind,
  ExtensionKind
> = true;

// touched so the linter does not flag the unused bindings; their value is that
// they type-check
void _everyExtensionKindIsFreshnessKind;
void _everyFreshnessKindIsExtensionKind;

// runtime smoke test so the file shows as passed rather than a silent no-op;
// reaching it means the compile-time checks passed
Deno.test("FreshnessKind stays in sync with ExtensionKind (compile-time)", () => {
  // The real assertions are the type-level constants above, enforced
  // by `deno check`. This body is intentionally trivial.
});
