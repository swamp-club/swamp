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
import type { ReactNode } from "react";
import {
  Benefit,
  CopyableSnippet,
  type CopyFn,
  SERVE_CONFIG_PATH,
} from "./AuditStates.tsx";

/**
 * Schedules and webhooks fire from a running `swamp serve`. The local
 * dashboard (`swamp start` / `swamp dashboard`) reads the repo directly with
 * no serve behind it, so these pages show what serve would give and how to
 * run it, in the same style as the Activity page's audit-off state.
 */

export const SCHEDULE_MANUAL_LINKS = [
  {
    label: "Run workflows on a schedule",
    href: "https://swamp-club.com/manual/how-to/run-workflows-on-a-schedule",
  },
  {
    label: "What swamp serve does",
    href: "https://swamp-club.com/manual/explanation/swamp-serve",
  },
] as const;

export const WEBHOOK_MANUAL_LINKS = [
  {
    label: "Set up webhooks",
    href: "https://swamp-club.com/manual/how-to/set-up-webhooks",
  },
  {
    label: "What swamp serve does",
    href: "https://swamp-club.com/manual/explanation/swamp-serve",
  },
] as const;

export const SCHEDULE_SNIPPET = `trigger:
  schedule: "0 8 * * 1-5"`;

export const WEBHOOK_SNIPPET = `webhooks:
  - route: /hooks/deploy
    workflow: deploy
    secret: "@env=DEPLOY_WEBHOOK_SECRET"`;

const SERVE_COMMAND = "swamp serve --dashboard";

const ICON_CLOCK =
  '<circle cx="9" cy="9" r="6.5"/><path d="M9 5.5V9l2.5 1.5"/>';
const ICON_LIST =
  '<path d="M6 5h9M6 9h9M6 13h9"/><path d="M3 5h.01M3 9h.01M3 13h.01"/>';
const ICON_GLOBE =
  '<circle cx="9" cy="9" r="6.5"/><path d="M2.5 9h13M9 2.5c2 2 2 11 0 13M9 2.5c-2 2-2 11 0 13"/>';
const ICON_SHIELD =
  '<path d="M9 2 3.5 4v4.5c0 3.5 2.4 6 5.5 7.5 3.1-1.5 5.5-4 5.5-7.5V4z"/>';

type ManualLink = { readonly label: string; readonly href: string };

function ServeOnlyState(
  { state, badge, title, intro, benefits, steps, links }: {
    state: string;
    badge: string;
    title: string;
    intro: ReactNode;
    benefits: ReactNode;
    steps: ReactNode;
    links: readonly ManualLink[];
  },
) {
  const titleId = `${state}-local-title`;
  return (
    <section
      className="act-state act-disabled"
      aria-labelledby={titleId}
      data-local-state={state}
    >
      <div className="act-state-intro">
        <span className="act-state-badge">{badge}</span>
        <h2 id={titleId}>{title}</h2>
        <p>{intro}</p>
      </div>

      <ul className="act-benefits">{benefits}</ul>

      <div className="act-enable">
        <h3>Turn it on</h3>
        <ol className="act-steps">{steps}</ol>
        <ul className="act-doc-links">
          {links.map((link) => (
            <li key={link.href}>
              <a
                className="act-doc-link"
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
              >
                {link.label}
                <span aria-hidden="true">↗</span>
                <span className="visually-hidden">(opens in a new tab)</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** The local dashboard's Schedules page: schedules fire from swamp serve. */
export function SchedulesLocalState({ copy }: { copy: CopyFn }) {
  return (
    <ServeOnlyState
      state="schedules"
      badge="Schedules off"
      title="Run workflows on a timetable"
      intro={
        <>
          Schedules fire from a running{" "}
          <code>swamp serve</code>. This local dashboard reads your repo
          directly, so nothing here runs a workflow on its schedule.
        </>
      }
      benefits={
        <>
          <Benefit icon={ICON_CLOCK} title="Cron schedules on any workflow">
            A <code>trigger.schedule</code>{" "}
            in the workflow file runs it at the times you set, in the server's
            time zone.
          </Benefit>
          <Benefit icon={ICON_LIST} title="Every schedule in one place">
            The next fire, the last run and anything queued, with each scheduled
            run linked from here.
          </Benefit>
          <Benefit icon={ICON_SHIELD} title="Change it on the server">
            Override a schedule on one server without editing the workflow, with
            {" "}
            <code>swamp workflow trigger set</code>.
          </Benefit>
        </>
      }
      steps={
        <>
          <li>
            Add a schedule to the workflow's YAML:
            <CopyableSnippet
              code={SCHEDULE_SNIPPET}
              label="workflow.yaml"
              copy={copy}
            />
          </li>
          <li>
            In this repo, run <code>{SERVE_COMMAND}</code>{" "}
            and keep it running: it fires the schedule and serves this dashboard
            with Schedules on.
          </li>
        </>
      }
      links={SCHEDULE_MANUAL_LINKS}
    />
  );
}

/** The local dashboard's Webhooks page: webhook routes live on swamp serve. */
export function WebhooksLocalState({ copy }: { copy: CopyFn }) {
  return (
    <ServeOnlyState
      state="webhooks"
      badge="Webhooks off"
      title="Start workflows from other systems"
      intro={
        <>
          Webhook routes are served by a running{" "}
          <code>swamp serve</code>. This local dashboard has no address another
          system can reach, so there are no webhooks to show.
        </>
      }
      benefits={
        <>
          <Benefit icon={ICON_GLOBE} title="A route per workflow">
            GitHub, your CI or any system that can POST starts a workflow
            through its own route, with fields from the request mapped onto the
            run's inputs.
          </Benefit>
          <Benefit icon={ICON_SHIELD} title="Signed requests only">
            Each route checks an HMAC signature against its secret, read from
            the environment, a file or a vault.
          </Benefit>
          <Benefit icon={ICON_LIST} title="Every delivery, linked">
            Each route's recent runs show here, so you can see what a delivery
            started and how it went.
          </Benefit>
        </>
      }
      steps={
        <>
          <li>
            Add a <code>webhooks</code> list to <code>{SERVE_CONFIG_PATH}</code>
            {" "}
            (or the file you pass to <code>swamp serve --config</code>):
            <CopyableSnippet
              code={WEBHOOK_SNIPPET}
              label="serve.yaml"
              copy={copy}
            />
          </li>
          <li>
            Check it with <code>swamp serve check-config</code>, then run{" "}
            <code>{SERVE_COMMAND}</code>{" "}
            in this repo, somewhere the sender can reach.
          </li>
        </>
      }
      links={WEBHOOK_MANUAL_LINKS}
    />
  );
}
