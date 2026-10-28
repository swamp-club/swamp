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

import { assertEquals, assertThrows } from "@std/assert";
import fc from "fast-check";
import { planShellPlacement, VaultSecretBag } from "./vault_secret_bag.ts";
import {
  deliveredJsonValue,
  holdsValue,
  isIssuedEntry,
  jsonEscaped,
  type RegistryEntry,
  SECRET_ENCODINGS,
  SecretBagRegistry,
  SENTINEL_EXACT,
} from "./secret_bag_registry.ts";
import { secretOccurrencesOf } from "./secret_occurrences.ts";

/** The reference every secret of these tests stands for. */
const REF = { vaultName: "v", key: "k" };

/**
 * Issues a vault.get() reference from `bag` whose key is the value a load
 * reads for it (see {@link loaded}).
 */
const issue = (bag: VaultSecretBag, value: string, vaultName = "v") =>
  bag.addSecret({ vaultName, key: value }, "test.location");

/**
 * `bag`'s delivery view, loaded as from a vault that holds each key as its
 * own value. Every vault reference of the run is loaded.
 */
function loaded(bag: VaultSecretBag): VaultSecretBag {
  const values = new Map<string, string>();
  for (const entry of bag.registry.all()) {
    if (isIssuedEntry(entry) && !entry.dataOrigin) {
      values.set(entry.sentinel, entry.reference.key);
    }
  }
  return bag.withLoaded(values);
}

/** An entry's own value: a data or shipped entry's, never a reference's. */
const ownValue = (entry: RegistryEntry) =>
  holdsValue(entry) ? entry.value : undefined;

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
      const s = issue(bag, "two  words *");
      const view = loaded(bag);
      const uses = quotes.map((quote) => use(s, quote));
      assertEquals(
        view.resolveForShell(uses.join(separator)).command,
        uses.map((u) => view.resolveForShell(u).command).join(separator),
      );
      assertEquals(
        view.resolveForPowerShell(uses.join("; ")).command,
        uses.map((u) => view.resolveForPowerShell(u).command).join("; "),
      );
    }),
  );
});

Deno.test("VaultSecretBag.resolveForShell: singleQuoted reports a vault.get sentinel when any occurrence is single-quoted", () => {
  fc.assert(
    fc.property(arbQuotes, arbSeparator, (quotes, separator) => {
      const bag = new VaultSecretBag(new SecretBagRegistry());
      const s = issue(bag, "from-vault");
      const command = quotes.map((quote) => use(s, quote)).join(separator);
      assertEquals(
        loaded(bag).resolveForShell(command).singleQuoted,
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
        const s = issue(bag, "two  words *");
        const body = fragments.flatMap((f) => f.lines).join("\n");
        const inString = fragments.flatMap((f) => f.inString);
        let use = 0;
        const expected = body.replaceAll(
          USE,
          () => inString[use++] ? "${__SWAMP_VAULT_0}" : '"${__SWAMP_VAULT_0}"',
        );
        assertEquals(
          loaded(bag).resolveForShell(
            `cat <<EOF\n${body.replaceAll(USE, s)}\nEOF`,
          ).command,
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

/**
 * Issues each entry from `bag` as vault.get or data origin, by `data`. A
 * vault.get entry is a reference whose key {@link loaded} reads as `value`.
 */
function issueAll(
  bag: VaultSecretBag,
  secrets: readonly {
    value: string;
    source: { vaultName: string; key: string };
  }[],
  data: readonly boolean[],
): string[] {
  return secrets.map(({ value, source }, i) =>
    data[i]
      ? bag.addDataSecret(value, source)
      : issue(bag, value, source.vaultName)
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
          return values.map(() => bag.addSecret(REF, "test.location"));
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
          assertEquals(loaded(view).resolveRaw(text), expected);
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
        assertEquals(
          loaded(target).resolveRaw(rehomed.text),
          loaded(source).resolveRaw(text),
        );
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
          assertEquals(ownValue(copy), ownValue(original));
          assertEquals(
            "location" in copy && copy.location,
            "location" in original && original.location,
          );
        });
        assertEquals(
          loaded(target).toEntries().length,
          new Set(
            before.map((s) =>
              registry.entryOf(s)!.dataOrigin
                ? `data:${ownValue(registry.entryOf(s)!)}`
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
        const own = issue(bag, value);
        const foreign = `__SWAMP_VSEC_${prefix}_${n}__`;
        fc.pre(foreign !== own);
        const text = `${foreign} ${own}`;
        assertEquals(loaded(bag).resolveRaw(text), `${foreign} ${value}`);
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

Deno.test("VaultSecretBag.withLoaded: a vault reference resolves only through a view that loaded it, and loading never changes the bag", () => {
  fc.assert(
    fc.property(
      fc.array(arbEntry, { minLength: 1, maxLength: 4 }),
      fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
      (secrets, loads) => {
        const registry = new SecretBagRegistry();
        const bag = new VaultSecretBag(registry);
        const sentinels = secrets.map(({ value, source }) =>
          issue(bag, value, source.vaultName)
        );
        const values = new Map(
          sentinels.flatMap((s, i) =>
            loads[i] ? [[s, secrets[i].value] as const] : []
          ),
        );
        const view = bag.withLoaded(values);
        sentinels.forEach((s, i) => {
          assertEquals(ownValue(registry.entryOf(s)!), undefined);
          assertThrows(() => bag.resolveRaw(s), Error, "was not loaded");
          if (values.has(s)) {
            assertEquals(view.resolveRaw(s), secrets[i].value);
          } else {
            assertThrows(() => view.resolveRaw(s), Error, "was not loaded");
          }
        });
        assertEquals(
          view.toEntries().map((entry) => entry.sentinel),
          sentinels.filter((s) => values.has(s)),
        );
        assertEquals(bag.toEntries(), []);
      },
    ),
  );
});

type Placement = Quote | "heredoc-literal";

/** One use of the sentinel, including a here-document with a quoted delimiter. */
function place(sentinel: string, placement: Placement): string {
  return placement === "heredoc-literal"
    ? `cat <<'EOF'\n${sentinel}\nEOF`
    : use(sentinel, placement);
}

const arbPlacements = fc.array(
  fc.constantFrom<Placement>("unquoted", "double", "single", "heredoc-literal"),
  { minLength: 1, maxLength: 6 },
);

const arbAuthoredKeys = fc.array(
  fc.constantFrom(
    "__SWAMP_VAULT_0",
    "__SWAMP_VAULT_1",
    "__SWAMP_VAULT_2",
    "PATH",
    "HOME",
  ),
  { maxLength: 4 },
);

Deno.test("planShellPlacement: the plan and the resolution agree on every occurrence, and generated names are unique and never authored (typed-secrets 3.4)", () => {
  fc.assert(
    fc.property(
      arbPlacements,
      arbSeparator,
      arbAuthoredKeys,
      fc.boolean(),
      (placements, separator, authored, dataOrigin) => {
        const registry = new SecretBagRegistry();
        const bag = new VaultSecretBag(registry);
        const s = dataOrigin
          ? bag.addDataSecret("s3cret", REF)
          : issue(bag, "s3cret");
        const command = placements.map((p) => place(s, p)).join(separator);
        const plan = planShellPlacement(
          command,
          authored,
          secretOccurrencesOf(registry).originOf,
        );
        const resolved = loaded(bag).resolveForShell(command, authored);
        const names = [...plan.envNames.values()];
        assertEquals(new Set(names).size, names.length);
        for (const name of names) assertEquals(authored.includes(name), false);
        assertEquals(resolved.envNames, plan.envNames);
        // Rebuilding the command from the plan is the resolution.
        let rebuilt = "";
        let last = 0;
        for (const o of plan.occurrences) {
          rebuilt += command.slice(last, o.start) +
            (o.placement === "refused" ? "s3cret" : o.text);
          last = o.end;
        }
        rebuilt += command.slice(last);
        assertEquals(resolved.command, rebuilt);
        assertEquals(resolved.dataInCommandLine, plan.refused.length > 0);
        assertEquals(resolved.singleQuoted, [...plan.singleQuoted]);
        // Only a data value in a quoted here-document is refused.
        assertEquals(
          plan.refused.length > 0,
          dataOrigin && placements.includes("heredoc-literal"),
        );
      },
    ),
  );
});

Deno.test("VaultSecretBag.resolveDeep: a sentinel delivers its text everywhere but a whole value of a JSON-value entry, which delivers the number or boolean its text holds (swamp-club#3967)", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.string(),
        fc.jsonValue().map((value) => JSON.stringify(value)),
      ),
      fc.boolean(),
      fc.string(),
      (text, jsonValue, prefix) => {
        const bag = new VaultSecretBag(new SecretBagRegistry());
        const sentinel = bag.addDataReference(REF, "field", jsonValue);
        const view = bag.withLoaded(new Map([[sentinel, text]]));
        const delivered = view.resolveDeep({
          whole: sentinel,
          list: [sentinel],
          embedded: `${prefix}${sentinel}!`,
        }) as Record<string, unknown>;
        const whole = jsonValue ? deliveredJsonValue(text) : text;
        assertEquals(delivered.whole, whole);
        assertEquals(delivered.list, [whole]);
        assertEquals(delivered.embedded, `${prefix}${text}!`);
        assertEquals(view.resolveRaw(sentinel), text);
      },
    ),
  );
});

/** One secret of a run, issued the way `kind` names, over a vault value. */
const arbIssued = fc.record({
  kind: fc.constantFrom(
    "vault",
    "dataReference",
    "written",
    "dataSecret",
  ),
  value: fc.oneof(
    fc.string({ minLength: 3, maxLength: 12 }),
    fc.jsonValue().map((value) => JSON.stringify(value)),
  ),
  encoding: fc.constantFrom(...SECRET_ENCODINGS),
  dataOrigin: fc.boolean(),
  jsonValue: fc.boolean(),
});

Deno.test("VaultSecretBag.referenceEntriesFor: a worker that loads the shipped references delivers exactly what the plaintext frame delivered, in every encoding (typed-secrets 5.2)", () => {
  fc.assert(
    fc.property(
      fc.array(arbIssued, { minLength: 1, maxLength: 6 }),
      fc.array(fc.nat({ max: 5 }), { minLength: 1, maxLength: 8 }),
      fc.string({ maxLength: 4 }),
      (secrets, uses, filler) => {
        const bag = new VaultSecretBag(new SecretBagRegistry());
        // The vault holds each secret's value under a key of its own.
        const vault = new Map<string, string>();
        const sentinels = secrets.map((secret, i) => {
          const reference = { vaultName: "v", key: `k${i}` };
          vault.set(reference.key, secret.value);
          switch (secret.kind) {
            case "vault":
              return bag.addSecret(reference, `at ${i}`);
            case "dataReference":
              return bag.addDataReference(
                reference,
                `field ${i}`,
                secret.jsonValue,
              );
            case "written":
              return bag.addWrittenReference(
                reference,
                secret.encoding,
                secret.dataOrigin,
                `record ${i}`,
                secret.jsonValue,
              );
            default:
              // A data entry holds the value in its encoding's form.
              return secret.encoding === "json"
                ? bag.addDataSecret(
                  jsonEscaped(secret.value),
                  reference,
                  "json",
                  secret.jsonValue,
                )
                : bag.addDataSecret(
                  secret.value,
                  reference,
                  "raw",
                  secret.jsonValue,
                );
          }
        });
        const used = uses.map((i) => sentinels[i % sentinels.length]);
        const args = {
          methodArgs: {
            whole: used[0],
            text: used.join(filler),
            list: used,
          },
          globalArgs: { embedded: `${filler}${used[used.length - 1]}!` },
        };
        const loadedValues = (target: VaultSecretBag) => {
          const values = new Map<string, string>();
          for (const entry of target.registry.all()) {
            if (isIssuedEntry(entry) && !holdsValue(entry)) {
              values.set(entry.sentinel, vault.get(entry.reference.key)!);
            }
          }
          return values;
        };

        // Today: the orchestrator loads, then ships values a worker rebuilds.
        const shippedView = bag.withLoaded(loadedValues(bag));
        const plaintext = VaultSecretBag.fromEntries(
          shippedView.entriesFor(args),
        ).resolveDeep(args);

        // Version 6: references ship, and the worker loads them itself.
        const shipped = bag.referenceEntriesFor(args);
        assertEquals(
          shipped.map((entry) => entry.reference),
          bag.referencesFor(args),
        );
        for (const entry of shipped) {
          assertEquals("value" in entry, false);
        }
        const rebuilt = VaultSecretBag.fromReferenceEntries(shipped);
        const delivered = rebuilt.withLoaded(loadedValues(rebuilt))
          .resolveDeep(args);

        assertEquals(delivered, plaintext);
      },
    ),
  );
});

Deno.test("VaultSecretBag.fromReferenceEntries: delivers nothing until loaded, and refuses a malformed or repeated sentinel", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const sentinel = bag.addSecret(REF, "methodArguments.token");
  const [entry] = bag.referenceEntriesFor({ token: sentinel });
  assertEquals(entry, {
    sentinel,
    reference: REF,
    encoding: "raw",
    dataOrigin: false,
    location: "methodArguments.token",
  });
  const rebuilt = VaultSecretBag.fromReferenceEntries([entry]);
  assertThrows(() => rebuilt.resolveRaw(sentinel), Error, "was not loaded");
  assertEquals(
    rebuilt.withLoaded(new Map([[sentinel, "s3cret"]])).resolveRaw(sentinel),
    "s3cret",
  );
  assertThrows(
    () =>
      VaultSecretBag.fromReferenceEntries([{ ...entry, sentinel: "$(id)" }]),
    Error,
    "Malformed",
  );
  assertThrows(
    () => VaultSecretBag.fromReferenceEntries([entry, entry]),
    Error,
    "Repeated",
  );
});
