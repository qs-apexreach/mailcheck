"use strict";

/*
 * MailCheck - Netlify Function (v1.1)
 *
 * What this does: checks the FORMAT, the DOMAIN and its MAIL SETUP
 * (MX, SPF, DMARC), plus disposable / role / free-provider / typo hints.
 *
 * What this does NOT do: it does not confirm that one exact mailbox exists.
 * There is no SMTP, no port 25 and no catch-all detection here.
 *
 * Only built-in Node modules are used. No npm packages, no API keys.
 */

const dns = require("dns");
const url = require("url");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// SETTINGS - change these in one place
// ---------------------------------------------------------------------------
const CONFIG = {
  DNS_TIMEOUT_MS: 3000, // how long one DNS question may take
  DNS_DEADLINE_MS: 4000, // hard stop for the MX, A and AAAA lookups
  TXT_DEADLINE_MS: 2000, // hard stop for the two TXT lookups (SPF and DMARC)
  CACHE_TTL_MS: 10 * 60 * 1000, // remember a finished domain for 10 minutes
  CACHE_TTL_SHORT_MS: 2 * 60 * 1000, // remember a domain for 2 minutes when ONLY SPF/DMARC was inconclusive
  CACHE_MAX_ENTRIES: 500, // never remember more than 500 domains
  TREAT_FREE_AS_RISKY: false, // true = free providers (gmail etc.) become "risky"
  MAX_BODY_BYTES: 2048, // reject request bodies bigger than 2 KB

  // OPTIONAL ABUSE GUARD. An empty list [] means: allow everyone.
  // To accept requests only from your own site, put its address in the list, like this:
  //   ALLOWED_ORIGINS: ["https://my-mailcheck.netlify.app"],
  // How to fill it in:
  //  - Copy the address from your browser's address bar. It starts with https://
  //    and has NO path and NO slash at the end.
  //  - Own domain too? Add it as a second item: "https://mailcheck.example.com".
  //  - Testing on your computer with "netlify dev"? Also add "http://localhost:8888".
  //  - Netlify deploy previews have their own addresses and are blocked unless you add them.
  // This stops OTHER WEBSITES from using your function in a browser. It is a light guard,
  // not strong security: a script outside a browser can fake the Origin header.
  ALLOWED_ORIGINS: [],
};

const NOTE_TEXT =
  "Domain and email setup checked. Mailbox existence is not confirmed.";

// ---------------------------------------------------------------------------
// DATA LISTS
// ---------------------------------------------------------------------------

// Disposable domains: loaded ONCE when the function starts, into a Set.
// We use require() first because the bundler (esbuild) then packs the JSON
// right into the function. The file-system paths are only a backup.
function loadDisposableSet() {
  let data = null;
  try {
    data = require("../../data/disposable-domains.json");
  } catch (e) {
    const file = "disposable-domains.json";
    const candidates = [
      path.join(__dirname, "..", "..", "data", file),
      path.join(process.env.LAMBDA_TASK_ROOT || "/var/task", "data", file),
      path.join(process.cwd(), "data", file),
    ];
    for (const p of candidates) {
      try {
        data = JSON.parse(fs.readFileSync(p, "utf8"));
        break;
      } catch (err) {
        /* try the next path */
      }
    }
  }
  if (!data || !Array.isArray(data.domains)) return null; // null = list not loaded
  return new Set(data.domains.map((d) => String(d).trim().toLowerCase()));
}
const DISPOSABLE_SET = loadDisposableSet();

// Role addresses: shared mailboxes, not a single person.
const ROLE_SET = new Set([
  "info", "admin", "administrator", "contact", "support", "sales", "help",
  "hello", "office", "billing", "accounts", "accounting", "hr", "jobs",
  "careers", "marketing", "team", "noreply", "no-reply", "no_reply",
  "donotreply", "do-not-reply", "postmaster", "webmaster", "abuse", "root",
  "hostmaster", "enquiries", "enquiry", "inquiry", "inquiries", "service",
  "services", "security", "press", "media", "legal", "orders", "order",
  "privacy", "newsletter", "newsletters", "feedback", "mailer-daemon",
  "mailerdaemon", "customerservice", "customer-service", "customercare",
  "finance", "payroll", "recruiting", "recruitment", "reception", "bookings",
  "booking", "reservations", "compliance", "operations", "ops", "dev",
  "sysadmin", "it", "staff", "general", "mail", "email", "all", "everyone",
  "subscribe", "unsubscribe", "bounce", "bounces", "spam", "ceo",
]);

// Free email providers (including regional variants).
const FREE_PROVIDERS = [
  "gmail.com", "googlemail.com",
  "yahoo.com", "yahoo.co.uk", "yahoo.co.in", "yahoo.in", "yahoo.fr",
  "yahoo.de", "yahoo.es", "yahoo.it", "yahoo.ca", "yahoo.com.au",
  "yahoo.com.br", "yahoo.co.jp", "yahoo.com.mx", "yahoo.com.ph",
  "yahoo.com.sg", "yahoo.co.id", "ymail.com", "rocketmail.com",
  "outlook.com", "outlook.fr", "outlook.de", "outlook.es", "outlook.it",
  "hotmail.com", "hotmail.co.uk", "hotmail.fr", "hotmail.de", "hotmail.it",
  "hotmail.es", "live.com", "live.co.uk", "live.fr", "live.de", "live.it",
  "msn.com", "icloud.com", "me.com", "mac.com",
  "aol.com", "aim.com", "proton.me", "protonmail.com", "protonmail.ch",
  "pm.me", "gmx.com", "gmx.net", "gmx.de", "gmx.at", "gmx.us", "mail.com",
  "email.com", "zoho.com", "zohomail.com", "yandex.com", "yandex.ru",
  "ya.ru", "mail.ru", "inbox.ru", "list.ru", "bk.ru", "qq.com", "163.com",
  "126.com", "sina.com", "foxmail.com", "rediffmail.com", "tutanota.com",
  "tutanota.de", "tuta.io", "tuta.com", "fastmail.com", "fastmail.fm",
  "hushmail.com", "mailfence.com", "web.de", "t-online.de", "freenet.de",
  "orange.fr", "free.fr", "wanadoo.fr", "laposte.net", "libero.it",
  "virgilio.it", "naver.com", "daum.net", "hanmail.net", "cox.net",
  "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "bellsouth.net",
  "btinternet.com", "sky.com", "blueyonder.co.uk", "shaw.ca", "rogers.com",
  "bigpond.com", "optusnet.com.au", "seznam.cz", "wp.pl", "o2.pl", "onet.pl",
  "uol.com.br", "bol.com.br", "terra.com.br", "rambler.ru",
];
const FREE_SET = new Set(FREE_PROVIDERS);

// A few big non-free names, used only for typo hints.
const BIG_NAMES = [
  "google.com", "microsoft.com", "amazon.com", "facebook.com",
  "linkedin.com", "paypal.com", "salesforce.com",
];
const POPULAR_LIST = FREE_PROVIDERS.concat(BIG_NAMES);
const POPULAR_SET = new Set(POPULAR_LIST);

// The most common mistakes, checked first. Each one points to the right domain.
const KNOWN_TYPOS = new Map(Object.entries({
  "gmial.com": "gmail.com", "gmai.com": "gmail.com", "gmal.com": "gmail.com",
  "gamil.com": "gmail.com", "gmil.com": "gmail.com", "gmaill.com": "gmail.com",
  "gnail.com": "gmail.com",
  "hotmial.com": "hotmail.com", "hotmal.com": "hotmail.com",
  "yaho.com": "yahoo.com", "yahooo.com": "yahoo.com",
  "outlok.com": "outlook.com", "outlook.co": "outlook.com",
  "iclod.com": "icloud.com",
}));

// Endings that look like a typo of ".com".
// co, cm and om are REAL country endings, so they are only used for well-known
// names (gmail.co -> gmail.com), never for unknown domains.
const TYPO_ENDINGS = new Set([
  "co", "cm", "om", "con", "cmo", "vom", "coom", "ocm", "comm", "xom", "c0m", "cim", "cpm",
]);
// These endings do NOT exist, so ".com" is a safe guess for any domain (acme.con -> acme.com).
const FAKE_ENDINGS = new Set([
  "con", "cmo", "vom", "coom", "ocm", "comm", "xom", "c0m", "cim", "cpm",
]);

// Names shorter than this are never fuzzy-matched (too many real look-alikes).
const MIN_NAME_LEN = 5;

// Split "yahoo.co.uk" into name "yahoo" (before the first dot) and ending "co.uk".
function splitDomain(domain) {
  const i = domain.indexOf(".");
  return { name: domain.slice(0, i), ending: domain.slice(i + 1) };
}
const POPULAR_PARTS = POPULAR_LIST.map((d) => Object.assign({ domain: d }, splitDomain(d)));

// ---------------------------------------------------------------------------
// SMALL HELPERS
// ---------------------------------------------------------------------------

function respond(statusCode, bodyObject, extraHeaders) {
  return {
    statusCode,
    headers: Object.assign(
      { "Content-Type": "application/json", "Cache-Control": "no-store" },
      extraHeaders || {}
    ),
    body: JSON.stringify(bodyObject),
  };
}

function check(status, detail) {
  return { status, detail };
}

// A check that could not run (for example because the format is invalid).
function skipped(why) {
  return check("unknown", "Skipped because " + why + ".");
}

// Damerau-Levenshtein distance = the fewest single-letter edits that turn a into b.
// An edit is: add a letter, remove a letter, change a letter, or SWAP two
// neighbouring letters. So "gmial" -> "gmail" is 1 edit (a swap), not 2.
function damerauLevenshtein(a, b) {
  if (a === b) return 0;
  const maxDist = a.length + b.length;
  const lastRowOfChar = Object.create(null); // last row where each letter was seen in a
  const d = [];
  for (let i = 0; i <= a.length + 1; i++) d.push(new Array(b.length + 2).fill(0));
  d[0][0] = maxDist;
  for (let i = 0; i <= a.length; i++) {
    d[i + 1][0] = maxDist;
    d[i + 1][1] = i;
  }
  for (let j = 0; j <= b.length; j++) {
    d[0][j + 1] = maxDist;
    d[1][j + 1] = j;
  }
  for (let i = 1; i <= a.length; i++) {
    let lastMatchCol = 0;
    for (let j = 1; j <= b.length; j++) {
      const i1 = lastRowOfChar[b[j - 1]] || 0;
      const j1 = lastMatchCol;
      let cost = 1;
      if (a[i - 1] === b[j - 1]) {
        cost = 0;
        lastMatchCol = j;
      }
      d[i + 1][j + 1] = Math.min(
        d[i][j] + cost, // change a letter (or keep it)
        d[i + 1][j] + 1, // add a letter
        d[i][j + 1] + 1, // remove a letter
        d[i1][j1] + (i - i1 - 1) + 1 + (j - j1 - 1) // swap two neighbours
      );
    }
    lastRowOfChar[a[i - 1]] = i;
  }
  return d[a.length + 1][b.length + 1];
}

// ---------------------------------------------------------------------------
// CHECK 1: FORMAT (no internet needed)
// ---------------------------------------------------------------------------

const LOCAL_CHARS = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const TLD_RE = /^([a-z]{2,}|xn--[a-z0-9-]{2,})$/;

function formatFail(detail) {
  return { ok: false, check: check("fail", "Invalid format: " + detail) };
}

function checkFormat(input) {
  const email = String(input).trim().toLowerCase();

  if (email.length === 0) return formatFail("the email is empty.");
  if (email.length > 254) return formatFail("longer than 254 characters.");
  if (/\s/.test(email)) return formatFail("it contains spaces.");

  const atCount = email.split("@").length - 1;
  if (atCount === 0) return formatFail("the @ symbol is missing.");
  if (atCount > 1) return formatFail("there is more than one @ symbol.");

  const at = email.indexOf("@");
  const local = email.slice(0, at);
  let domain = email.slice(at + 1);

  // Local part (before the @)
  if (local.length === 0) return formatFail("nothing before the @ symbol.");
  if (local.length > 64)
    return formatFail("the part before @ is longer than 64 characters.");
  if (/[^\x00-\x7f]/.test(local))
    return formatFail("special letters before the @ are not supported.");
  if (!LOCAL_CHARS.test(local))
    return formatFail("the part before @ has characters that are not allowed.");
  if (local.startsWith(".") || local.endsWith("."))
    return formatFail("the part before @ cannot start or end with a dot.");
  if (local.includes(".."))
    return formatFail("the part before @ has two dots in a row.");

  // Domain part (after the @). One trailing dot is allowed and removed.
  if (domain.endsWith(".")) domain = domain.slice(0, -1);
  if (domain.length === 0) return formatFail("nothing after the @ symbol.");
  if (!domain.includes("."))
    return formatFail("the domain needs a dot, like example.com.");
  if (domain.startsWith(".")) return formatFail("the domain starts with a dot.");
  if (domain.includes("..")) return formatFail("the domain has two dots in a row.");

  // International domains -> ASCII (punycode). Returns "" when not valid.
  const ascii = url.domainToASCII(domain);
  if (!ascii) return formatFail("the domain has characters that are not allowed.");
  if (ascii.length > 253) return formatFail("the domain is too long.");

  const labels = ascii.split(".");
  for (const label of labels) {
    if (label.length === 0 || label.length > 63)
      return formatFail("a part of the domain is empty or too long.");
    if (!LABEL_RE.test(label))
      return formatFail(
        "domain parts cannot start or end with a hyphen or use odd characters."
      );
  }
  if (labels.length < 2) return formatFail("the domain needs a dot, like example.com.");
  if (!TLD_RE.test(labels[labels.length - 1]))
    return formatFail("the ending (like .com) must be at least 2 letters.");

  return {
    ok: true,
    local,
    asciiDomain: ascii,
    normalized: local + "@" + domain,
    check: check("pass", "Format looks valid."),
  };
}

// ---------------------------------------------------------------------------
// DNS HELPERS
// ---------------------------------------------------------------------------

let resolver = null; // created on first use
function getResolver() {
  if (!resolver) {
    resolver = new dns.promises.Resolver({
      timeout: CONFIG.DNS_TIMEOUT_MS,
      tries: 1,
    });
  }
  return resolver;
}

// Stops waiting after "ms" even if the DNS server never answers.
function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error("DNS deadline reached");
      err.code = "ETIMEOUT";
      reject(err);
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Turn one Promise.allSettled result into a simple state:
//  ok       = records found
//  nodata   = the name exists but has no records of that type (ENODATA)
//  nxdomain = the name does not exist (ENOTFOUND)
//  error    = a TEMPORARY problem (timeout, SERVFAIL, refused...). Never "dead".
function interpret(settledResult) {
  if (settledResult.status === "fulfilled") {
    const data = settledResult.value;
    if (Array.isArray(data) && data.length > 0) return { state: "ok", data };
    return { state: "nodata", data: [] };
  }
  const code = (settledResult.reason && settledResult.reason.code) || "UNKNOWN";
  if (code === "ENOTFOUND") return { state: "nxdomain", code };
  if (code === "ENODATA") return { state: "nodata", code };
  return { state: "error", code };
}

// Join split TXT chunks: [["v=spf1 ", "include:x"]] -> ["v=spf1 include:x"]
function txtToStrings(r) {
  if (r.state !== "ok") return [];
  return r.data.map((chunks) => (Array.isArray(chunks) ? chunks.join("") : String(chunks)));
}

// ---------------------------------------------------------------------------
// CHECKS 2, 3, 4: DOMAIN, MX, SPF/DMARC (from DNS answers)
// ---------------------------------------------------------------------------

function buildDomainCheck(mx, a, aaaa) {
  const all = [mx, a, aaaa];
  if (all.some((r) => r.state === "ok"))
    return check("pass", "Domain exists and has DNS records.");
  if (all.some((r) => r.state === "nxdomain"))
    return check("fail", "Domain does not exist.");
  const err = all.find((r) => r.state === "error");
  if (err)
    return check(
      "unknown",
      "DNS lookup had a temporary problem (" + err.code + "). Try again later."
    );
  return check("warn", "Domain name exists but has no mail or website records.");
}

function buildMxCheck(mx, a, aaaa, facts) {
  if (mx.state === "ok") {
    const records = mx.data
      .map((r) => ({
        host: String(r.exchange || "").replace(/\.$/, "").toLowerCase(),
        priority: r.priority,
      }))
      .sort((x, y) => x.priority - y.priority);

    // Null MX (RFC 7505): one record whose host is "." (shown as empty).
    if (records.length === 1 && records[0].host === "") {
      facts.nullMx = true;
      return check("fail", "Domain says it does not accept email.");
    }
    const top = records.slice(0, 2).map((r) => r.host);
    return check("pass", "Mail servers found: " + top.join(", ") + ".");
  }

  if (mx.state === "error")
    return check(
      "unknown",
      "Could not read mail servers (" + mx.code + "). Try again later."
    );

  // No MX records (nodata or nxdomain). Look at the A / AAAA fallback.
  if (mx.state === "nxdomain")
    return check("fail", "No mail servers: the domain does not exist.");
  if (a.state === "ok" || aaaa.state === "ok")
    return check(
      "warn",
      "No MX record; mail may fall back to the main server, which is risky."
    );
  if (a.state === "error" || aaaa.state === "error")
    return check("unknown", "No MX record, and the fallback lookup was inconclusive.");
  return check("fail", "No mail servers found for this domain.");
}

function buildSpfDmarcCheck(domainCheck, txt, dmarc, facts) {
  if (domainCheck.status === "fail")
    return skipped("the domain does not exist");

  const spfFound = txtToStrings(txt).some((t) => /^v=spf1(\s|$)/i.test(t.trim()));
  const dmarcFound = txtToStrings(dmarc).some((t) =>
    /^v=dmarc1(\s|;|$)/i.test(t.trim())
  );
  facts.spf = spfFound;
  facts.dmarc = dmarcFound;

  if (spfFound && dmarcFound) return check("pass", "SPF and DMARC records found.");

  if (txt.state === "error" || dmarc.state === "error") {
    // A slow or failed TXT lookup means "unknown". It must never change the score,
    // so we never say "missing" here (null = we do not know).
    facts.spf = spfFound ? true : null;
    facts.dmarc = dmarcFound ? true : null;
    facts.spfLookupFailed = true;
    return check(
      "unknown",
      "Could not read SPF/DMARC records (temporary DNS problem)."
    );
  }

  const missing = [];
  if (!spfFound) missing.push("SPF");
  if (!dmarcFound) missing.push("DMARC");
  return check(
    "warn",
    "Missing " + missing.join(" and ") + ". Common on small domains, but it can hurt delivery."
  );
}

// ---------------------------------------------------------------------------
// DNS CACHE
// Remembers finished DNS answers per domain (10 minutes, max 500 domains).
// It lives in memory, so it only lasts while the function instance is warm.
// Netlify may start a fresh instance at any time, and then the cache is empty.
// ---------------------------------------------------------------------------

const dnsCache = new Map();

function cacheGet(domain) {
  const entry = dnsCache.get(domain);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    dnsCache.delete(domain);
    return null;
  }
  return entry.value;
}

function cacheSet(domain, value, ttlMs) {
  dnsCache.delete(domain); // so a refreshed domain moves to the back
  if (dnsCache.size >= CONFIG.CACHE_MAX_ENTRIES) {
    dnsCache.delete(dnsCache.keys().next().value); // drop the oldest one
  }
  dnsCache.set(domain, { value, expires: Date.now() + (ttlMs || CONFIG.CACHE_TTL_MS) });
}

// Runs all 5 DNS questions AT THE SAME TIME.
// MX, A and AAAA get DNS_DEADLINE_MS. The two TXT lookups (SPF and DMARC) get the
// shorter TXT_DEADLINE_MS, because big domains can have slow, huge TXT answers and
// SPF/DMARC never changes the score.
async function lookupDomain(domain) {
  const cached = cacheGet(domain);
  if (cached) return cached;

  const r = getResolver();
  const run = (fn, deadlineMs) =>
    withDeadline(Promise.resolve().then(fn), deadlineMs);

  const settled = await Promise.allSettled([
    run(() => r.resolveMx(domain), CONFIG.DNS_DEADLINE_MS),
    run(() => r.resolve4(domain), CONFIG.DNS_DEADLINE_MS),
    run(() => r.resolve6(domain), CONFIG.DNS_DEADLINE_MS),
    run(() => r.resolveTxt(domain), CONFIG.TXT_DEADLINE_MS),
    run(() => r.resolveTxt("_dmarc." + domain), CONFIG.TXT_DEADLINE_MS),
  ]);
  const [mx, a, aaaa, txt, dmarc] = settled.map(interpret);

  const facts = { nullMx: false, spf: null, dmarc: null, spfLookupFailed: false };
  const domainCheck = buildDomainCheck(mx, a, aaaa);
  const mxCheck = buildMxCheck(mx, a, aaaa, facts);
  const spfDmarcCheck = buildSpfDmarcCheck(domainCheck, txt, dmarc, facts);

  const errorCodes = [mx, a, aaaa, txt, dmarc]
    .filter((x) => x.state === "error")
    .map((x) => x.code);

  const result = { domainCheck, mxCheck, spfDmarcCheck, facts, errorCodes };

  // Caching rules:
  //  - Domain or MX inconclusive (temporary DNS problem): NEVER cached, so the next try can succeed.
  //  - ONLY SPF/DMARC inconclusive: cached for a short time (CACHE_TTL_SHORT_MS, 2 minutes),
  //    so a bulk list of one big domain is not slowed down again and again.
  //  - Everything else: cached for CACHE_TTL_MS (10 minutes).
  const coreInconclusive =
    domainCheck.status === "unknown" || mxCheck.status === "unknown";
  if (!coreInconclusive) {
    cacheSet(
      domain,
      result,
      facts.spfLookupFailed ? CONFIG.CACHE_TTL_SHORT_MS : CONFIG.CACHE_TTL_MS
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// CHECKS 5 to 8: LOCAL CHECKS (no internet needed)
// ---------------------------------------------------------------------------

// 5. Disposable: the domain AND every parent domain (x.mailinator.com -> mailinator.com).
function checkDisposable(asciiDomain) {
  if (!DISPOSABLE_SET)
    return check("unknown", "The disposable-domain list could not be loaded.");
  const labels = asciiDomain.split(".");
  for (let i = 0; i <= labels.length - 2; i++) {
    const candidate = labels.slice(i).join(".");
    if (DISPOSABLE_SET.has(candidate)) {
      return check("fail", "Disposable email domain (" + candidate + ").");
    }
  }
  return check("pass", "Not found in the disposable-domain list (the list is partial).");
}

// 6. Role: the local part without any +tag (info+news -> info).
function checkRole(local) {
  const base = local.split("+")[0];
  if (ROLE_SET.has(base))
    return check("warn", "Role address (" + base + "@): shared inbox, not one person.");
  return check("pass", "Does not look like a role address.");
}

// 7. Free provider or business domain.
function checkFreeBusiness(asciiDomain) {
  if (FREE_SET.has(asciiDomain))
    return check("warn", "Free email provider (" + asciiDomain + ").");
  return check("pass", "Looks like a business or custom domain.");
}

// 8. Typo hints (the typo engine).
// Order: known typos -> same name with a typo-looking ending -> fuzzy name match.
// Returns { suggestion, detail } or null.
function suggestTypo(domain) {
  // 1. The most common mistakes, straight from the list.
  const known = KNOWN_TYPOS.get(domain);
  if (known) return { suggestion: known, detail: "Common typo of " + known + "." };

  const { name, ending } = splitDomain(domain);
  if (name.length < MIN_NAME_LEN) return null; // short names are skipped (q.com, qq.com...)

  // 2. Same name as a popular domain, but the ending looks like a typo of .com:
  //    gmail.co -> gmail.com. Real endings (co.uk, com.ar, org...) are NOT in this list,
  //    so yahoo.co.nz, yahoo.com.ar, google.org and amazon.co.uk are never flagged.
  if (TYPO_ENDINGS.has(ending)) {
    const fixed = name + ".com";
    if (POPULAR_SET.has(fixed)) {
      return {
        suggestion: fixed,
        detail: "The ending ." + ending + " looks like a typo of .com.",
      };
    }
    return null;
  }

  // 3. Fuzzy match: the name must be close to a popular name AND the ending must be
  //    exactly the same. 1 edit is allowed, or 2 edits when the name has 8+ letters.
  //    A swap of two neighbouring letters counts as 1 edit.
  const maxDistance = name.length >= 8 ? 2 : 1;
  let best = null;
  for (const p of POPULAR_PARTS) {
    if (p.ending !== ending) continue;
    if (p.name.length < MIN_NAME_LEN) continue;
    if (Math.abs(p.name.length - name.length) > maxDistance) continue;
    // "olive" ends with "live": a different name, not a typo.
    if (name.endsWith(p.name) || p.name.endsWith(name)) continue;
    const distance = damerauLevenshtein(name, p.name);
    if (distance === 0 || distance > maxDistance) continue;
    const candidate = { domain: p.domain, distance, isCom: p.ending === "com" };
    // Best = fewest edits. If two tie, prefer the .com one. If still tied, the first in the list.
    if (
      !best ||
      candidate.distance < best.distance ||
      (candidate.distance === best.distance && candidate.isCom && !best.isCom)
    ) {
      best = candidate;
    }
  }
  if (best) {
    return { suggestion: best.domain, detail: "Looks similar to " + best.domain + "." };
  }
  return null;
}

function checkTypo(asciiDomain) {
  const none = (detail) => ({ status: "pass", detail, suggestion: null });

  // Already a known popular domain: never flag it.
  if (POPULAR_SET.has(asciiDomain)) return none("Matches a well-known email domain.");

  let found = suggestTypo(asciiDomain);

  // An ending that does not exist (.con, .cmo, .vom...) is a typo of .com for ANY domain.
  if (!found) {
    const parts = asciiDomain.split(".");
    const last = parts[parts.length - 1];
    if (FAKE_ENDINGS.has(last)) {
      const fixed = parts.slice(0, -1).concat("com").join(".");
      // The fixed domain can be a typo too: gmial.con -> gmial.com -> gmail.com
      const again = POPULAR_SET.has(fixed) ? null : suggestTypo(fixed);
      found = again || {
        suggestion: fixed,
        detail: "The ending ." + last + " looks like a typo of .com.",
      };
    }
  }

  if (found) {
    return { status: "warn", detail: found.detail, suggestion: found.suggestion };
  }
  return none("No typo found.");
}

// ---------------------------------------------------------------------------
// SCORING - one clear function
// ---------------------------------------------------------------------------
// RULES (checked in this order):
//  1. BAD     if format fails, OR domain fails, OR mx fails, OR disposable fails.
//  2. UNKNOWN otherwise, if domain or mx is "unknown" (DNS was inconclusive).
//  3. RISKY   otherwise, if ANY of: typo suggestion, MX is "warn" (no MX),
//             role address, or BOTH SPF and DMARC are missing.
//  4. GOOD    otherwise.
//  Free provider = "warn" on its own check but does NOT lower the score,
//  unless CONFIG.TREAT_FREE_AS_RISKY is switched to true.
//  "reason" is the single most important finding. If a typo suggestion
//  exists, the reason always mentions it.
function scoreEmail(checks, facts) {
  const status = (name) => checks[name].status;
  const suggestion = checks.typo.suggestion;
  const didYouMean = suggestion ? " Did you mean " + suggestion + "?" : "";

  // 1. BAD
  if (status("format") === "fail")
    return { score: "bad", reason: checks.format.detail };
  if (status("domain") === "fail")
    return { score: "bad", reason: "This domain does not exist." + didYouMean };
  if (status("mx") === "fail") {
    const why = facts.nullMx
      ? "This domain says it does not accept email."
      : "This domain has no mail servers.";
    return { score: "bad", reason: why + didYouMean };
  }
  if (status("disposable") === "fail")
    return {
      score: "bad",
      reason: "This is a disposable (temporary) email domain." + didYouMean,
    };

  // 2. UNKNOWN
  if (status("domain") === "unknown" || status("mx") === "unknown")
    return {
      score: "unknown",
      reason: "The DNS lookup was inconclusive, so we could not decide." + didYouMean,
    };

  // 3. RISKY
  if (suggestion)
    return {
      score: "risky",
      reason: "The domain may contain a typo. Did you mean " + suggestion + "?",
    };
  if (status("mx") === "warn")
    return {
      score: "risky",
      reason: "No mail server (MX) is listed, so delivery may fail.",
    };
  if (status("role") === "warn")
    return {
      score: "risky",
      reason: "This is a role address (like info@), a shared inbox.",
    };
  if (facts.spf === false && facts.dmarc === false)
    return {
      score: "risky",
      reason: "The domain has no SPF or DMARC records.",
    };
  if (CONFIG.TREAT_FREE_AS_RISKY && status("free_business") === "warn")
    return { score: "risky", reason: "This is a free email provider address." };

  // 4. GOOD
  const free = status("free_business") === "warn" ? " (free email provider)" : "";
  return {
    score: "good",
    reason: "Domain and mail setup look healthy" + free + ".",
  };
}

// ---------------------------------------------------------------------------
// PUT IT ALL TOGETHER FOR ONE EMAIL
// ---------------------------------------------------------------------------

async function checkEmail(rawEmail) {
  const fmt = checkFormat(rawEmail);

  // Format failed: every other check is skipped (no DNS work at all).
  if (!fmt.ok) {
    const why = "the format is invalid";
    const checks = {
      format: fmt.check,
      domain: skipped(why),
      mx: skipped(why),
      spf_dmarc: skipped(why),
      disposable: skipped(why),
      role: skipped(why),
      free_business: skipped(why),
      typo: Object.assign(skipped(why), { suggestion: null }),
    };
    const verdict = scoreEmail(checks, {});
    return buildResponse(String(rawEmail).trim().toLowerCase(), checks, verdict);
  }

  const dnsResult = await lookupDomain(fmt.asciiDomain);

  const checks = {
    format: fmt.check,
    domain: dnsResult.domainCheck,
    mx: dnsResult.mxCheck,
    spf_dmarc: dnsResult.spfDmarcCheck,
    disposable: checkDisposable(fmt.asciiDomain),
    role: checkRole(fmt.local),
    free_business: checkFreeBusiness(fmt.asciiDomain),
    typo: checkTypo(fmt.asciiDomain),
  };
  const verdict = scoreEmail(checks, dnsResult.facts);

  // Privacy: log ONLY the domain, the score and DNS error codes.
  console.log(
    JSON.stringify({
      domain: fmt.asciiDomain,
      score: verdict.score,
      dns_errors: dnsResult.errorCodes,
    })
  );

  return buildResponse(fmt.normalized, checks, verdict);
}

function buildResponse(email, checks, verdict) {
  return {
    email,
    score: verdict.score,
    reason: verdict.reason,
    checks,
    meta: {
      checked_at: new Date().toISOString(),
      mailbox_verified: false,
      note: NOTE_TEXT,
    },
  };
}

// ---------------------------------------------------------------------------
// NETLIFY HANDLER
// ---------------------------------------------------------------------------

// Read one header, whatever its capital letters ("origin", "Origin"...).
function getHeader(headers, name) {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return undefined;
}

function normalizeOrigin(value) {
  return String(value).trim().toLowerCase().replace(/\/+$/, "");
}

// Optional abuse guard (see CONFIG.ALLOWED_ORIGINS).
//  - Empty list: everyone is allowed.
//  - List with values and an Origin header that is not in it: blocked.
//  - List with values and NO Origin header: allowed (browsers send Origin on POST,
//    so this only lets through tools like curl, which can fake the header anyway).
function originAllowed(event) {
  const list = CONFIG.ALLOWED_ORIGINS;
  if (!Array.isArray(list) || list.length === 0) return true;
  const origin = getHeader(event.headers, "origin");
  if (!origin) return true;
  return list.map(normalizeOrigin).includes(normalizeOrigin(origin));
}

exports.handler = async (event) => {
  try {
    if (!event || event.httpMethod !== "POST") {
      return respond(405, { error: "Method not allowed. Use POST." }, { Allow: "POST" });
    }

    if (!originAllowed(event)) {
      // An origin is a website address, not a person's data, so it is fine to log.
      console.log(
        "check-email: blocked origin " + String(getHeader(event.headers, "origin")).slice(0, 100)
      );
      return respond(403, { error: "Not allowed." });
    }

    // Read the body (Netlify may send it base64 encoded).
    let raw = event.body || "";
    if (event.isBase64Encoded) raw = Buffer.from(raw, "base64").toString("utf8");

    if (Buffer.byteLength(raw, "utf8") > CONFIG.MAX_BODY_BYTES) {
      return respond(400, { error: "Request body is too large (2 KB maximum)." });
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      return respond(400, { error: "Invalid JSON." });
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return respond(400, { error: "Invalid JSON body." });
    }
    if (typeof payload.email !== "string") {
      return respond(400, { error: 'Missing "email" (it must be a text value).' });
    }

    const result = await checkEmail(payload.email);
    return respond(200, result);
  } catch (err) {
    // Never show stack traces or email addresses. Log only the error name/code.
    console.error(
      "check-email unexpected error:",
      (err && (err.code || err.name)) || "UNKNOWN"
    );
    return respond(500, { error: "Something went wrong. Please try again." });
  }
};

// Used only by test/run-tests.js (lets the tests use a fake DNS and change settings).
// Netlify ignores this export.
exports._internals = {
  CONFIG,
  setResolver(r) {
    resolver = r; // pass null to go back to the real DNS resolver
  },
  clearCache() {
    dnsCache.clear();
  },
  cacheSize() {
    return dnsCache.size;
  },
  damerauLevenshtein,
  suggestTypo,
  disposableCount() {
    return DISPOSABLE_SET ? DISPOSABLE_SET.size : 0;
  },
};
