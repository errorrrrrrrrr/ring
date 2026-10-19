'use strict';
/* ── Mail (spec 15.3 MAIL_PROVIDER) ───────────────────────────────────────────
 * Three providers behind one `send({ to, subject, text })`:
 *   smtp    nodemailer over SMTP_URL
 *   resend  Resend's HTTP API over fetch (no package)
 *   log     the default outside production: the mail goes to the server log and
 *           `DATA/mail-outbox.jsonl`, and the admin passes the link on
 * Unset in production means no mail: signup and reset answer 503
 * `mail_unavailable` (the routes ask `available()`).
 *
 * `send` never waits on the wire, so a route answers in the same time whether it
 * mailed a new member or an existing one (no enumeration by timing). `flush()`
 * awaits what is in flight (tests, shutdown). A failed send is logged without
 * its body: a link in a log line outside the `log` provider is a leak.
 *
 * THE OUTBOX IS BOUNDED (spec-r1-04). `mail-outbox.jsonl` holds live links in
 * clear, so it keeps a row OUTBOX_KEEP_MS (24 h, the longest token life) and no
 * longer: pruned at boot and before an append at most hourly (prune() is also
 * there for housekeeping), each time through writeFileAtomic. forget(email)
 * drops every row mailed to an address: the purge of a deleted account calls it.
 *
 * SMTP waits are bounded (SMTP_TIMEOUTS): connect, greeting and an idle socket
 * each give up, so a hung server ends in a logged `send failed`, never a socket
 * held for good.
 */
const fs = require('node:fs');
const clock = require('./clock');
const { filterLines } = require('./store');

const OUTBOX_KEEP_MS = 24 * 3600_000;
const PRUNE_EVERY_MS = 3600_000;
const SMTP_TIMEOUTS = Object.freeze({ connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });

function createMailer(cfg, paths, { logger = console, smtpTimeouts = SMTP_TIMEOUTS } = {}) {
  const provider = cfg.mail.provider;
  const host = (() => { try { return new URL(cfg.publicOrigin).hostname; } catch { return 'localhost'; } })();
  const from = cfg.mail.from || `Ring <ring@${host}>`;
  const pending = new Set();
  let transport = null;
  let prunedAt = 0;

  /* Rewrite the outbox keeping only the rows `keep` accepts (lib/store.js
   * filterLines: streamed, atomic). Returns the count dropped. */
  function rewriteOutbox(keep) {
    return filterLines(paths.mailOutbox, (line) => {
      let row;
      try { row = JSON.parse(line); } catch { return false; }   // a torn line holds nothing worth keeping
      return keep(row);
    });
  }

  function prune() {
    prunedAt = clock.now();
    const cutoff = clock.now() - OUTBOX_KEEP_MS;
    return rewriteOutbox((row) => Date.parse(row.at) > cutoff);
  }

  function forget(email) {
    const lc = String(email || '').trim().toLowerCase();
    if (!lc) return 0;
    return rewriteOutbox((row) => String(row.to || '').trim().toLowerCase() !== lc);
  }

  if (provider === 'log') {
    try { prune(); } catch (e) { logger.error(`[mail:log] outbox prune failed: ${e.message}`); }
  }

  /* The transport's options: the URL's, plus the bounded waits (a query string
   * on SMTP_URL still overrides them). */
  const smtpOptions = () => ({ url: cfg.mail.smtpUrl, ...smtpTimeouts });

  function smtp() {
    // Bounded waits: a hung SMTP server must not hold a socket (and the mail's
    // token) open forever. close() stops awaiting after 10 s anyway.
    if (!transport) transport = require('nodemailer').createTransport(smtpOptions());
    return transport;
  }

  async function deliver(msg) {
    if (provider === 'smtp') {
      await smtp().sendMail({ from, to: msg.to, subject: msg.subject, text: msg.text });
    } else if (provider === 'resend') {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.mail.resendApiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, text: msg.text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw new Error(`resend answered ${r.status}`);
    }
  }

  function send(msg) {
    if (!provider) throw new Error('mail: no provider');
    if (provider === 'log') {
      const row = { at: clock.iso(), to: msg.to, subject: msg.subject, text: msg.text };
      fs.mkdirSync(paths.root, { recursive: true });
      if (clock.now() - prunedAt >= PRUNE_EVERY_MS) {
        try { prune(); } catch (e) { logger.error(`[mail:log] outbox prune failed: ${e.message}`); }
      }
      fs.appendFileSync(paths.mailOutbox, JSON.stringify(row) + '\n', { mode: 0o600 });
      logger.log(`[mail:log] to ${msg.to}: ${msg.subject}\n${msg.text}`);
      return;
    }
    const p = deliver(msg)
      .catch((e) => logger.error(`[mail:${provider}] send failed (${msg.subject}): ${e.message}`))
      .finally(() => pending.delete(p));
    pending.add(p);
  }

  return {
    provider,
    transportOptions: () => (provider === 'smtp' ? smtp().options : null),
    available: () => !!provider,
    send,
    prune,
    forget,
    flush: () => Promise.all([...pending]),
  };
}

module.exports = { createMailer, OUTBOX_KEEP_MS, SMTP_TIMEOUTS };
