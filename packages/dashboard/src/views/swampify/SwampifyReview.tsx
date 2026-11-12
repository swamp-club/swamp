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

/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { useMemo, useState } from "react";
import type { SwampifyRow } from "../../client/swampify.ts";
import type { ComparisonRecord } from "../../client/useSwampify.ts";
import { swampifyBuildBrief } from "../../lib/agent_sessions/swampify.ts";
import {
  formatDay,
  formatRate,
  formatTokens,
  KIND_LABEL,
  type OfferView,
  type OptionView,
} from "../../lib/swampify_view.ts";
import { formatCount, pluralize } from "../../lib/format.ts";
import { ComparisonBlock } from "./SwampifyComparison.tsx";
import { foundCandidates, optionStatus } from "./SwampifyOptions.tsx";

export interface OptionReviewProps {
  readonly option: OptionView;
  readonly offer: OfferView;
  /** The behavior that holds the offer, named in the brief's commands. */
  readonly behavior: string;
  readonly comparison: SwampifyRow | undefined;
  readonly records: ReadonlyMap<string, ComparisonRecord>;
  readonly onLoadComparison: (row: SwampifyRow) => void;
  readonly onBack: () => void;
  /** Tests start with the brief shown. */
  readonly initialBriefShown?: boolean;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function HandOff(
  { brief, becomes, initialShown = false }: {
    brief: string | null;
    becomes: string;
    initialShown?: boolean;
  },
) {
  const [shown, setShown] = useState(initialShown);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  if (brief === null) {
    return (
      <p className="sw-muted">
        This offer's behavior name can't be written into a brief safely, so
        there is no brief to copy. Ask your agent to build it with the swampify
        skill.
      </p>
    );
  }
  return (
    <>
      <p className="sw-small">
        The brief tells your agent to record your pick, build the{" "}
        {becomes}, run it once and show you the result. Paste it to your agent
        in this repo.
      </p>
      <button
        type="button"
        className="sw-btn sw-btn-primary"
        onClick={() =>
          void copyText(brief).then((ok) =>
            setCopied(ok ? "copied" : "failed")
          )}
      >
        {copied === "copied" ? "Copied" : "Copy brief"}
      </button>
      {copied === "failed" && (
        <p className="sw-fail sw-small" role="alert">
          The browser refused the clipboard. Select the brief below and copy it.
        </p>
      )}
      <button
        type="button"
        className="sw-link"
        aria-expanded={shown || copied === "failed"}
        onClick={() => setShown(!shown)}
      >
        {shown || copied === "failed" ? "Hide the brief" : "See the brief"}
      </button>
      {(shown || copied === "failed") &&
        <pre className="sw-brief">{brief}</pre>}
    </>
  );
}

/**
 * One option: what swamp would build, the evidence behind it, and the brief
 * that hands it to the user's agent.
 */
export function OptionReview(props: OptionReviewProps) {
  const { option: view, offer } = props;
  const { option } = view;
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const candidates = useMemo(() => foundCandidates(view), [view]);
  const brief = useMemo(
    () => swampifyBuildBrief({ behavior: props.behavior, option, candidates }),
    [props.behavior, option, candidates],
  );
  const status = optionStatus(view, offer);
  const state = offer.offer.state;
  const target = state.kind === "built" && view.picked ? state.target : null;
  const unshown = view.candidates.length - candidates.length;

  return (
    <div className="sw-page">
      <button type="button" className="sw-link sw-back" onClick={props.onBack}>
        ← Swampify
      </button>
      <header className="sw-review-head">
        <h1 className="sw-title">
          {option.name}
          {status && <span className="sw-status">{status}</span>}
        </h1>
        <p className="sw-why">{option.why}</p>
      </header>

      <div className="sw-review">
        <div className="sw-review-main">
          {(props.comparison || target) && (
            <section className="sw-card sw-pad" aria-labelledby="sw-cmp-h">
              <h2 id="sw-cmp-h">Raw against swamp</h2>
              <ComparisonBlock
                row={props.comparison}
                open={comparisonOpen}
                onToggle={() =>
                  setComparisonOpen(!comparisonOpen)}
                records={props.records}
                onLoad={props.onLoadComparison}
              />
            </section>
          )}
          <section className="sw-card sw-pad" aria-labelledby="sw-build-h">
            <h2 id="sw-build-h">What swamp would build</h2>
            <p>
              A {option.becomes}
              {option.registryType && (
                <>
                  {" "}using <code>{option.registryType}</code>
                </>
              )}
              {option.outline ? ", in these steps:" : "."}
            </p>
            {option.outline && (
              <ol className="sw-steps">
                {option.outline.map((step, i) => <li key={i}>{step}</li>)}
              </ol>
            )}
          </section>
          <section className="sw-card sw-pad" aria-labelledby="sw-ev-h">
            <h2 id="sw-ev-h">The evidence</h2>
            <p>
              It stands for {pluralize(view.candidates.length, "candidate")}:
            </p>
            {candidates.map((c) => (
              <div key={c.id} className="sw-evidence">
                <div className="sw-evidence-label">{c.label}</div>
                <div className="sw-muted sw-small">
                  {KIND_LABEL[c.kind]} · {formatCount(c.occurrences)} runs in
                  {" "}
                  {pluralize(c.sessions, "session")} ·{" "}
                  {formatTokens(c.perOccurrence.weightedTokens.median)}{" "}
                  tokens per run · {formatRate(c.failureRate)} failed ·{" "}
                  {formatDay(c.firstSeen)} to {formatDay(c.lastSeen)}
                </div>
                {c.excerpts[0] && (
                  <pre className="sw-excerpt">{c.excerpts[0].text}</pre>
                )}
              </div>
            ))}
            {unshown > 0 && (
              <p className="sw-muted sw-small">
                {pluralize(unshown, "candidate")} {unshown === 1 ? "is" : "are"}
                {" "}
                not in the shown assessment.
              </p>
            )}
          </section>
        </div>

        <aside className="sw-card sw-pad sw-aside" aria-labelledby="sw-hand-h">
          {target
            ? (
              <>
                <h2 id="sw-hand-h">Built</h2>
                <p>
                  Your agent built the {target.kind} <code>{target.name}</code>.
                </p>
              </>
            )
            : (
              <>
                <h2 id="sw-hand-h">Hand it to your agent</h2>
                <HandOff
                  brief={brief}
                  becomes={option.becomes}
                  initialShown={props.initialBriefShown}
                />
              </>
            )}
        </aside>
      </div>
    </div>
  );
}
