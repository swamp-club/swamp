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
import {
  alignProvenance,
  alignStrings,
  ancestorsOf,
  canonicalPath,
  keyPath,
  mergeRanges,
  ProvenanceMap,
  routedGlobalProvenance,
  sentinelIdentityOf,
  sentinelStandInOf,
} from "./provenance_map.ts";
import { sensitiveSpliceSanitizer } from "./splice_pair.ts";
import { RunSensitiveValues } from "../secrets/mod.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import { SecretBagRegistry } from "../vaults/secret_bag_registry.ts";
import { workflowInputsProvenance } from "../workflows/input_provenance.ts";
import { Workflow } from "../workflows/workflow.ts";
import { Job } from "../workflows/job.ts";
import { Step } from "../workflows/step.ts";
import { StepTask } from "../workflows/step_task.ts";
import {
  AUTHORED_ORIGIN,
  extractExpressions,
  readSetMap,
  replaceExpressionsTracked,
} from "./expression_parser.ts";
import { partitionAuthoredAt } from "./expression_evaluation_service.ts";
import { staticAccessPath } from "./cel_grammar.ts";
import { attachBindingProvenance, spliceOrigin } from "./splice_origin.ts";

/** The reference every secret of these tests stands for. */
const REF = { vaultName: "v", key: "k" };

Deno.test("ProvenanceMap.overlapsData: partial overlap counts, adjacency does not", () => {
  const map = ProvenanceMap.authored().withRanges("a.b", [[4, 10]]);
  assertEquals(map.overlapsData("a.b", 0, 4), false);
  assertEquals(map.overlapsData("a.b", 3, 5), true);
  assertEquals(map.overlapsData("a.b", 9, 12), true);
  assertEquals(map.overlapsData("a.b", 10, 12), false);
  assertEquals(map.overlapsData("a.c", 4, 10), false);
});

Deno.test("ProvenanceMap: whole data covers every descendant", () => {
  const map = ProvenanceMap.authored().withWholeData("inputs.text");
  assertEquals(map.isWholeDataAt("inputs.text"), true);
  assertEquals(map.isWholeDataAt("inputs.text.deep[2]"), true);
  assertEquals(map.overlapsData("inputs.text[0]", 0, 1), true);
  assertEquals(map.isWholeDataAt("inputs"), false);
  assertEquals(map.hasDataAtOrBelow("inputs"), true);
});

Deno.test("ProvenanceMap.subtree and graft re-root paths", () => {
  const map = ProvenanceMap.authored()
    .withRanges("jobs[0].steps[1].task.inputs.x", [[0, 3]])
    .withWholeData("jobs[0].steps[1].guard");
  const step = map.subtree("jobs[0].steps[1]");
  assertEquals(step.rangesAt("task.inputs.x"), [[0, 3]]);
  assertEquals(step.isWholeDataAt("guard"), true);
  const moved = ProvenanceMap.authored().graft("jobs[2].steps[0]", step);
  assertEquals(moved.rangesAt("jobs[2].steps[0].task.inputs.x"), [[0, 3]]);
  // A graft replaces what was there.
  assertEquals(
    map.graft("jobs[0].steps[1]", ProvenanceMap.authored()).isAuthored,
    true,
  );
});

Deno.test("ProvenanceMap.graftAll equals repeated grafts on disjoint paths", () => {
  const base = ProvenanceMap.authored()
    .withRanges("a", [[0, 1]])
    .withWholeData("b.c")
    .withRanges("d[0]", [[2, 3]]);
  const entries: [string, ProvenanceMap][] = [
    ["a", ProvenanceMap.data()],
    ["b", ProvenanceMap.authored()],
    ["e", ProvenanceMap.authored().withRanges("", [[1, 2]])],
  ];
  let sequential = base;
  for (const [path, sub] of entries) sequential = sequential.graft(path, sub);
  assertEquals(base.graftAll(entries).toData(), sequential.toData());
});

Deno.test("ProvenanceMap.fromData refuses a malformed map", () => {
  assertThrows(() => ProvenanceMap.fromData("not-a-map"));
  assertThrows(() =>
    ProvenanceMap.fromData({ whole: [], ranges: { a: [[5, 1]] } })
  );
});

Deno.test("ProvenanceMap: toData/fromData round-trips (property)", () => {
  const path = fc.oneof(
    fc.constantFrom("__proto__", "constructor", "prototype"),
    fc.stringMatching(/^[a-z]{1,3}(\.[a-z]{1,3}|\[[0-9]\]){0,3}$/),
  );
  const range = fc.tuple(fc.nat(50), fc.nat(50)).map(([a, b]) =>
    [Math.min(a, b), Math.max(a, b)] as [number, number]
  );
  fc.assert(
    fc.property(
      fc.array(path, { maxLength: 4 }),
      fc.array(fc.tuple(path, fc.array(range, { maxLength: 3 })), {
        maxLength: 4,
      }),
      fc.array(path, { maxLength: 3 }),
      (whole, ranged, keyed) => {
        let map = ProvenanceMap.authored();
        for (const [p, r] of ranged) map = map.withRanges(p, r);
        map = map.union(ProvenanceMap.fromEntries([], [], keyed));
        for (const p of whole) map = map.withWholeData(p);
        const back = ProvenanceMap.fromData(
          JSON.parse(JSON.stringify(map.toData())),
        );
        assertEquals(back.toData(), map.toData());
      },
    ),
  );
});

Deno.test("mergeRanges: sorts, merges overlaps and drops empty ranges", () => {
  assertEquals(mergeRanges([[5, 8], [0, 2], [1, 3], [9, 9]]), [[0, 3], [
    5,
    8,
  ]]);
});

Deno.test("replaceExpressionsTracked: a data copy of an authored raw is never substituted", () => {
  const raw = "${{ env.SECRET }}";
  const text = `ok ${raw} x ${raw}`;
  // The second occurrence came from data.
  const dataStart = text.lastIndexOf(raw);
  const map = ProvenanceMap.authored().withRanges("v", [[
    dataStart,
    text.length,
  ]]);
  const result = replaceExpressionsTracked(
    { v: text },
    new Map([[raw, "S"]]),
    map,
    () => AUTHORED_ORIGIN,
  );
  assertEquals((result.data as { v: string }).v, `ok S x ${raw}`);
  // The surviving data copy is still data, shifted to its new offset.
  const out = (result.data as { v: string }).v;
  assertEquals(
    result.provenance.overlapsData("v", out.indexOf(raw), out.length),
    true,
  );
});

Deno.test("replaceExpressionsTracked: spliced data is marked at its new offset", () => {
  const result = replaceExpressionsTracked(
    { v: "a ${{ inputs.text }} b" },
    new Map([["${{ inputs.text }}", "DATA"]]),
    ProvenanceMap.authored(),
    () => ({ map: ProvenanceMap.data() }),
  );
  assertEquals((result.data as { v: string }).v, "a DATA b");
  assertEquals(result.provenance.rangesAt("v"), [[2, 6]]);
});

Deno.test("replaceExpressionsTracked: an embedded object takes the read-set rule", () => {
  const value = { note: "${{ env.SECRET }}", other: "${{ env.OTHER }}" };
  const result = replaceExpressionsTracked(
    { v: "cfg: ${{ inputs.obj }}" },
    new Map([["${{ inputs.obj }}", value]]),
    ProvenanceMap.authored(),
    () => ({
      map: ProvenanceMap.data(),
      authoredRaws: new Set(["${{ env.OTHER }}"]),
    }),
  );
  const out = (result.data as { v: string }).v;
  const secret = out.indexOf("${{ env.SECRET }}");
  const other = out.indexOf("${{ env.OTHER }}");
  assertEquals(result.provenance.overlapsData("v", secret, secret + 17), true);
  assertEquals(result.provenance.overlapsData("v", other, other + 16), false);
});

Deno.test("staticAccessPath: chains of field and literal index only", () => {
  assertEquals(staticAccessPath("inputs.token"), {
    root: "inputs",
    segments: ["token"],
  });
  assertEquals(staticAccessPath('self["globalArguments"].a[0]'), {
    root: "self",
    segments: ["globalArguments", "a", 0],
  });
  assertEquals(staticAccessPath("inputs[k]"), undefined);
  assertEquals(staticAccessPath('"x" + inputs.a'), undefined);
});

Deno.test("spliceOrigin: a direct read carries the binding's map", () => {
  const ctx = attachBindingProvenance(
    { model: {}, env: {}, inputs: { a: "${{ env.X }}", b: "${{ env.X }}" } },
    { inputs: ProvenanceMap.authored().withWholeData("b") },
  );
  assertEquals(
    spliceOrigin("inputs.a", ctx, "${{ env.X }}").map.isAuthored,
    true,
  );
  assertEquals(
    spliceOrigin("inputs.b", ctx, "${{ env.X }}").map.isWholeData,
    true,
  );
  // Data namespaces are data.
  assertEquals(
    spliceOrigin('data.latest("m", "d")', ctx, "${{ env.X }}").map.isAuthored,
    false,
  );
});

Deno.test("spliceOrigin: a computed result is authored only where the read set vouches", () => {
  const ctx = attachBindingProvenance(
    {
      model: {},
      env: {},
      inputs: { token: "${{ env.X }}", text: "${{ env.Y }}" },
    },
    { inputs: ProvenanceMap.authored().withWholeData("text") },
  );
  const value = "Bearer ${{ env.X }} ${{ env.Y }}";
  const origin = spliceOrigin(
    '"Bearer " + inputs.token + " " + inputs.text',
    ctx,
    value,
  );
  const x = value.indexOf("${{ env.X }}");
  const y = value.indexOf("${{ env.Y }}");
  assertEquals(origin.map.overlapsData("", x, x + 12), false);
  assertEquals(origin.map.overlapsData("", y, y + 12), true);
});

Deno.test("alignProvenance: a differing value carries its data onto the other copy", () => {
  const map = ProvenanceMap.authored().withRanges("a", [[0, 2]]).withRanges(
    "b",
    [[0, 1]],
  ).withRanges("n", [[0, 1]]);
  const aligned = alignProvenance(
    map,
    { a: "xxyy", b: "z", c: "same", n: "1" },
    { a: "__SENTINEL__yy", b: "z", c: "same", n: 1 },
  );
  // The replaced span is data, the unchanged suffix keeps its standing.
  assertEquals(aligned.rangesAt("a"), [[0, 12]]);
  assertEquals(aligned.rangesAt("b"), [[0, 1]]);
  // A value that changed type is data in its entirety.
  assertEquals(aligned.isWholeDataAt("n"), true);
});

Deno.test("alignProvenance: only the differing span of a string becomes data", () => {
  // "S3CRET" was spliced from data; the sanitized copy holds a sentinel.
  const raw = "Bearer S3CRET ${{ env.X }}";
  const other = "Bearer __SWAMP_VAULT_0__ ${{ env.X }}";
  const map = ProvenanceMap.authored().withRanges("v", [[7, 13]]);
  const aligned = alignProvenance(map, { v: raw }, { v: other });
  const env = other.indexOf("${{ env.X }}");
  assertEquals(aligned.overlapsData("v", 7, 9), true);
  assertEquals(aligned.overlapsData("v", env, env + 12), false);
});

Deno.test("routedGlobalProvenance: a coerced value with data is whole data", () => {
  const map = routedGlobalProvenance(
    { count: 3, label: "x" },
    { count: "3", label: "x" },
    ProvenanceMap.authored().withRanges("count", [[0, 1]]).withRanges(
      "label",
      [[0, 1]],
    ),
  );
  assertEquals(map.isWholeDataAt("count"), true);
  assertEquals(map.rangesAt("label"), [[0, 1]]);
});

Deno.test("replaceExpressionsTracked: a sanitizer's clone keeps data positional in the sanitized copy", () => {
  const token = "${{ env.TOKEN }}";
  const values = new RunSensitiveValues();
  values.addSecret("s3cret-value", { vaultName: "v", key: "k" });
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const cfg = { a: token, b: token, c: "uses s3cret-value" };
  const result = replaceExpressionsTracked(
    { v: "${{ inputs.cfg }}" },
    new Map([["${{ inputs.cfg }}", cfg]]),
    ProvenanceMap.authored(),
    () => ({
      map: ProvenanceMap.authored().withWholeData("b"),
      authoredRaws: new Set([token]),
    }),
    undefined,
    sensitiveSpliceSanitizer(values, bag),
  );
  assertEquals(result.provenance.isWholeDataAt("v.b"), true);
  assertEquals(result.provenance.hasDataAtOrBelow("v.a"), false);
});

Deno.test("alignStrings: sentinels resolve through the bag, so authored text between them keeps its standing", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const one = bag.addDataSecret("pw1secret", REF);
  const two = bag.addDataSecret("pw2secret", REF);
  const raw = "pw1secret ${{ env.A }} pw2secret";
  const sanitized = `${one} \${{ env.A }} ${two}`;
  const aligned = alignStrings(
    [[0, 9], [23, 32]],
    raw,
    sanitized,
    undefined,
    sentinelStandInOf(bag.registry),
  );
  const env = sanitized.indexOf("${{ env.A }}");
  assertEquals(
    aligned.some(([s, e]) => s < env + 12 && env < e),
    false,
  );
  assertEquals(aligned.length, 2);
});

Deno.test("keyPath: keys that are not plain segments are quoted, matching extraction", () => {
  assertEquals(keyPath("x", "a"), "x.a");
  assertEquals(keyPath("x", "a.b"), 'x["a.b"]');
  assertEquals(keyPath("x", "[0]"), 'x["[0]"]');
  assertEquals(keyPath("", "a.b"), '["a.b"]');
  assertEquals(
    extractExpressions({ x: { "a.b": "${{ y }}", "[0]": "${{ z }}" } })
      .map((e) => e.path),
    ['x["a.b"]', 'x["[0]"]'],
  );
});

Deno.test("ProvenanceMap: a sibling graft cannot erase a dotted key's data", () => {
  const map = ProvenanceMap.authored()
    .withWholeData(keyPath("cfg", "a.b"))
    .graft(keyPath("cfg", "a"), ProvenanceMap.authored());
  assertEquals(map.isWholeDataAt(keyPath("cfg", "a.b")), true);
  assertEquals(map.isWholeDataAt(keyPath("cfg", "a")), false);
  // A quoted segment is one segment: its dots are not boundaries.
  assertEquals([...ancestorsOf('cfg["a.b"].c')], [
    'cfg["a.b"].c',
    'cfg["a.b"]',
    "cfg",
    "",
  ]);
});

Deno.test("provenance: an object key starting with a bracket cannot hide data from the gate", () => {
  const vault = "${{ vault.get('prod', 'k') }}";
  const workflow = Workflow.create({
    name: "w",
    inputs: {
      type: "object",
      properties: { x: { type: "object" } },
    },
    jobs: [Job.create({
      name: "main",
      steps: [Step.create({
        name: "s",
        task: StepTask.modelMethod("m", "run"),
      })],
    })],
  });
  const inputs = { x: { "[0]": vault } };
  const ctx = attachBindingProvenance(
    { model: {}, env: {}, inputs },
    { inputs: workflowInputsProvenance(inputs, workflow) },
  );
  const tracked = replaceExpressionsTracked(
    { methodArgs: { foo: "${{ inputs.x }}" } },
    new Map([["${{ inputs.x }}", inputs.x]]),
    ProvenanceMap.authored(),
    () => spliceOrigin("inputs.x", ctx, inputs.x),
  );
  const allowed = partitionAuthoredAt(
    extractExpressions(tracked.data),
    new Set([vault]),
    tracked.provenance,
  );
  assertEquals(allowed, []);
});

Deno.test("spliceOrigin: data fragments stay data even without a whole expression", () => {
  const ctx = attachBindingProvenance(
    { model: {}, env: {}, inputs: { a: "${{ env.HOME", b: " }}" } },
    { inputs: ProvenanceMap.data() },
  );
  const tracked = replaceExpressionsTracked(
    { cmd: "${{ inputs.a }}${{ inputs.b }}" },
    new Map<string, unknown>([
      ["${{ inputs.a }}", "${{ env.HOME"],
      ["${{ inputs.b }}", " }}"],
    ]),
    ProvenanceMap.authored(),
    (raw) =>
      spliceOrigin(
        raw === "${{ inputs.a }}" ? "inputs.a" : "inputs.b",
        ctx,
        raw === "${{ inputs.a }}" ? "${{ env.HOME" : " }}",
      ),
  );
  assertEquals((tracked.data as { cmd: string }).cmd, "${{ env.HOME }}");
  assertEquals(
    partitionAuthoredAt(
      extractExpressions(tracked.data),
      new Set(["${{ env.HOME }}"]),
      tracked.provenance,
    ),
    [],
  );
});

Deno.test("provenance property: caller data under arbitrary object keys never passes the gate", () => {
  const vault = "${{ vault.get('prod', 'k') }}";
  const workflow = Workflow.create({
    name: "w",
    inputs: { type: "object", properties: { cfg: { type: "object" } } },
    jobs: [Job.create({
      name: "main",
      steps: [Step.create({
        name: "s",
        task: StepTask.modelMethod("m", "run"),
      })],
    })],
  });
  const key = fc.oneof(
    fc.constantFrom("a", "a.b", "[0]", "]", '"', "", "a[0]", ".", "x.y.z"),
    fc.string({ maxLength: 4 }),
  );
  const leaf = fc.constantFrom(vault, `pre ${vault} post`, "{}", "plain");
  const tree = fc.letrec((tie) => ({
    node: fc.oneof(
      { depthSize: "small" },
      leaf,
      fc.dictionary(key, tie("node"), { maxKeys: 4 }),
      fc.array(tie("node"), { maxLength: 3 }),
    ),
  })).node;
  fc.assert(
    fc.property(fc.dictionary(key, tree, { maxKeys: 4 }), (cfg) => {
      const inputs = { cfg };
      const ctx = attachBindingProvenance(
        { model: {}, env: {}, inputs },
        { inputs: workflowInputsProvenance(inputs, workflow) },
      );
      const tracked = replaceExpressionsTracked(
        {
          methodArgs: { foo: "${{ inputs.cfg }}", bar: "x ${{ inputs.cfg }}" },
        },
        new Map([["${{ inputs.cfg }}", cfg]]),
        ProvenanceMap.authored(),
        () => spliceOrigin("inputs.cfg", ctx, cfg),
      );
      assertEquals(
        partitionAuthoredAt(
          extractExpressions(tracked.data),
          new Set(extractExpressions(cfg).map((e) => e.raw)),
          tracked.provenance,
        ),
        [],
      );
    }),
    { numRuns: 300 },
  );
});

Deno.test("canonicalPath: folds an unquoted .[ but never inside a quoted key", () => {
  assertEquals(canonicalPath("x.[0]"), "x[0]");
  assertEquals(canonicalPath(keyPath("x", "a.[b")), keyPath("x", "a.[b"));
  // Two distinct quoted keys stay distinct, so a graft on one keeps the other.
  const map = ProvenanceMap.authored()
    .withWholeData(keyPath("inputs", "a[b"))
    .graft(keyPath("inputs", "a.[b"), ProvenanceMap.authored());
  assertEquals(map.isWholeDataAt(keyPath("inputs", "a[b")), true);
});

Deno.test("alignStrings: a sentinel and its rehomed copy align by what they reference, with no value read", () => {
  const registry = new SecretBagRegistry();
  const workflowBag = new VaultSecretBag(registry);
  const stepBag = new VaultSecretBag(registry);
  const one = workflowBag.addDataSecret("pw1secret", {
    vaultName: "v",
    key: "a",
  });
  const two = workflowBag.addSecret({ vaultName: "v", key: "b" }, "inputs.b");
  const overlay = `${one} \${{ env.A }} ${two}`;
  const rehomed = workflowBag.rehomeSentinels(overlay, stepBag) as string;
  assertEquals(rehomed !== overlay, true);
  const identity = sentinelIdentityOf(registry);
  const [r1, r2] = rehomed.match(VaultSecretBag.SENTINEL_PATTERN)!;
  assertEquals(identity(one), identity(r1));
  assertEquals(identity(two), identity(r2));
  assertEquals(identity(one) !== identity(two), true);
  assertEquals(identity("__SWAMP_VSEC_" + "0".repeat(32) + "_0__"), undefined);
  assertEquals(identity(one)!.includes("pw1secret"), false);

  const ranges = [[0, one.length], [
    overlay.length - two.length,
    overlay.length,
  ]] as const;
  const aligned = alignStrings(ranges, overlay, rehomed, identity, identity);
  assertEquals(aligned, [[0, r1.length], [
    rehomed.length - r2.length,
    rehomed.length,
  ]]);
  // Without a resolver both copies differ in two spans, so the single-span
  // fallback would mark the authored text between them as data.
  const fallback = alignStrings(ranges, overlay, rehomed);
  assertEquals(fallback.length, 1);
});

Deno.test("alignStrings: resolving both copies keeps a sentinel from an earlier pass exact", () => {
  const registry = new SecretBagRegistry();
  const early = new VaultSecretBag(registry).addDataSecret("early-pw", REF);
  const stepBag = new VaultSecretBag(registry);
  const late = stepBag.addDataSecret("late-pw", REF);
  // The raw copy already carries the earlier sentinel; the sanitized copy
  // carries it too and new sentinels where the raw copy holds the value.
  const raw = `late-pw A ${early} B late-pw`;
  const sanitized = `${late} A ${early} B ${late}`;
  const ranges = [
    [0, 7],
    [10, 10 + early.length],
    [raw.length - 7, raw.length],
  ] as const;
  const resolve = sentinelStandInOf(stepBag.registry);
  const aligned = alignStrings(ranges, raw, sanitized, resolve, resolve);
  assertEquals(aligned, [
    [0, late.length],
    [late.length + 3, late.length + 3 + early.length],
    [sanitized.length - late.length, sanitized.length],
  ]);
  // Resolving one side only makes the copies differ, and the fallback
  // treats the whole differing span, authored text included, as data.
  const oneSided = alignStrings(ranges, raw, sanitized, undefined, resolve);
  assertEquals(oneSided, [[0, sanitized.length]]);
});

Deno.test("sentinelStandInOf: a data sentinel stands in for its value and a vault reference for its identity, with no value read", () => {
  const registry = new SecretBagRegistry();
  const workflowBag = new VaultSecretBag(registry);
  const stepBag = new VaultSecretBag(registry);
  const vault = workflowBag.addSecret({ vaultName: "v", key: "b" }, "inputs.b");
  const twin = workflowBag.rehomeSentinels(vault, stepBag) as string;
  const data = stepBag.addDataSecret("pw1secret", REF);
  const standIn = sentinelStandInOf(registry);
  assertEquals(standIn(data), "pw1secret");
  assertEquals(standIn(vault), standIn(twin));
  assertEquals(standIn(vault), sentinelIdentityOf(registry)(vault));
  assertEquals(standIn("__SWAMP_VSEC_" + "0".repeat(32) + "_0__"), undefined);

  // The raw copy holds the data value and the earlier vault sentinel; the
  // sanitized copy holds the data sentinel and the vault sentinel's twin.
  const raw = `pw1secret \${{ env.A }} ${vault}`;
  const sanitized = `${data} \${{ env.A }} ${twin}`;
  const aligned = alignStrings(
    [[0, 9], [raw.length - vault.length, raw.length]],
    raw,
    sanitized,
    standIn,
    standIn,
  );
  assertEquals(aligned, [
    [0, data.length],
    [sanitized.length - twin.length, sanitized.length],
  ]);
});

Deno.test("sentinelIdentityOf: a data-origin reference stands in as data origin, like a legacy data entry, with no value read", () => {
  const registry = new SecretBagRegistry();
  const bag = new VaultSecretBag(registry);
  const reference = bag.addDataReference({ vaultName: "v", key: "a" }, "loc");
  const legacy = bag.addDataSecret("pw-value", { vaultName: "v", key: "a" });
  const vault = bag.addSecret({ vaultName: "v", key: "a" }, "inputs.a");
  const identity = sentinelIdentityOf(registry);
  assertEquals(identity(reference), identity(legacy));
  assertEquals(identity(reference) !== identity(vault), true);
  assertEquals(identity(reference)!.includes("pw-value"), false);
});

Deno.test("ProvenanceMap: an object's own keys can be data while its values are described on their own (swamp-club#3681)", () => {
  const map = ProvenanceMap.fromEntries(
    ["tokens.secret"],
    [["tokens.text", [[0, 4]]]],
    ["tokens"],
  );
  assertEquals(map.isAuthored, false);
  assertEquals(map.hasDataKeysAt("tokens"), true);
  assertEquals(map.isWholeDataAt("tokens"), false);
  assertEquals(map.hasDataAtOrBelow("tokens"), true);
  assertEquals(map.hasDataAtOrBelow(""), true);
  // The values keep their own standing: an expression at a key is authored.
  assertEquals(map.hasDataAtOrBelow("tokens.expr"), false);
  assertEquals(map.overlapsData("tokens.expr", 0, 10), false);
  assertEquals(map.isWholeDataAt("tokens.secret"), true);
  assertEquals(map.hasDataKeysAt("tokens.secret"), true);
  // Carried through re-rooting, grafting and union; persisted and read back.
  assertEquals(map.subtree("tokens").hasDataKeysAt(""), true);
  const grafted = ProvenanceMap.authored().graft(
    "methods.run.arguments.tokens",
    map.subtree("tokens"),
  );
  assertEquals(grafted.hasDataKeysAt("methods.run.arguments.tokens"), true);
  assertEquals(grafted.isWholeDataAt("methods.run.arguments.tokens"), false);
  assertEquals(
    ProvenanceMap.authored().union(map).hasDataKeysAt("tokens"),
    true,
  );
  assertEquals(map.paths().includes("tokens"), true);
  assertEquals(map.toData(), {
    whole: ["tokens.secret"],
    ranges: { "tokens.text": [[0, 4]] },
    keys: ["tokens"],
  });
  assertEquals(
    ProvenanceMap.fromData(map.toData()).hasDataKeysAt("tokens"),
    true,
  );
  // Under a subtree that is data whole the entry is redundant and dropped.
  assertEquals(map.withWholeData("tokens").toData(), {
    whole: ["tokens"],
    ranges: {},
  });
  assertEquals(map.graft("tokens", ProvenanceMap.authored()).isAuthored, true);
  // A map written before the field existed reads back as it was written.
  assertEquals(
    ProvenanceMap.fromData({ whole: [], ranges: {} }).isAuthored,
    true,
  );
  assertEquals(ProvenanceMap.authored().toData(), { whole: [], ranges: {} });
});

Deno.test("readSetMap: a caller's object holding a vouched expression keeps its keys and its other values as data, and the occurrence still substitutes once spliced (swamp-club#3681)", () => {
  const vaultRef = "${{ vault.get('v', 'k') }}";
  const constant = "${{ 'public' }}";
  const vouched = new Set([vaultRef, constant]);
  const value = {
    "SECRET-KEY": null,
    pin: 7381,
    text: `Bearer ${vaultRef}`,
    expr: constant,
    nested: { "INNER-KEY": "plain", list: [constant, "item"] },
    plain: { "PLAIN-KEY": "x" },
  };
  const map = readSetMap(value, vouched);
  assertEquals(map.hasDataKeysAt(""), true);
  assertEquals(map.isWholeDataAt(""), false);
  assertEquals(map.isWholeDataAt(keyPath("", "SECRET-KEY")), true);
  assertEquals(map.isWholeDataAt("pin"), true);
  assertEquals(map.rangesAt("text"), [[0, "Bearer ".length]]);
  assertEquals(map.hasDataAtOrBelow("expr"), false);
  assertEquals(map.hasDataKeysAt("nested"), true);
  assertEquals(map.isWholeDataAt(keyPath("nested", "INNER-KEY")), true);
  assertEquals(map.hasDataAtOrBelow("nested.list[0]"), false);
  assertEquals(map.isWholeDataAt("nested.list[1]"), true);
  // A subtree with no vouched occurrence is data whole, keys included.
  assertEquals(map.isWholeDataAt("plain"), true);
  // Nothing vouched, or no expression at all: data whole, as before.
  assertEquals(readSetMap(value, new Set()).isWholeData, true);
  assertEquals(readSetMap({ "SECRET-KEY": null }, vouched).isWholeData, true);
  // An occurrence nothing vouches for is data like any other text.
  assertEquals(
    readSetMap({ a: "${{ env.X }}", b: constant }, vouched).isWholeDataAt("a"),
    true,
  );

  // Spliced whole into an argument, the keys stay data at their new
  // position and the vouched occurrences still pass the gate.
  const at = "methods.run.arguments.tokens";
  const spliced = replaceExpressionsTracked(
    { methods: { run: { arguments: { tokens: "${{ inputs.key }}" } } } },
    new Map([["${{ inputs.key }}", value]]),
    ProvenanceMap.authored(),
    () => ({ map, authoredRaws: vouched }),
  );
  assertEquals(spliced.provenance.hasDataKeysAt(at), true);
  assertEquals(spliced.provenance.isWholeDataAt(at), false);
  assertEquals(
    spliced.provenance.isWholeDataAt(keyPath(at, "SECRET-KEY")),
    true,
  );
  const resolved = replaceExpressionsTracked(
    spliced.data,
    new Map([[vaultRef, "VAULT"], [constant, "public"]]),
    spliced.provenance,
    () => AUTHORED_ORIGIN,
  );
  const tokens = (resolved.data as {
    methods: { run: { arguments: { tokens: Record<string, unknown> } } };
  }).methods.run.arguments.tokens;
  assertEquals(tokens.text, "Bearer VAULT");
  assertEquals(tokens.expr, "public");
  assertEquals((tokens.nested as { list: unknown[] }).list, ["public", "item"]);
  assertEquals(resolved.provenance.hasDataKeysAt(at), true);
  assertEquals(resolved.provenance.hasDataKeysAt(`${at}.nested`), true);
});
