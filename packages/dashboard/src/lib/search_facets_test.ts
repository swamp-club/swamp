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
import {
  type FacetDef,
  parseFacetInput,
  type Suggestion,
  suggestionsFor,
} from "./search_facets.ts";

const facets: FacetDef[] = [
  {
    key: "prefix",
    label: "Prefix",
    description: "Name prefix, like deploy-",
    values: [
      { value: "deploy", label: "deploy", hint: "12" },
      { value: "sync", label: "sync", hint: "10" },
    ],
  },
  {
    key: "trigger",
    label: "Trigger",
    description: "Cron, webhook or manual",
    values: [
      { value: "schedule", label: "Cron" },
      { value: "webhook", label: "Webhook" },
      { value: "manual", label: "Manual" },
    ],
  },
  {
    key: "webhook",
    label: "Webhook",
    description: "Route that starts it",
    values: [{ value: "/hooks/github-push", label: "/hooks/github-push" }],
  },
  { key: "empty", label: "Empty", description: "No values", values: [] },
];

const show = (s: Suggestion[]) =>
  s.map((x) =>
    x.kind === "text"
      ? `text:${x.text}`
      : x.kind === "facet"
      ? `facet:${x.facet.key}`
      : `${x.facet.key}=${x.value.value}`
  );

Deno.test("parseFacetInput: key or label before a colon", () => {
  assertEquals(parseFacetInput("prefix:dep", facets)?.partial, "dep");
  assertEquals(parseFacetInput("Trigger: cr", facets)?.facet.key, "trigger");
  assertEquals(parseFacetInput("nope:x", facets), null);
  assertEquals(parseFacetInput("deploy", facets), null);
});

Deno.test("suggestionsFor: empty input offers facets with values", () => {
  assertEquals(show(suggestionsFor("", facets)), [
    "facet:prefix",
    "facet:trigger",
    "facet:webhook",
  ]);
});

Deno.test("suggestionsFor: applied facets aren't offered again", () => {
  assertEquals(
    show(suggestionsFor("", facets, new Set(["trigger"]))),
    ["facet:prefix", "facet:webhook"],
  );
});

Deno.test("suggestionsFor: key: lists that facet's values, filtered", () => {
  assertEquals(show(suggestionsFor("prefix:", facets)), [
    "prefix=deploy",
    "prefix=sync",
  ]);
  assertEquals(show(suggestionsFor("prefix:sy", facets)), ["prefix=sync"]);
  assertEquals(show(suggestionsFor("trigger:cr", facets)), [
    "trigger=schedule",
  ]);
});

Deno.test("suggestionsFor: free text searches names, then facets and values", () => {
  assertEquals(show(suggestionsFor("git", facets)), [
    "text:git",
    "webhook=/hooks/github-push",
  ]);
  assertEquals(show(suggestionsFor("web", facets)).slice(0, 3), [
    "text:web",
    "facet:webhook",
    "trigger=webhook",
  ]);
});
