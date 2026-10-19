'use strict';
/* ── HTTP rules every app route shares (spec 10.10, 10.12) ────────────────────
 *   securityHeaders  CSP self-only (frame-src the three embed origins), DENY
 *                    framing, nosniff, strict-origin-when-cross-origin; in
 *                    production HSTS a year (PUBLIC_ORIGIN is https there, so a
 *                    first http:// visit is never the one a stripper answers)
 *   csrf             a state-changing request whose Sec-Fetch-Site is
 *                    `cross-site`, or whose Origin is not this server's, is 403
 *   jsonOnly         a request body on /api is application/json (multipart only
 *                    where a route says so), capped at 64 KB
 *   fail()           THE error answer: `{ error: <key>, message: t(key) }`
 *   wantsAp(req)     content negotiation for the AP-or-page URLs (/@name,
 *                    /users/...): an ActivityStreams type (activity+json or
 *                    ld+json) with q > 0 and no lower q than text/html. An AP
 *                    type at q=0 is a refusal of it, never a request (N13).
 *   wantsHtml(req)   not AP, and text/html acceptable (q > 0)
 *
 * CSRF, as the spec words it, plus one reading: a request with NO Origin and no
 * Sec-Fetch-Site is not a browser's (every current browser sends Origin on a
 * non-GET), so curl and scripts pass; SameSite=Lax keeps the cookie off a
 * cross-site POST anyway, and a cross-site form cannot send application/json.
 *
 * Federation routes (P5) are mounted outside all of this: they never read a
 * session, so they need no CSRF check, and they have their own checks (spec 5.2).
 */
const express = require('express');
const { t } = require('./strings');
const { EMBED_ORIGINS } = require('./ring');
const urls = require('./urls');

const JSON_LIMIT = '64kb';

/* The Accept header as { type, q } ranges. */
function acceptRanges(header) {
  const out = [];
  for (const part of String(header || '').split(',')) {
    const [type, ...params] = part.split(';');
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
      if (m) { q = Number(m[1]); if (!Number.isFinite(q)) q = 0; }
    }
    const mt = type.trim().toLowerCase();
    if (mt) out.push({ type: mt, q });
  }
  return out;
}
const qFor = (ranges, re) => ranges.reduce((best, r) => (re.test(r.type) ? Math.max(best, r.q) : best), 0);
const AP_RANGE = /^application\/(activity\+json|ld\+json)$/;
const HTML_RANGE = /^text\/html$/;
/* AP when an AP type is acceptable (q > 0) and not less wanted than HTML. */
const wantsAp = (req) => {
  const r = acceptRanges(req.get('accept'));
  const ap = qFor(r, AP_RANGE);
  return ap > 0 && ap >= qFor(r, HTML_RANGE);
};
const wantsHtml = (req) => !wantsAp(req) && qFor(acceptRanges(req.get('accept')), HTML_RANGE) > 0;


function fail(res, status, code, vars) {
  return res.status(status).json({ error: code, message: t(code, vars) });
}

const HSTS = 'max-age=31536000';

function securityHeaders(cfg = {}) {
  const csp = [
    "default-src 'self'",
    "img-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    `frame-src ${EMBED_ORIGINS.join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return (req, res, next) => {
    res.set('Content-Security-Policy', csp);
    res.set('X-Frame-Options', 'DENY');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('Cross-Origin-Opener-Policy', 'same-origin');
    if (cfg.production) res.set('Strict-Transport-Security', HSTS);
    next();
  };
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/* A browser request another site made: Sec-Fetch-Site `cross-site`, or an
 * Origin that is not this server's. THE test, for csrf below and for the one
 * GET that spends a budget (the member export, spec 12). */
function foreignRequest(req, cfg) {
  if (req.get('sec-fetch-site') === 'cross-site') return true;
  const origin = req.get('origin');
  return origin !== undefined && origin !== urls.originOf(req, cfg);
}

function csrf(cfg) {
  return (req, res, next) => {
    if (SAFE.has(req.method)) return next();
    if (foreignRequest(req, cfg)) return fail(res, 403, 'csrf');
    next();
  };
}

const hasBody = (req) => (req.get('transfer-encoding') !== undefined) || (Number(req.get('content-length') || 0) > 0);

/* JSON-only bodies on /api, except the routes in `multipart` (a Set of paths). */
function jsonOnly({ multipart = new Set() } = {}) {
  const parse = express.json({ limit: JSON_LIMIT, strict: true });
  return (req, res, next) => {
    if (SAFE.has(req.method)) return next();
    if (multipart.has(req.path)) return next();
    if (!hasBody(req)) { req.body = {}; return next(); }
    if (!req.is('application/json')) return fail(res, 415, 'json_required');
    parse(req, res, (err) => {
      if (err) return next(err);
      if (req.body === undefined) req.body = {};
      next();
    });
  };
}

/* The last middleware: body-parser and multer errors keep their meaning; a
 * member who vanished mid-request (lib/page-store.js MemberGone) is 401; any
 * other CLIENT error (err.status 4xx: a malformed %-escape in a path, a garbage
 * gzip body) is a 4xx and logs NOTHING, so a loop of them cannot flood the log
 * or pass for a server fault. A malformed path parameter names nothing that
 * exists: 404, which spends the image miss budget like any other miss. Only a
 * real fault is a logged 500 (with its stack) and no detail in the answer. */
function errorHandler(logger = console) {
  return (err, req, res, _next) => {
    if (res.headersSent) return;
    if (err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE') return fail(res, 413, 'too_large');
    if (err.type === 'entity.parse.failed') return fail(res, 400, 'bad_json');
    if (err.type === 'encoding.unsupported' || err.type === 'charset.unsupported') return fail(res, 415, 'json_required');
    if (typeof err.code === 'string' && err.code.startsWith('LIMIT_')) return fail(res, 400, 'invalid_field');
    if (err.code === 'RING_BUSY') {
      // The password queue is full (lib/auth.js): a moment's wait, not a failure.
      res.set('Retry-After', String(err.retryAfter || 5));
      return fail(res, 503, 'busy');
    }
    if (err.code === 'MEMBER_GONE') return fail(res, 401, 'not_signed_in');
    if (err instanceof URIError) return fail(res, 404, 'not_found');
    const status = Number(err.status ?? err.statusCode);
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      if (status === 413) return fail(res, 413, 'too_large');
      if (status === 415) return fail(res, 415, 'json_required');
      return fail(res, 400, 'bad_request');
    }
    logger.error(`[error] ${req.method} ${req.path}: ${err.stack || err.message}`);
    return fail(res, 500, 'server_error');
  };
}

/* Express 5 forwards a rejected async handler to next(err); this keeps a sync
 * throw inside a callback from escaping too. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { fail, securityHeaders, csrf, foreignRequest, jsonOnly, errorHandler, wrap, JSON_LIMIT, wantsAp, wantsHtml, acceptRanges };
