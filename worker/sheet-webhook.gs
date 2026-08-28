/**
 * Google Apps Script: appends each registration to the spreadsheet this script
 * is bound to.
 *
 * This file is not deployed by wrangler. Paste it into Extensions > Apps Script
 * from inside the sheet, then deploy it as a web app. Full steps are in
 * SETUP.md, section 7.
 *
 * The column order below must match buildRow() in worker/worker.js.
 */

/**
 * Shared secret. Must equal the SHEET_WEBHOOK_TOKEN secret on the Worker.
 * The /exec URL has to be readable by "anyone", so this is what actually stops
 * a stranger who guesses or finds the URL from writing rows into your sheet.
 * Generate one with:  openssl rand -hex 24
 */
const SHEET_TOKEN = 'PASTE_A_LONG_RANDOM_STRING_HERE';

/** Written once, on the first append into an empty sheet. */
const HEADERS = [
  'Timestamp (UTC)',
  'Name',
  'Phone',
  'Telegram',
  'Email',
  'Course',
  'Level',
  'Format',
  'Days to goal',
  'Reading struggles',
  'Listening struggles',
  'Heard via',
  'Notes',
  'Country',
  'Flag',
];

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return reply({ ok: false, error: 'No body' });
    }

    const payload = JSON.parse(e.postData.contents);

    // Constant-time-ish: compare lengths first so a mismatch in length does not
    // short-circuit on the first character. Apps Script has no timing-safe
    // compare, and the token is long and random, so this is enough here.
    if (!payload.token || payload.token.length !== SHEET_TOKEN.length ||
        payload.token !== SHEET_TOKEN) {
      return reply({ ok: false, error: 'Bad token' });
    }
    if (!Array.isArray(payload.row)) {
      return reply({ ok: false, error: 'Missing row' });
    }

    // Two registrations arriving together would otherwise both read the same
    // "last row" and one would overwrite the other.
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
      if (sheet.getLastRow() === 0) {
        sheet.appendRow(HEADERS);
        sheet.setFrozenRows(1);
      }
      // Trim to the header width so a Worker that gained a column cannot widen
      // the sheet silently and leave every earlier row misaligned.
      sheet.appendRow(payload.row.slice(0, HEADERS.length));
    } finally {
      lock.releaseLock();
    }

    return reply({ ok: true });
  } catch (error) {
    return reply({ ok: false, error: String(error) });
  }
}

/**
 * Apps Script web apps always answer 200, so the Worker reads this body to tell
 * a rejected token from a written row.
 */
function reply(body) {
  return ContentService
    .createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}
