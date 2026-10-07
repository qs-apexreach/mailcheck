# MailCheck v1.1

MailCheck checks an email address's **format, domain and mail setup** and gives it a score: **Good**, **Risky**, **Bad** or **Unknown**.

It runs on Netlify with one Node.js function. It needs no paid services, no API keys and no npm packages.

## What is new in v1.1

- **Smarter typo checks:** `gmial.com`, `gmai.com`, `gamil.com`, `gmail.co`, `hotmail.co`, `protonmail.co`, `yaho.com`, `outlok.com` and many more now suggest the right domain, while real domains such as `yahoo.co.nz`, `google.org` or `amazon.co.uk` are left alone.
- **Faster results for big domains:** the SPF/DMARC lookups now stop after 2 seconds. If they are slow, that line shows "Unknown" and the score is **not** changed.
- **Optional abuse guard:** you can make the function accept requests only from your own site (see "Lock the function to your own site").
- **Clearer deploy steps:** GitHub + Netlify is now the recommended way, and drag and drop is explained as unreliable for functions.

The JSON answer has not changed at all: same keys, same statuses, same score values.

## Folder layout

```
mailcheck/
├── index.html                      (Step 1)
├── netlify.toml                    Netlify settings + security headers
├── package.json
├── assets/
│   └── favicon.svg                 (Step 1)
├── css/                            (Step 2)
├── js/
│   └── app.js                      (Step 2)  <- contains USE_MOCK
├── netlify/
│   └── functions/
│       └── check-email.js          the real checker
├── data/
│   └── disposable-domains.json     list of disposable email domains
├── scripts/
│   └── update-disposable.js        optional: refresh the disposable list
└── test/
    └── run-tests.js                the tests
```

> **Warning: the settings file must be named exactly `netlify.toml`.**
> - Not `netlify.toml.txt`, not `Netlify.toml`, not `netlify (1).toml`. Netlify's systems are case-sensitive, so use small letters only.
> - It must sit in the **top folder, right next to `index.html`**, not inside another folder.
> - **Windows tip:** Windows often hides file endings, so Notepad can quietly save `netlify.toml.txt`. In File Explorer, open the **View** menu and turn on **File name extensions** to see the real name. When you save in Notepad, set "Save as type" to **All files**.
> - If this file is wrong, the function is not found and you get a 404 error.

## What this tool can and cannot confirm

**It checks:**

- the **format** of the address (length, characters, dots, ending like `.com`)
- whether the **domain** exists
- the **mail servers (MX)** of the domain
- **SPF and DMARC** records (signs of a well-run mail setup)
- **disposable** (temporary) email domains
- **role** addresses such as `info@` or `support@`
- **free provider vs business** domain (Gmail, Yahoo... vs a company domain)
- likely **typos** (`gmial.com` → `gmail.com`)

**It cannot:**

- confirm that **one specific mailbox exists** (for example, that `john@company.com` is a real inbox)
- detect **catch-all domains** (domains that accept mail for any name)
- predict **bounces perfectly**: a "Good" result means the domain and its mail setup look healthy, not that every message will arrive

Every result includes `"mailbox_verified": false` as a reminder.

### What the scores mean

| Score | Meaning |
|---|---|
| **Bad** | Invalid format, domain does not exist, domain does not accept email (no MX or "null MX"), or a disposable domain. |
| **Unknown** | The DNS lookup for the domain or its mail servers had a temporary problem (timeout, server error), so no decision was possible. Try again later. A temporary problem is **never** treated as "dead". |
| **Risky** | Possible typo, no MX record (mail may fall back to the main server), a role address like `info@`, or the domain has neither SPF nor DMARC. |
| **Good** | None of the problems above were found. |

- A free provider (Gmail, Yahoo, ...) shows a warning on its own line but does **not** lower the score. To change that, set `TREAT_FREE_AS_RISKY: true` at the top of `netlify/functions/check-email.js`.
- The SPF/DMARC line can say "Unknown" (a slow lookup) and this **never** changes the score.
- A bad result is still a normal answer (HTTP 200 with `"score": "bad"`). Only technical problems (wrong method, broken JSON, oversized request, blocked origin, server error) return an error code.

## How the typo check works

1. **Known mistakes** are matched first (`gmial.com`, `gmai.com`, `gamil.com`, `yaho.com`, `outlok.com`, `iclod.com`...).
2. **Same name, wrong ending:** `gmail.co`, `hotmail.co` and `protonmail.co` suggest the `.com` version. Only endings that look like typos of `.com` count (`co`, `cm`, `om`, `con`, `cmo`, `vom`, `coom`, `ocm`, `comm`, `xom`, `c0m`, `cim`, `cpm`).
3. **Fuzzy match:** the name before the first dot is compared with popular names. One edit is allowed, or two edits if the name has 8 or more letters. Swapping two neighbouring letters counts as one edit. The ending (like `.com` or `.co.uk`) must be the same.

Never flagged: any domain already on the popular list, real regional domains (`yahoo.co.nz`, `yahoo.com.ar`, `amazon.co.uk`), other endings (`google.org`), very short names (`q.com`), and look-alike names such as `olive.com` (which is not `live.com`).

A typo makes the score **Risky**, not Bad, because the domain might be real. The reason always says "Did you mean ...?".

## Run it on your computer

1. Install **Node.js** (the "LTS" version) from <https://nodejs.org>. Node 18 or newer is needed.
2. Open a terminal **inside the `mailcheck` folder**.
3. Run:
   ```
   npx netlify-cli dev
   ```
   The first time, it asks to install the Netlify tool. Answer `y`. If it asks about logging in or linking a site, you can skip that; local testing does not need it.
4. Open the local address it prints (usually `http://localhost:8888`).

> Do not open `index.html` by double-clicking it, and do not use a simple "Live Server" tool. Those do not run the function, so you would get a 404 error.

### Run the tests

```
npm test
```

It prints `PASS` or `FAIL` for each case and ends with a line like `134 passed, 0 failed`.

- The **offline** tests use a fake DNS and need no internet.
- The **online** tests (clearly marked) use real DNS. If you are offline, they print `SKIP` instead of failing.
- To run only the offline tests: `node test/run-tests.js --offline`
- One test waits about 2 seconds on purpose (it simulates a hanging SPF lookup), so the full run takes a few seconds.

## Switch from demo mode to the real checker

Open `js/app.js`, find this line and change `true` to `false`:

```js
// before
const USE_MOCK = true;
// after
const USE_MOCK = false;
```

Save the file. The "Demo mode" label should disappear.

## Deploy to Netlify

### First, a note about Netlify credits

Netlify's free plan is **credit-based**, and **each production deploy uses credits**. At the time of writing, Netlify's documentation lists 300 free credits per month and 15 credits per production deploy. That is only 20 production deploys a month (300 ÷ 15), before anything else uses credits. Function calls and bandwidth also use credits. Deploy previews are listed as free, and failed deploys and rollbacks are listed as not using credits.

So: **make several changes first, test them on your computer, and deploy once.**

These numbers can change, and accounts created before the credit system may be on an older plan. **Check Netlify's pricing page for the current numbers: <https://www.netlify.com/pricing/>.**

### Option A (recommended): GitHub + Netlify

This is the most reliable way, and every later update is automatic.

1. Create a free account at <https://github.com> and click **New repository**. Name it `mailcheck` and click **Create repository**.
2. Add your files. On the new repository page click **uploading an existing file**. Open your `mailcheck` folder on your computer, select **everything inside it** (the `netlify` folder, `data`, `js`, `css`, `assets`, `test`, `scripts`, `index.html`, `netlify.toml`, `package.json`, `README.md`) and drag it all into the browser window. Wait for the upload to finish, then click **Commit changes**.
3. **Check the top level of your repository.** You must see `netlify.toml` and `index.html` side by side, and a `netlify` folder. If they are inside an extra `mailcheck` folder, delete the repository and upload again, this time selecting the files **inside** the folder.
4. In Netlify (<https://app.netlify.com>) choose **Add new project** (older screens say **Add new site**), then **Import an existing project**, then **GitHub**. Allow access and pick the `mailcheck` repository.
5. Settings: leave **Build command** empty. Set **Publish directory** to `.` (a single dot). The functions folder is read from `netlify.toml`.
6. Click **Deploy** and wait for "Published".
7. Open the **Functions** page for your project (look for "Functions" in the menu or tabs) and check that `check-email` is listed.

From now on, **every change you commit to the main branch starts a new production deploy**, which uses credits. Upload or edit several files in **one** commit.

### Option B: Netlify CLI

This also supports functions, and it is good when you do not want to use GitHub.

1. Install Node.js (see "Run it on your computer").
2. Open a terminal **inside the `mailcheck` folder**.
3. Log in (a browser window opens):
   ```
   npx netlify-cli login
   ```
4. Deploy to your live site:
   ```
   npx netlify-cli deploy --prod
   ```
   The first time, it asks whether to create a new site or link an existing one. Choose to create a new one and follow the questions. If it asks for a publish directory, type a single dot (`.`).
5. When it finishes it prints your live address. Then check the **Functions** page in Netlify for `check-email`.

Each `deploy --prod` is a production deploy and uses credits. `npx netlify-cli deploy` (without `--prod`) makes a test deploy at a separate address so you can check things first; see the pricing page for how test deploys are counted.

### Drag and drop: NOT reliable for functions

Netlify's drag-and-drop ("manual") deploy is meant for plain static pages. Netlify's own support staff describe it as the least capable upload method, and it often does **not** pick up functions. **Do not use it for MailCheck.** Use Option A or B. (You can use drag and drop for a static-only site that has no `netlify/functions` folder.)

## Lock the function to your own site (optional)

By default anyone who knows your function's address can call it, and every call uses a little of your Netlify credits. To accept requests only from your own site:

1. Find your site address in the browser address bar, for example `https://my-mailcheck.netlify.app` (no path, no slash at the end).
2. Open `netlify/functions/check-email.js` and find `ALLOWED_ORIGINS` near the top.
3. Put your address in the list:
   ```js
   ALLOWED_ORIGINS: ["https://my-mailcheck.netlify.app"],
   ```
   Own domain too? Add it as a second item. Testing on your computer with `netlify dev`? Also add `"http://localhost:8888"`.
4. Commit and deploy once.

Other websites then get `403 {"error":"Not allowed."}`. Netlify deploy-preview addresses are blocked unless you add them. An empty list `[]` (the default) allows everyone.

This is a light guard, not strong security: a script outside a browser can fake the Origin header. It stops other **websites** from using your function.

## The disposable-domain list is partial

`data/disposable-domains.json` contains about 550 well-known disposable and temporary email domains. **It is not complete.** New disposable domains appear every day, so some will not be caught.

### How to refresh it

The free open-source project **disposable-email-domains** keeps a much bigger list (several thousand domains):
<https://github.com/disposable-email-domains/disposable-email-domains>

1. On that page, open the file `disposable_email_blocklist.conf` and click **Raw**, then save the page as `disposable_email_blocklist.conf` inside your `mailcheck` folder.
2. In the terminal, inside the `mailcheck` folder, run:
   ```
   node scripts/update-disposable.js disposable_email_blocklist.conf
   ```
   This keeps your current domains, adds the new ones, removes duplicates, and rewrites `data/disposable-domains.json` in the correct shape.
3. Run `npm test`, then deploy once.

The project itself says that not every domain on its list is still disposable today, so treat the list as a strong hint rather than proof. After a refresh, some typo domains such as `gmial.com` may show **Bad** (they are on that list) instead of **Risky**. They still say "Did you mean gmail.com?".

## Safe sending tips

- **Remove Bad and Risky emails** before you send. Bad ones will almost certainly fail. Look at Risky ones one by one (a typo can often be fixed).
- **Send small batches first** (for example 50 to 100 emails) before sending to the whole list.
- **Watch your bounce rate.** If many emails bounce, stop and clean the list. Many email providers advise keeping bounces to a small fraction, often quoted as around 2% or lower.
- Remember that even a "Good" score does not prove that the person's inbox exists. Some bounces are normal.
- Only email people who agreed to hear from you, and always include an easy way to unsubscribe.
- Set up SPF, DKIM and DMARC for **your own** sending domain.

## Settings

All settings are at the top of `netlify/functions/check-email.js`, in one `CONFIG` object:

| Setting | Default | Meaning |
|---|---|---|
| `DNS_TIMEOUT_MS` | 3000 | How long one DNS question may take. |
| `DNS_DEADLINE_MS` | 4000 | Hard stop for the MX, A and AAAA lookups. |
| `TXT_DEADLINE_MS` | 2000 | Hard stop for the two SPF/DMARC lookups. Slow = "Unknown", score unchanged. |
| `CACHE_TTL_MS` | 600000 | How long a finished domain is remembered (10 minutes). |
| `CACHE_TTL_SHORT_MS` | 120000 | How long a domain is remembered when only SPF/DMARC was inconclusive (2 minutes). |
| `CACHE_MAX_ENTRIES` | 500 | Maximum domains remembered. |
| `TREAT_FREE_AS_RISKY` | false | `true` makes free providers (Gmail etc.) score "risky". |
| `MAX_BODY_BYTES` | 2048 | Requests bigger than this are rejected. |
| `ALLOWED_ORIGINS` | `[]` | Empty = allow everyone. Add your site address to lock it. |

The cache lives in memory, so it only lasts while the function instance is warm. Netlify can restart the function at any time, which empties it. Results where the domain or the mail servers could not be read are never remembered.

## Privacy

The function never logs full email addresses. It logs only the domain, the score and DNS error codes.

## Troubleshooting

**The function gives a 404 error** (for example `/.netlify/functions/check-email` not found)

- Check the file is named exactly `netlify.toml` (see the warning near the top) and sits next to `index.html`.
- Check that the function file is exactly `netlify/functions/check-email.js`.
- On your computer, start the site with `npx netlify-cli dev` (not by double-clicking `index.html`).
- On Netlify, open the **Functions** page. If `check-email` is missing, you probably used drag and drop. Redeploy with Option A or B.

**The function answers 403 "Not allowed."**

- `ALLOWED_ORIGINS` has values and your page's address is not in the list. Add the exact address from your browser's address bar (including `http://localhost:8888` for local testing), or set it back to `[]`.

**Everything shows Unknown**

- "Unknown" means the DNS lookup had a temporary problem. Wait a minute and try again.
- Check your own internet connection. Some company or school networks block DNS lookups.
- On Netlify, open the function's logs: they list the domain and DNS error codes (such as `ETIMEOUT`).
- If only the **SPF/DMARC** line shows Unknown but the score is Good or Risky, that is normal: those lookups are cut off after 2 seconds on purpose, and it does not change the score.

**The "Demo mode" label is still showing**

- Open `js/app.js` and make sure the line reads `const USE_MOCK = false;`.
- Save, then redeploy (or refresh the local page).
- Force your browser to reload the file: **Ctrl + Shift + R** (Windows/Linux) or **Cmd + Shift + R** (Mac). Your browser may be holding on to the old `app.js`.

**A test domain such as `example.org` shows Bad**

- That is correct. Example domains publish a "null MX" record saying they accept no email. Use a real company address for your tests.
