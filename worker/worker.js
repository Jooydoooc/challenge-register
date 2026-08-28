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
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;

/** Fields we accept. Anything else in the payload is dropped. */
const FIELDS = [
  { key: 'name', label: 'Name', required: true, max: 100 },
  { key: 'phone', label: 'Phone', required: true, max: 30 },
  { key: 'telegram', label: 'Telegram', required: true, max: 40 },
  { key: 'email', label: 'Email', required: false, max: 120 },
  { key: 'course', label: 'Course', required: true, max: 40 },
  { key: 'level', label: 'Level', required: true, max: 40 },
  { key: 'timeline', label: 'Days to goal', required: false, max: 12 },
  { key: 'source', label: 'Heard via', required: false, max: 40 },
  { key: 'notes', label: 'Notes', required: false, max: 500 },
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
    if (!sent) {
      // This does cost the student one of their attempts. Refunding it was
      // tried and removed: decrementing the same counter let anyone who could
      // force a failure reset their own limit indefinitely.
      // Never surface Telegram's response; its error text can echo the token.
      return json({ ok: false, error: 'Could not deliver your registration. Please try again.' }, 502, cors);
    }

    // The spreadsheet is a convenience copy, not the record of truth: Telegram
    // already has this registration. So it runs after the response is decided
    // and its failure never reaches the student — a slow or broken Apps Script
    // must not make a successful signup look broken.
    const sheetWrite = appendToSheet(env, data, request, suspicious);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(sheetWrite);

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

function validate(payload) {
  const data = {};
  const errors = [];

  for (const field of FIELDS) {
    const value = typeof payload[field.key] === 'string' ? payload[field.key].trim() : '';
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
  if (data.timeline && !/^\d{1,4}$/.test(data.timeline)) {
    errors.push('Days to goal must be a number');
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
 * A fixed window in the key, rather than a rolling TTL, so five submissions
 * spread over three hours do not keep extending a one-hour block.
 *
 * @returns {{blocked: boolean, reason?: 'limit'|'unavailable'}}
 */
/**
 * An IPv6 client typically controls an entire /64, which is 18 quintillion
 * addresses. Counting the full address would let anyone on IPv6 take five
 * registrations per address and bypass the limit completely, so count the /64.
 * IPv4 addresses are used whole.
 */
function rateLimitScope(ip) {
  if (!ip.includes(':')) return ip;
  return ip.split(':').slice(0, 4).join(':') + '::/64';
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
  const cut = escaped.slice(0, limit).replace(/&[a-z0-9#]*$/i, '');
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

  if (data.reading.length) {
    lines.push('', `<b>Reading — struggles with:</b>`, data.reading.map((r) => `• ${esc(r)}`).join('\n'));
  }
  if (data.listening.length) {
    lines.push('', `<b>Listening — struggles with:</b>`, data.listening.map((l) => `• ${esc(l)}`).join('\n'));
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
  return text.slice(0, MAX_MESSAGE_CHARS - 20).replace(/\n[^\n]*$/, '') + '\n…';
}

async function sendToTelegram(env, data, request, suspicious) {
  if (!env.BOT_TOKEN || !env.CHAT_ID) {
    console.error('BOT_TOKEN or CHAT_ID is not set');
    return false;
  }

  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.CHAT_ID,
        text: buildMessage(data, request, suspicious),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || !result.ok) {
      // Log the description only. Never log the url, which contains the token.
      // Status included so `wrangler tail` shows something useful when the
      // response is not JSON and `result` is null.
      console.error('Telegram rejected:', response.status, result && result.description);
      return false;
    }
    return true;
  } catch (error) {
    console.error('Telegram request failed:', error && error.name);
    return false;
  }
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
function buildRow(data, request, suspicious) {
  return [
    new Date().toISOString(),
    data.name,
    // Leading ' so Sheets keeps "+998..." as text instead of reading the + as a
    // formula and showing #NAME?.
    `'${data.phone}`,
    '@' + data.telegram.replace(/^@/, ''),
    data.email || '',
    data.course,
    data.level,
    data.timeline || '',
    data.reading.join(', '),
    data.listening.join(', '),
    data.source || '',
    data.notes || '',
    (request.cf && request.cf.country) || '',
    suspicious ? 'BOT TRAP' : '',
  ];
}

/**
 * Append the row to the Google Sheet, if a webhook is configured.
 *
 * Never throws and never returns a failure the caller acts on: the spreadsheet
 * is a copy, and Telegram already holds the registration. Problems show up in
 * `wrangler tail` only.
 */
async function appendToSheet(env, data, request, suspicious) {
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
        row: buildRow(data, request, suspicious),
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
