# Setup

Two pieces: the page (`public/index.html`) and the relay (`worker/`). The relay exists so your bot
token never appears in the page source.

Total time: about 15 minutes. Everything used here is free.

---

## 1. Create the bot

1. Open Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`.
2. Give it a name and a username ending in `bot`.
3. Copy the token it gives you. It looks like `1234567890:AAH...`. Treat it like a password.

## 2. Find your chat ID

**Option A, messages come to you personally:**

1. Send any message to your new bot (this is required; bots cannot message you first).
2. In a terminal, not a browser, run:
   ```bash
   read -rs TOKEN            # paste the token, press enter (it stays hidden)
   curl -s "https://api.telegram.org/bot$TOKEN/getUpdates" | grep -o '"id":[-0-9]*'
   ```
   A browser would put the token in your history, in sync, and in any screenshot
   of the address bar.
3. The first id is your `CHAT_ID`. Do not paste the full response anywhere: it
   contains the token in the URL if you copy the address too.

**Option B, messages come to a channel you and your team can see:**

1. Create a channel.
2. Add your bot as an administrator with permission to post.
3. For a **public** channel, `CHAT_ID` is `@yourchannelname`. For a **private** channel
   there is no username: post something in the channel, then read `getUpdates` as above and
   use the negative id (it starts with `-100`).

## 3. Deploy the relay

```bash
npm install -g wrangler
wrangler login
cd worker
```

Create the rate-limit store and paste the returned id into `wrangler.toml`:

```bash
wrangler kv namespace create RATELIMIT
```

Store the secrets (these are encrypted and never written to disk in the repo):

```bash
wrangler secret put BOT_TOKEN     # paste the BotFather token
wrangler secret put CHAT_ID       # paste the chat id from step 2
```

Edit `wrangler.toml` and set `ALLOWED_ORIGIN` to wherever the page will live, for example:

```toml
ALLOWED_ORIGIN = "https://challenge-register.pages.dev"
```

Deploy:

```bash
wrangler deploy
```

Copy the URL it prints, something like
`https://course-registration.your-name.workers.dev`.

## 4. Connect the page

Open `public/index.html`, find the `CONFIG` block near the top of the `<script>`, and set:

```js
endpoint: 'https://course-registration.your-name.workers.dev',
```

Everything else on the page comes from the same block: course name, tagline, the hero
facts panel, the "what you study" entries, the registration form's course/level/format
options and the two difficulty checklists, and your contact details. That block is the
only place with content in it. Nothing else in the file needs editing.

If you change `courses`, `levels`, `formats`, the `#source` options, or either difficulty
list, make the same change to the matching arrays at the top of `worker/worker.js`. They
fail differently, which matters when debugging:

| Field | If the Worker does not recognise the value |
|---|---|
| course, level, format | Rejected with a 400 — the student sees an error |
| source, reading, listening | Silently dropped — the field just vanishes from the message |

So a renamed difficulty produces no error anywhere; it simply stops appearing. If a field
you expect is missing from a registration, check this first.

## 5. Test it

Test against the deployed page, <https://challenge-register.pages.dev>, not a local
server. `ALLOWED_ORIGIN` lists only the live origin, so a form served from `localhost`
will be refused.

To test locally instead, temporarily add `,http://localhost:8000` to `ALLOWED_ORIGIN`,
`wrangler deploy`, run `python3 -m http.server 8000`, and remove it again when you are
finished.

Fill the form and submit. The message should arrive in Telegram within a second or two.

If it does not:

- **A CORS error in the browser console**, and the page shows the generic "We could not
  send that" — your origin is not in `ALLOWED_ORIGIN`. Add it (exact scheme, host and port,
  no trailing slash) and `wrangler deploy` again. The Worker's own "Origin not allowed"
  message is never visible to the page, because a rejected origin gets no CORS header, so
  a console error is the only signal.
- **"Could not deliver your registration"** — the token or chat id is wrong, or you never
  sent that first message to your bot. Re-check step 2, and run `wrangler tail` to see the
  reason Telegram gave.
- **"Registration is not connected yet"** — `CONFIG.endpoint` is still empty.
- **Everything looks fine but nothing arrives, repeatedly** — you may have hit the rate
  limit (5 per IP per hour). Wait, or raise `RATE_LIMIT_MAX`.

Watch the Worker live while testing:

```bash
wrangler tail
```

## 6. Publish the page

Any static host works, and `public/index.html` has no dependencies.

- **Cloudflare Pages** — the page lives in `public/`, which is why the deploy points there
  rather than at the project root. Deploying the root would publish `worker/` and this
  file as static assets:
  ```bash
  wrangler pages deploy public --project-name=challenge-register
  ```
  The project name sets the URL (`https://challenge-register.pages.dev`) and must match
  `ALLOWED_ORIGIN` in `worker/wrangler.toml`. Change one and you must change the other.
- **Netlify Drop** — drag the folder onto <https://app.netlify.com/drop>.
- **GitHub Pages** — push the folder, enable Pages in repository settings.

After publishing, put the real site URL in `ALLOWED_ORIGIN` and redeploy the Worker.

`ALLOWED_ORIGIN` is an exact-match list, so **Cloudflare Pages preview deployments will
not work**: each one gets its own `<hash>.challenge-register.pages.dev` hostname. Only the
production URL is allowed. A preview build's form will fail with a console CORS error and
nothing visible on the page. Add any custom domain to the list explicitly too.

---

## Notes

- **Telegram is your only record.** Nothing is stored in a database. Pin the channel or
  use Telegram search to find past registrations. If you later want a spreadsheet, the
  Worker can write each row to KV or a Google Sheet without any change to `index.html`.
- **Rate limit** is 5 submissions per IP per clock hour, in `worker.js` as
  `RATE_LIMIT_MAX`. A shared office, school or university network shares one IP, so a class
  registering together will hit it; raise it before any session like that.
  It is deliberately approximate. KV has no atomic increment, so the count is read and
  written a few milliseconds apart and a simultaneous burst can exceed the limit. It stops
  repeat submissions and casual abuse, not a determined attacker. If you ever need a real
  limit, Cloudflare's native rate-limiting binding is atomic and costs no KV writes.
- **A failed delivery still costs the student one attempt.** Refunding it was tried and
  removed: decrementing the same counter let anyone who could force a failure reset their
  own limit indefinitely.
- **A 502 loses that registration.** Nothing is queued. The page keeps the student's
  answers and offers your Telegram link, so someone still at the keyboard can retry, but
  someone who closed the tab is gone.
- **Messages headed `⚠️ New registration (bot trap tripped)`** mean the hidden anti-bot
  field was filled. Usually a bot, occasionally a password manager on a real student's
  browser, so check rather than delete.
- **Free tier limits:** 100,000 Worker requests a day, 100,000 KV reads a day, and
  **1,000 KV writes a day**. Writes are the real ceiling, since every submission that
  passes validation is one write. If either quota is exhausted the Worker fails closed:
  students see "We cannot accept registrations right now" and are pointed at Telegram,
  rather than the limiter silently switching off.
- **If you remove the `[[kv_namespaces]]` block** to force a deploy through, rate limiting
  is disabled entirely and `wrangler tail` will say so on every request.
- **`ALLOWED_ORIGIN` stops other websites, not determined abuse.** Browsers enforce it, but
  anyone can set an `Origin` header by hand from a script. Combined with the rate limit
  that is enough to keep a course signup form quiet. If you ever get targeted spam, add a
  [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) widget to the form
  and verify its token in the Worker; that is the real fix, and nothing else here changes.
- **Rotating the token:** send `/revoke` to BotFather, then `wrangler secret put BOT_TOKEN`
  with the new one. The page needs no change, which is the point of the relay.
