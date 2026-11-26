#!/usr/bin/env node
// A recording reverse proxy (no dependencies): the v1 compatibility check, and
// optionally what the hosted receiver answers.
//
//   recording-proxy.mjs <port-file> <log-file> <upstream-ingest-base> [<headers-file>]
//
// Listens on a free localhost port (written to <port-file>) and forwards every
// HAR 1.x hosted-receiver request to the receiver's ingest base: 1.x sends to
// `<api>/api/har/ingest/<path>`, which becomes `<upstream>/<path>`. One JSON line
// per exchange goes to <log-file>: method, path, status, the Deprecation,
// Sunset and Link response headers, and the start of a non-2xx reply's body.
//
// <headers-file> (optional) stands in for whatever sits in front of a hosted
// receiver's v1 routes (a gateway): one `Name: value` per line, set on every
// forwarded request; `{client-bearer}` in a value is replaced by the token of
// the client's `Authorization: Bearer` header.
import fs from 'node:fs';
import http from 'node:http';

const [portFile, logFile, upstreamBase, headersFile] = process.argv.slice(2);
const extraHeaders = headersFile
  ? fs
      .readFileSync(headersFile, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf(':')).trim().toLowerCase(), line.slice(line.indexOf(':') + 1).trim()])
  : [];
const upstream = upstreamBase.replace(/\/+$/, '');
const PREFIX = '/api/har/ingest';

const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const suffix = request.url.startsWith(PREFIX) ? request.url.slice(PREFIX.length) : request.url;
  const headers = { ...request.headers };
  // Hop-by-hop headers are the proxy's own (fetch refuses some of them).
  for (const name of ['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'expect', 'upgrade', 'te', 'trailer', 'proxy-connection']) {
    delete headers[name];
  }
  const bearer = /^Bearer (.+)$/i.exec(String(request.headers.authorization ?? ''))?.[1] ?? '';
  for (const [name, value] of extraHeaders) headers[name] = value.replaceAll('{client-bearer}', bearer);
  let status = 502;
  let picked = {};
  let failure;
  try {
    const reply = await fetch(`${upstream}${suffix}`, {
      method: request.method,
      headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    status = reply.status;
    picked = {
      deprecation: reply.headers.get('deprecation'),
      sunset: reply.headers.get('sunset'),
      link: reply.headers.get('link'),
    };
    const body = Buffer.from(await reply.arrayBuffer());
    if (status >= 300) failure = body.subarray(0, 600).toString('utf8');
    const out = {};
    reply.headers.forEach((value, key) => {
      if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(key)) out[key] = value;
    });
    response.writeHead(status, out);
    response.end(body);
  } catch (error) {
    failure = String(error);
    response.writeHead(502, { 'content-type': 'text/plain' });
    response.end(failure);
  }
  fs.appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), method: request.method, path: suffix, status, ...picked, ...(failure ? { failure } : {}) })}\n`);
});

server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(portFile, String(server.address().port));
});
