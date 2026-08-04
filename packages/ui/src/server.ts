import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { Db } from '@careerforge/store';

import { renderPage } from './page.js';
import { readExplorerView, recordAnswer } from './reader.js';

/**
 * The Evidence Explorer, served to the user's own browser.
 *
 * ── The bind host is not a parameter ─────────────────────────────────────
 *
 * `127.0.0.1`, as a constant. There is no option, no environment variable, and
 * no flag, because a flag that exposes a career database — transcripts, client
 * names, unguarded opinions — to a local network is a flag somebody will
 * eventually set by accident or on advice from a forum. Nothing to configure
 * means nothing to get wrong, and the right way to reach this from another
 * machine is an SSH tunnel, which is the user's decision on their own machine
 * rather than a checkbox in a career tool.
 *
 * This package may listen and may not send (ADR-0028). It holds no provider,
 * no key, and no HTTP client; every path that could put evidence on a wire
 * goes through `policy` in a different package entirely.
 */

/** Not configurable. See above, and ADR-0028. */
export const BIND_HOST = '127.0.0.1' as const;
export const DEFAULT_PORT = 7777;

export interface ExplorerServerOptions {
  readonly db: Db;
  readonly port?: number;
}

export interface ExplorerServer {
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
}

const json = (response: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // A local page reading a local store has no business being framed,
    // sniffed, or referred anywhere.
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'cross-origin-resource-policy': 'same-origin',
  });
  response.end(payload);
};

const html = (response: ServerResponse, body: string): void => {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'cross-origin-resource-policy': 'same-origin',
    'x-frame-options': 'DENY',
    // Everything is inlined, so the page needs nothing from anywhere. Saying
    // so means a compromised dependency further up cannot quietly add a
    // request to a page that displays somebody's career history.
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'",
  });
  response.end(body);
};

async function readBody(request: IncomingMessage, limitBytes = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    // An unbounded read on a local server is still an unbounded read.
    if (size > limitBytes) throw new Error('Request body too large.');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Handle one request.
 *
 * Exported so the routes can be tested without binding a socket — the binding
 * itself is what the dedicated test covers, and everything else is a function
 * of a request and the store.
 */
export async function handle(
  db: Db,
  request: IncomingMessage,
  response: ServerResponse,
  security: { readonly authority: string; readonly origin: string; readonly writeToken: string },
): Promise<void> {
  const method = request.method ?? 'GET';

  try {
    if ((request.headers['host'] ?? '').trim().toLowerCase() !== security.authority) {
      json(response, 421, { error: 'Unexpected request authority.' });
      return;
    }
    const target = new URL(request.url ?? '/', security.origin);
    const path = target.pathname;
    const requestedPage = Number.parseInt(target.searchParams.get('page') ?? '1', 10);
    const page = Number.isFinite(requestedPage) ? requestedPage : 1;

    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      html(response, renderPage(readExplorerView(db, { page }), security.writeToken));
      return;
    }

    if (method === 'GET' && path === '/api/view') {
      json(response, 200, readExplorerView(db, { page }));
      return;
    }

    if (method === 'POST' && path === '/api/answer') {
      if (request.headers.origin !== security.origin) {
        json(response, 403, { error: 'Writes require the Explorer origin.' });
        return;
      }
      if (
        request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !==
        'application/json'
      ) {
        json(response, 415, { error: 'Writes require application/json.' });
        return;
      }
      if (request.headers['x-careerforge-token'] !== security.writeToken) {
        json(response, 403, { error: 'The Explorer write token is missing or invalid.' });
        return;
      }
      const body = JSON.parse(await readBody(request)) as { gapId?: unknown; answer?: unknown };
      if (typeof body.gapId !== 'string' || typeof body.answer !== 'string') {
        json(response, 400, { error: 'gapId and answer are required.' });
        return;
      }
      if (body.answer.trim() === '') {
        json(response, 400, { error: 'An empty answer is not evidence.' });
        return;
      }
      if (body.answer.length > 8_000) {
        json(response, 400, { error: 'Answers are limited to 8,000 characters.' });
        return;
      }
      json(response, 200, recordAnswer(db, body.gapId, body.answer.trim()));
      return;
    }

    json(response, 404, { error: `No route for ${method} ${path}.` });
  } catch (error) {
    // A stack trace on a page about trustworthiness is a bad look and a worse
    // leak — the message may quote store contents.
    json(response, 500, {
      error: error instanceof Error ? error.message : 'Something went wrong reading the store.',
    });
  }
}

export function createExplorerServer(options: ExplorerServerOptions): Promise<ExplorerServer> {
  const port = options.port ?? DEFAULT_PORT;
  let security:
    | { readonly authority: string; readonly origin: string; readonly writeToken: string }
    | undefined;
  const server = createServer((request, response) => {
    if (security === undefined) {
      json(response, 503, { error: 'Explorer is starting.' });
      return;
    }
    void handle(options.db, request, response, security);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Two arguments, and the host is the constant. Omitting it would bind
    // every interface, which is the one mistake this whole file is arranged
    // to make impossible.
    server.listen(port, BIND_HOST, () => {
      server.removeListener('error', reject);
      const address = server.address();
      const actual = typeof address === 'object' && address !== null ? address.port : port;
      const authority = `${BIND_HOST}:${actual}`;
      security = {
        authority,
        origin: `http://${authority}`,
        writeToken: randomBytes(32).toString('base64url'),
      };
      resolve({
        server,
        url: `${security.origin}/`,
        close: () =>
          new Promise<void>((done, fail) =>
            server.close((error) => (error ? fail(error) : done())),
          ),
      });
    });
  });
}
