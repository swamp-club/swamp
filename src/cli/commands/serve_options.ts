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

/** shared with the shell group a routed subcommand is built under */
export const SERVE_DESCRIPTION =
  "Start a WebSocket API server for workflow and behavior execution.\n\n" +
  "Service deployments: swamp loads all extensions — including " +
  "already-pulled repo extensions — through an embedded runtime under the " +
  "swamp data directory (SWAMP_HOME, or ~/.swamp). `swamp serve daemon " +
  "enable` sets SWAMP_HOME and SWAMP_CONFIG_DIR in the generated service " +
  "unit automatically. If you author a service unit manually, set " +
  "SWAMP_HOME or HOME in the unit environment, e.g. " +
  "`Environment=SWAMP_HOME=/opt/swamp`. Without it, scheduled workflow " +
  'runs fail with "Unknown behavior type" for pulled extension types. ' +
  "SWAMP_HOME also moves the config directory, where `swamp auth login` " +
  "stores credentials, to $SWAMP_HOME/config; for --auth-mode token or " +
  "oauth, also set SWAMP_CONFIG_DIR to the config directory holding " +
  "those credentials (~/.config/swamp by default).";

export const DISPATCH_ENV_ALLOW_HELP =
  "Comma-separated environment variable names; only these ship to workers with each " +
  "dispatch (case-insensitive, never HOME, PATH, SWAMP_* or the other denylisted names). " +
  "Unset ships serve's whole environment minus the denylist. To ship none, set " +
  "'dispatch-env-allow: []' in serve.yaml or an empty SWAMP_DISPATCH_ENV_ALLOW " +
  "(env: SWAMP_DISPATCH_ENV_ALLOW)";

export const RESERVED_WORKER_LABELS_HELP =
  "Comma-separated label keys a worker may carry only when its enrollment token " +
  "supplies them (a label bound with 'swamp worker token create --label', or a fleet " +
  "token's automatic fleet label); a worker that sets one itself is refused. " +
  "Restart serve to change it (env: SWAMP_RESERVED_WORKER_LABELS)";

export const ADDRESS_DESCRIPTION =
  "The address clients reach this serve at, as they put it in serverAddress. " +
  "Required to write a v3 datastore 'swamp datastore claim' gave to that address";

export const CLUB_API_KEY_FILE_DESCRIPTION =
  "Path to a file containing the collective API key (oauth:manage scope) " +
  "used for headless OAuth registration, username lookup, instance " +
  "registration and heartbeat; overrides SWAMP_API_KEY_FILE and SWAMP_API_KEY";

export const OAUTH_CLIENT_SECRET_FILE_DESCRIPTION =
  "Path to a file containing the secret of the OAuth client named by " +
  "--oauth-client-id; used for this run only and never stored. Overrides " +
  "SWAMP_OAUTH_CLIENT_SECRET_FILE and SWAMP_OAUTH_CLIENT_SECRET";

export const ADVERTISE_ADDRESS_DESCRIPTION =
  "This node's own http(s) address, as the other serve nodes sharing its " +
  "v3 datastore reach it. Followers forward writes to the leader at this " +
  "address; without it a node bound to a wildcard or loopback host cannot " +
  "be forwarded to";

export const SERVE_CA_CERT_DESCRIPTION =
  "PEM file of CA certificates to trust, besides the system store, when " +
  "this node forwards to its team's leader (a relative path resolves " +
  "against the repository)";
