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
import fc from "fast-check";
import { VaultSecretBag } from "./vault_secret_bag.ts";
import { SecretBagRegistry, SENTINEL_EXACT } from "./secret_bag_registry.ts";

/** The reference every secret of these tests stands for. */
const REF = { vaultName: "v", key: "k" };

type Quote = "unquoted" | "double" | "single";

/** One use of the sentinel, wrapped the way `quote` names. */
function use(sentinel: string, quote: Quote): string {
  switch (quote) {
    case "double":
      return `echo "${sentinel}"`;
    case "single":
      return `echo '${sentinel}'`;
    default:
      return `echo ${sentinel}`;
  }
}

const arbQuotes = fc.array(
  fc.constantFrom<Quote>("unquoted", "double", "single"),
  { minLength: 1, maxLength: 6 },
);

/** Separators between uses, some with comments holding stray quotes. */
const arbSeparator = fc.constantFrom(
  "; ",
  "\n",
  "\n# don't log it\n",
  '\n# say "hi\n',
  "\ncat <<EOF\nit's\nEOF\n",
);

Deno.test("VaultSecretBag.resolveForShell: a vault.get reference depends only on its own occurrence's quote context", () => {
  fc.assert(
    fc.property(arbQuotes, arbSeparator, (quotes, separator) => {
      const bag = new VaultSecretBag(new SecretBagRegistry());
      const s = bag.addSecret("two  words *", REF);
      const uses = quotes.map((quote) => use(s, quote));
      assertEquals(
        bag.resolveForShell(uses.join(separator)).command,
        uses.map((u) => bag.resolveForShell(u).command).join(separator),
      );
      assertEquals(
        bag.resolveForPowerShell(uses.join("; ")).command,
        uses.map((u) => bag.resolveForPowerShell(u).command).join("; "),
      );
    }),
  );
});

Deno.test("VaultSecretBag.resolveForShell: singleQuoted reports a vault.get sentinel when any occurrence is single-quoted", () => {
  fc.assert(
    fc.property(arbQuotes, arbSeparator, (quotes, separator) => {
      const bag = new VaultSecretBag(new SecretBagRegistry());
      const s = bag.addSecret("from-vault", REF);
      const command = quotes.map((quote) => use(s, quote)).join(separator);
      assertEquals(
        bag.resolveForShell(command).singleQuoted,
        quotes.includes("single") ? [s] : [],
      );
    }),
  );
});

/**
 * A here-document body fragment. `inString` records, per vault.get use in
 * the fragment, whether the reference must stay bare: the author placed it
 * inside a double- or single-quoted string.
 */
interface BodyFragment {
  lines: string[];
  inString: boolean[];
}

const fragment = (lines: string[], inString: boolean[] = []): BodyFragment => ({
  lines,
  inString,
});

const USE = "@USE@";

const arbBodyFragment = fc.constantFrom<BodyFragment>(
  fragment(["it's here"]),
  fragment(["# Don't commit this file"]),
  fragment([`don't say "it's" twice`]),
  fragment([`he said "hi" and left`]),
  fragment([`screen is 5" wide`]),
  fragment([`tr -d '"' < in > out`]),
  fragment([`sed 's/"//g' f`]),
  fragment([`IFS='"'`]),
  fragment([`grep -c '"' f`]),
  fragment([`x='a"b'`]),
  fragment([`echo "it's"`]),
  fragment([`{"a": "x\\"y"}`]),
  fragment([`{"k": "${USE}"}`], [true]),
  fragment([`KEY="${USE}"`], [true]),
  fragment([`--opt="${USE}"`], [true]),
  fragment([`raw ${USE}`], [false]),
  fragment([`set -- ${USE}`], [false]),
  fragment([`echo "line1`, `${USE}"`], [true]),
  fragment([`echo "line1`, `it's in the string`, `${USE}"`], [true]),
  fragment([`msg="first`, `second ${USE} third"`], [true]),
  fragment([`mysql -u root -p"${USE}" db`], [true]),
  fragment([`cmd >"${USE}"`], [true]),
  fragment([`echo 'prefix: '"${USE}"`], [true]),
  fragment([`echo "a""${USE}"`], [true]),
  fragment([`echo foo"bar ${USE}"`], [true]),
  fragment([`PASS='${USE}'`], [true]),
  fragment([`a 3" gap here`]),
  fragment([`ENV API_KEY=${USE}`], [false]),
);

Deno.test("VaultSecretBag.resolveForShell: a vault.get use in a here-document body is bare exactly when the author's text has it in a double-quoted string", () => {
  fc.assert(
    fc.property(
      fc.array(arbBodyFragment, { minLength: 1, maxLength: 7 }),
      (fragments) => {
        const bag = new VaultSecretBag(new SecretBagRegistry());
        const s = bag.addSecret("two  words *", REF);
        const body = fragments.flatMap((f) => f.lines).join("\n");
        const inString = fragments.flatMap((f) => f.inString);
        let use = 0;
        const expected = body.replaceAll(
          USE,
          () => inString[use++] ? "${__SWAMP_VAULT_0}" : '"${__SWAMP_VAULT_0}"',
        );
        assertEquals(
          bag.resolveForShell(`cat <<EOF\n${body.replaceAll(USE, s)}\nEOF`)
            .command,
          `cat <<EOF\n${expected}\nEOF`,
        );
      },
    ),
  );
});

/** A sensitive value with the vault reference it was read from. */
const arbEntry = fc.record({
  value: fc.string({ minLength: 3, maxLength: 12 }),
  source: fc.record({
    vaultName: fc.constantFrom("prod", "staging"),
    key: fc.stringMatching(/^[a-z]{1,8}$/),
  }),
});

/** Issues each entry from `bag` as vault.get or data origin, by `data`. */
function issueAll(
  bag: VaultSecretBag,
  secrets: readonly {
    value: string;
    source: { vaultName: string; key: string };
  }[],
  data: readonly boolean[],
): string[] {
  return secrets.map(({ value, source }, i) =>
    data[i] ? bag.addDataSecret(value, source) : bag.addSecret(value, source)
  );
}

Deno.test("VaultSecretBag: every sentinel has a 32-hex prefix and is unique across the bags of one registry", () => {
  fc.assert(
    fc.property(
      fc.array(fc.array(fc.string({ maxLength: 6 }), { maxLength: 5 }), {
        minLength: 1,
        maxLength: 4,
      }),
      (valuesPerBag) => {
        const registry = new SecretBagRegistry();
        const issued = valuesPerBag.flatMap((values) => {
          const bag = new VaultSecretBag(registry);
          return values.map((value) => bag.addSecret(value, REF));
        });
        for (const sentinel of issued) {
          assertEquals(SENTINEL_EXACT.test(sentinel), true);
          assertEquals(
            /^__SWAMP_VSEC_[0-9a-f]{32}_\d+__$/.test(sentinel),
            true,
          );
          assertEquals(registry.drewPrefixOf(sentinel), true);
        }
        assertEquals(new Set(issued).size, issued.length);
      },
    ),
  );
});

Deno.test("VaultSecretBag: a sentinel issued by any bag of a registry resolves from every bag of it", () => {
  fc.assert(
    fc.property(
      fc.array(arbEntry, { minLength: 1, maxLength: 4 }),
      fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
      fc.integer({ min: 1, max: 3 }),
      (secrets, data, bags) => {
        const registry = new SecretBagRegistry();
        const views = Array.from(
          { length: bags },
          () => new VaultSecretBag(registry),
        );
        const sentinels = secrets.map((secret, i) =>
          issueAll(views[i % bags], [secret], [data[i]])[0]
        );
        const text = sentinels.map((s) => `<${s}>`).join("|");
        const expected = secrets.map((s) => `<${s.value}>`).join("|");
        for (const view of views) {
          assertEquals(view.resolveRaw(text), expected);
          assertEquals(view.resolvesAny, true);
        }
        assertEquals(
          views.map((view) => view.isEmpty),
          views.map((_view, i) => secrets.length <= i),
        );
      },
    ),
  );
});

Deno.test("VaultSecretBag.rehomeSentinels: one target sentinel per source sentinel, with the same reference, encoding, origin and value", () => {
  fc.assert(
    fc.property(
      fc.array(arbEntry, { minLength: 1, maxLength: 4 }),
      fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
      fc.array(fc.nat({ max: 3 }), { minLength: 1, maxLength: 8 }),
      (secrets, data, uses) => {
        const registry = new SecretBagRegistry();
        const source = new VaultSecretBag(registry);
        const target = new VaultSecretBag(registry);
        const sentinels = issueAll(source, secrets, data);
        const text = uses.map((i) => sentinels[i % sentinels.length]).join(
          " ",
        );
        const rehomed = source.rehomeSentinels(
          { text, list: [text] },
          target,
        ) as { text: string; list: string[] };
        assertEquals(rehomed.list[0], rehomed.text);
        assertEquals(target.resolveRaw(rehomed.text), source.resolveRaw(text));
        const pairs = new Map<string, string>();
        const before = text.split(" ");
        const after = rehomed.text.split(" ");
        before.forEach((from, i) => {
          const to = after[i];
          assertEquals(pairs.get(from) ?? to, to);
          pairs.set(from, to);
          assertEquals(source.entryOf(from)?.sentinel === from, true);
          assertEquals(to !== from, true);
          const original = registry.issuedEntryOf(from)!;
          const copy = registry.issuedEntryOf(to)!;
          assertEquals(copy.reference, original.reference);
          assertEquals(copy.encoding, original.encoding);
          assertEquals(copy.dataOrigin, original.dataOrigin);
          assertEquals(copy.value, original.value);
        });
        assertEquals(
          target.toEntries().length,
          new Set(
            before.map((s) =>
              registry.entryOf(s)!.dataOrigin
                ? `data:${registry.entryOf(s)!.value}`
                : s
            ),
          ).size,
        );
      },
    ),
  );
});

Deno.test("VaultSecretBag: sentinel-shaped text with a prefix no bag of the run drew is ordinary text", () => {
  fc.assert(
    fc.property(
      fc.stringMatching(/^[0-9a-f]{32}$/),
      fc.nat({ max: 99 }),
      fc.string({ minLength: 3, maxLength: 8 }),
      (prefix, n, value) => {
        const registry = new SecretBagRegistry();
        const bag = new VaultSecretBag(registry);
        const own = bag.addSecret(value, REF);
        const foreign = `__SWAMP_VSEC_${prefix}_${n}__`;
        fc.pre(foreign !== own);
        const text = `${foreign} ${own}`;
        assertEquals(bag.resolveRaw(text), `${foreign} ${value}`);
        assertEquals(bag.entryOf(foreign), undefined);
        assertEquals(
          registry.drewPrefixOf(foreign),
          own.includes(`_${prefix}_`),
        );
        assertEquals(bag.resolveForShell(`echo ${foreign}`).env, {});
      },
    ),
  );
});
