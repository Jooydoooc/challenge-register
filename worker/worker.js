/**
 * Course registration -> Telegram relay.
 *
 * The browser never sees the bot token. The page POSTs JSON here; this Worker
 * validates it, rate-limits by IP, and forwards a formatted message to Telegram.
 *
 * Required secrets (wrangler secret put ...):
 *   BOT_TOKEN  - from @BotFather
 *   CHAT_ID    - your user id, group id, or @channelname
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
  { key: 'format', label: 'Format', required: true, max: 20 },
  { key: 'timeline', label: 'Days to goal', required: false, max: 12 },
  { key: 'source', label: 'Heard via', required: false, max: 40 },
  { key: 'notes', label: 'Notes', required: false, max: 500 },
];

/**
 * Closed sets for every field the page renders as a fixed choice. The browser
 * can send anything, so these are re-checked here. Keep in step with the
 * CONFIG block in public/index.html.
 */
const COURSES = ['Marathon', 'Offline classes', 'Challenge'];
const LEVELS = ['Beginner', 'Elementary', 'Pre-IELTS', 'IELTS Introduction', 'IELTS Graduation'];
const FORMATS = ['Offline', 'Online'];
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
  async fetch(request, env) {
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

    // Honeypot: real users never fill this. Answer 200 so bots do not learn.
    if (typeof payload.company_ref === 'string' && payload.company_ref.trim() !== '') {
      return json({ ok: true }, 200, cors);
    }

    const { data, errors } = validate(payload);
    if (errors.length) {
      return json({ ok: false, error: errors[0], fields: errors }, 400, cors);
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const limited = await hitRateLimit(env, ip);
    if (limited) {
      return json(
        { ok: false, error: 'Too many submissions. Please try again later or message us on Telegram.' },
        429,
        cors
      );
    }

    const sent = await sendToTelegram(env, data, request);
    if (!sent) {
      // Never surface Telegram's response; its error text can echo the token.
      return json({ ok: false, error: 'Could not deliver your registration. Please try again.' }, 502, cors);
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
  // Group text is generated by the page from its own schedule, so we cannot
  // enumerate it here. Constrain the characters instead, so it stays a label
  // and cannot be used to write a paragraph into the channel.
  if (data.course && !COURSES.includes(data.course)) {
    errors.push('Course is not valid');
  }
  if (data.level && !LEVELS.includes(data.level)) {
    errors.push('Level is not valid');
  }
  if (data.format && !FORMATS.includes(data.format)) {
    errors.push('Format is not valid');
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

async function hitRateLimit(env, ip) {
  if (!env.RATELIMIT) {
    // No KV bound. Local dev, or someone removed the binding to get a deploy
    // through. Allow the request but make it visible in `wrangler tail`.
    console.warn('RATELIMIT KV is not bound: rate limiting is disabled');
    return false;
  }
  const key = `rl:${ip}`;
  try {
    const current = Number((await env.RATELIMIT.get(key)) || 0);
    if (current >= RATE_LIMIT_MAX) return true;
    await env.RATELIMIT.put(key, String(current + 1), {
      expirationTtl: RATE_LIMIT_WINDOW_SECONDS,
    });
    return false;
  } catch (error) {
    // Most likely the KV daily write quota. Fail closed: an endpoint that
    // relays to a chat should go quiet rather than become an open relay.
    console.error('RATELIMIT KV error, failing closed:', error && error.message);
    return true;
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

function buildMessage(data, request) {
  const country = request.cf && request.cf.country ? request.cf.country : null;
  const telegram = data.telegram.replace(/^@/, '');
  const phoneDigits = data.phone.replace(/[^\d+]/g, '');

  const lines = [
    '🎓 <b>New course registration</b>',
    '',
    `<b>Name:</b> ${esc(data.name)}`,
    // Encoded for safety, but a leading + must survive for the dialer.
    `<b>Phone:</b> <a href="tel:${encodeURIComponent(phoneDigits).replace(/%2B/g, '+')}">${esc(data.phone)}</a>`,
    `<b>Telegram:</b> <a href="https://t.me/${encodeURIComponent(telegram)}">@${esc(telegram)}</a>`,
  ];

  if (data.email) lines.push(`<b>Email:</b> ${esc(data.email)}`);

  lines.push(
    '',
    `<b>Course:</b> ${esc(data.course)} · ${esc(data.format)}`,
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
  if (data.notes) lines.push('', `<b>Notes:</b>`, esc(data.notes));
  if (country) lines.push('', `<i>${esc(country)}</i>`);

  return lines.join('\n');
}

async function sendToTelegram(env, data, request) {
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
        text: buildMessage(data, request),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || !result.ok) {
      // Log the description only. Never log the url, which contains the token.
      console.error('Telegram rejected the message:', result && result.description);
      return false;
    }
    return true;
  } catch (error) {
    console.error('Telegram request failed:', error && error.name);
    return false;
  }
}
