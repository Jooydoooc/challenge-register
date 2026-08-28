/**
 * Google Apps Script: append each registration to a spreadsheet.
 *
 * The Worker already delivered the registration to Telegram before calling
 * this, so the sheet is a searchable backup rather than the record of truth.
 * A failure here never reaches the student.
 *
 * ── Setup ────────────────────────────────────────────────────────────────
 * 1. Create a Google Sheet. Extensions → Apps Script. Paste this file in,
 *    replacing whatever is there. Save.
 *
 * 2. Pick a long random shared secret. In the Apps Script editor:
 *    Project Settings (the gear) → Script Properties → Add script property
 *      Property: SHEET_TOKEN
 *      Value:    <your secret>
 *    Do not put the secret in this file: anyone you share the Sheet with can
 *    read the script.
 *
 * 3. Deploy → New deployment → type "Web app".
 *      Execute as:        Me
 *      Who has access:    Anyone
 *    "Anyone" is required because Cloudflare calls this without a Google
 *    login. SHEET_TOKEN is what actually protects it, which is why it must
 *    be long and random.
 *    Copy the /exec URL.
 *
 * 4. Give the Worker both values:
 *      wrangler secret put SHEET_WEBHOOK_URL     # the /exec URL
 *      wrangler secret put SHEET_WEBHOOK_TOKEN   # the same SHEET_TOKEN
 *    Setting only one of the two leaves the feature off.
 *
 * 5. Register once on the live form and check a row appears.
 *
 * Re-deploying after an edit: Deploy → Manage deployments → edit → Version:
 * New version. Editing without a new version leaves the old code running.
 */

/** Column headers, written once. Order must match buildRow() in worker.js. */
var HEADERS = [
  'Received (UTC)',
  'Name',
  'Phone',
  'Telegram',
  'Email',
  'Course',
  'Level',
  'Days to goal',
  'Reading difficulties',
  'Listening difficulties',
  'Heard via',
  'Notes',
  'Country',
  'Flag',   // 'BOT TRAP' or 'NOT SENT TO TELEGRAM' - both need a look
];

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return reply({ ok: false, error: 'No body' });
    }

    var body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (err) {
      return reply({ ok: false, error: 'Invalid JSON' });
    }

    var expected = PropertiesService.getScriptProperties().getProperty('SHEET_TOKEN');
    if (!expected) {
      return reply({ ok: false, error: 'SHEET_TOKEN script property is not set' });
    }
    // Constant-time-ish compare. Apps Script has no timing-safe helper, but
    // comparing lengths first avoids the most obvious leak.
    if (!body.token || body.token.length !== expected.length || body.token !== expected) {
      return reply({ ok: false, error: 'Bad token' });
    }

    if (!Array.isArray(body.row)) {
      return reply({ ok: false, error: 'row must be an array' });
    }
    // Exact length, not "at most". Padding a short row would silently slide
    // every value after a removed column under the wrong heading, which
    // produces a spreadsheet that looks right and is wrong. Better to refuse
    // and have it show up in `wrangler tail`.
    if (body.row.length !== HEADERS.length) {
      return reply({
        ok: false,
        error: 'row has ' + body.row.length + ' columns, expected ' + HEADERS.length +
               '. buildRow() in worker.js and HEADERS here are out of sync.',
      });
    }

    // Apps Script runs up to 30 executions at once, and both the header check
    // and the append are read-then-write. Two students submitting in the same
    // second could otherwise duplicate the header or lose a row. The lock is
    // the documented remedy.
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(20000);
    } catch (err) {
      return reply({ ok: false, error: 'Busy: could not get the sheet lock' });
    }

    try {
      var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];

      // Header row, written only once.
      if (sheet.getLastRow() === 0) {
        sheet.appendRow(HEADERS);
        sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
        sheet.setFrozenRows(1);
      }

      sheet.appendRow(body.row);
      SpreadsheetApp.flush(); // commit before releasing the lock
    } finally {
      lock.releaseLock();
    }

    return reply({ ok: true });
  } catch (err) {
    // Never throw: an Apps Script exception returns an HTML error page, which
    // the Worker would log as an unhelpful null.
    return reply({ ok: false, error: String(err && err.message || err) });
  }
}

/**
 * Apps Script cannot set an HTTP status code, so every response is 200 and
 * the caller has to read `ok` from the body. The Worker does exactly that.
 */
function reply(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Run this from the editor to check the Sheet is writable and the token is
 * set, without going through Cloudflare. Safe: it writes one obvious test row.
 */
function testAppend() {
  var token = PropertiesService.getScriptProperties().getProperty('SHEET_TOKEN');
  if (!token) throw new Error('Set the SHEET_TOKEN script property first.');
  var out = doPost({
    postData: {
      contents: JSON.stringify({
        token: token,
        row: [
          new Date().toISOString(), 'TEST — delete me', "'+998000000000",
          '@test', '', 'DISCIPLINE', 'Pre-IELTS', '35', 'Vocabulary',
          'Spelling', 'Instagram', 'Written by testAppend()', 'UZ', '',
        ],
      }),
    },
  });
  Logger.log(out.getContent());
}
