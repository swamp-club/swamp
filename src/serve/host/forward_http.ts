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

import http from "node:http";
import { pipeline, Readable } from "node:stream";
import { getLogger } from "@logtape/logtape";
import { endOnAbort } from "../stream_abort.ts";
import { forwardResponseHeaders } from "./forwarding_headers.ts";
import { hostReply } from "./host_reply.ts";

const logger = getLogger(["swamp", "serve", "host"]);

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

type NodeReadableSource = Parameters<typeof Readable.fromWeb>[0];

export interface HttpForwarder {
  /**
   * sends `req` to the child on loopback `port` at `pathAndQuery`; node:http
   * rather than fetch, which sends a streamed body chunked and drops its
   * Content-Length
   */
  forward(
    req: Request,
    port: number,
    pathAndQuery: string,
    headers: Headers,
  ): Promise<Response>;
}

/** every connection and open reply ends when `signal` aborts */
export function createHttpForwarder(signal: AbortSignal): HttpForwarder {
  const agent = new http.Agent({ keepAlive: true });
  signal.addEventListener("abort", () => agent.destroy(), { once: true });

  const forward = (
    req: Request,
    port: number,
    pathAndQuery: string,
    headers: Headers,
  ): Promise<Response> =>
    new Promise<Response>((resolve) => {
      let answered = false;
      const answer = (response: Response) => {
        if (answered) return;
        answered = true;
        resolve(response);
      };
      const unreachable = (error: unknown) => {
        logger
          .info`Forwarding ${req.method} to the child on port ${port} failed: ${error}`;
        answer(
          hostReply(502, { error: "The workspace could not be reached." }),
        );
      };

      const hasBody = req.body !== null && req.method !== "GET" &&
        req.method !== "HEAD";
      // a length with no body to follow would leave the pooled connection
      // waiting, and the next caller's request would be read as that body
      if (!hasBody) headers.delete("content-length");

      let outgoing: http.ClientRequest;
      try {
        outgoing = http.request({
          host: "127.0.0.1",
          port,
          method: req.method,
          path: pathAndQuery,
          headers: Object.fromEntries(headers),
          agent,
        });
      } catch (error) {
        // node refuses some header names and values Deno.serve accepted
        logger.info`Refused to forward ${req.method}: ${error}`;
        answer(
          hostReply(400, { error: "The request could not be forwarded." }),
        );
        return;
      }

      // a caller that hangs up before the reply is passed on as the child's own
      // request aborting, which serve treats as the caller gone (a lock taken
      // then is released); Deno aborts req.signal only after a reply has ended
      const callerGone = () => outgoing.destroy();
      req.signal.addEventListener("abort", callerGone, { once: true });
      const forgetCaller = () =>
        req.signal.removeEventListener("abort", callerGone);

      // an error event with no listener throws and would stop the host, so
      // both node streams keep one for their whole life
      outgoing.on("error", (error) => {
        forgetCaller();
        unreachable(error);
      });
      outgoing.on("upgrade", (_res, socket) => {
        socket.destroy();
        unreachable(new Error("the child switched protocols unasked"));
      });
      outgoing.on("response", (incoming) => {
        incoming.on("close", forgetCaller);
        incoming.on("error", (error) => {
          logger
            .debug`A reply from the child on port ${port} ended early: ${error}`;
        });
        const status = incoming.statusCode ?? 502;
        // a reply Response cannot hold (a status outside 200-599, a bad
        // header) would otherwise throw inside node's emitter and stop the host
        try {
          const init = {
            status,
            statusText: incoming.statusMessage,
            headers: forwardResponseHeaders(incoming.rawHeaders),
          };
          if (req.method === "HEAD" || NULL_BODY_STATUSES.has(status)) {
            incoming.resume();
            answer(new Response(null, init));
            return;
          }
          answer(new Response(endOfReply(incoming), init));
        } catch (error) {
          incoming.destroy();
          unreachable(error);
        }
      });

      if (!hasBody) {
        outgoing.end();
        return;
      }
      pipeline(
        Readable.fromWeb(req.body as unknown as NodeReadableSource),
        outgoing,
        (error) => {
          if (error) {
            logger
              .debug`An upload to the child on port ${port} ended early: ${error}`;
          }
        },
      );
    });

  // its own signal per reply, unlinked when the reply ends, so the router's
  // signal does not gather one listener for every request it ever forwarded
  const endOfReply = (
    incoming: http.IncomingMessage,
  ): ReadableStream<Uint8Array> => {
    const ended = new AbortController();
    const end = () => ended.abort();
    signal.addEventListener("abort", end, { once: true });
    return endOnAbort(
      Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
      ended.signal,
      () => signal.removeEventListener("abort", end),
    );
  };

  return { forward };
}
