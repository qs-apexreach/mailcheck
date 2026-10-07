"use strict";

/*
 * MailCheck v1.1 tests - no dependencies.
 * Run:  node test/run-tests.js            (offline tests + online tests)
 *       node test/run-tests.js --offline  (offline tests only)
 *
 * OFFLINE tests use a FAKE DNS, so they work without internet and are fast.
 * ONLINE tests use the real DNS and need internet.
 */

const fn = require("../netlify/functions/check-email.js");
const T = fn._internals;

let passed = 0;
let failed = 0;
let skippedCount = 0;

function report(name, ok, extra) {
  if (ok) {
    passed++;
    console.log("PASS  " + name);
  } else {
    failed++;
    console.log("FAIL  " + name + (extra ? "   -> " + extra : ""));
  }
}
function skip(name, why) {
  skippedCount++;
  console.log("SKIP  " + name + "   (" + why + ")");
}

// ---------- helpers ----------

function makeEvent(method, body, extra) {
  return Object.assign(
    { httpMethod: method, headers: {}, body: body === undefined ? null : body },
    extra || {}
  );
}
async function post(emailValue) {
  const res = await fn.handler(makeEvent("POST", JSON.stringify({ email: emailValue })));
  return { res, data: JSON.parse(res.body) };
}

// A fake DNS. "table" maps "type:name" to an array (records) or {err: "CODE"}.
// Anything not in the table answers ENODATA (name exists, no records).
function fakeDns(table) {
  const calls = { count: 0 };
  function answer(type, name) {
    calls.count++;
    const hit = table[type + ":" + name];
    if (hit === undefined) {
      const e = new Error("no data");
      e.code = "ENODATA";
      return Promise.reject(e);
    }
    if (hit && hit.err) {
      const e = new Error(hit.err);
      e.code = hit.err;
      return Promise.reject(e);
    }
    return Promise.resolve(hit);
  }
  return {
    calls,
    resolveMx: (n) => answer("mx", n),
    resolve4: (n) => answer("a", n),
    resolve6: (n) => answer("aaaa", n),
    resolveTxt: (n) => answer("txt", n),
  };
}

// Records for a healthy domain.
function healthy(domain) {
  const t = {};
  t["mx:" + domain] = [{ exchange: "mx1." + domain, priority: 10 }, { exchange: "mx2." + domain, priority: 20 }];
  t["a:" + domain] = ["192.0.2.1"];
  t["txt:" + domain] = [["v=spf1 include:_spf.example.net ~all"]];
  t["txt:_dmarc." + domain] = [["v=DMARC1; p=none"]];
  return t;
}
function useDns(table) {
  const d = fakeDns(table);
  T.setResolver(d);
  T.clearCache();
  return d;
}

const CHECK_NAMES = ["format", "domain", "mx", "spf_dmarc", "disposable", "role", "free_business", "typo"];
const STATUSES = ["pass", "warn", "fail", "unknown"];

function contractOk(data) {
  if (typeof data.email !== "string") return "email missing";
  if (!["good", "risky", "bad", "unknown"].includes(data.score)) return "bad score value";
  if (typeof data.reason !== "string" || !data.reason) return "reason missing";
  for (const n of CHECK_NAMES) {
    const c = data.checks && data.checks[n];
    if (!c) return "check missing: " + n;
    if (!STATUSES.includes(c.status)) return "bad status in " + n;
    if (typeof c.detail !== "string") return "detail missing in " + n;
  }
  if (!("suggestion" in data.checks.typo)) return "typo.suggestion missing";
  if (!data.meta || data.meta.mailbox_verified !== false) return "meta.mailbox_verified must be false";
  if (isNaN(Date.parse(data.meta.checked_at))) return "meta.checked_at is not a date";
  if (typeof data.meta.note !== "string") return "meta.note missing";
  return null;
}

// ---------- OFFLINE TESTS ----------

async function offlineTests() {
  console.log("\n=== OFFLINE TESTS (fake DNS, no internet needed) ===");

  // Safety: from here on, the real DNS is never used in offline tests.
  useDns(healthy("b.com"));

  // --- HTTP handling ---
  let r = await fn.handler(makeEvent("GET"));
  report("GET returns 405", r.statusCode === 405);
  r = await fn.handler(makeEvent("PUT", "{}"));
  report("PUT returns 405", r.statusCode === 405);

  r = await fn.handler(makeEvent("POST", "{not json"));
  report("Bad JSON returns 400", r.statusCode === 400);
  r = await fn.handler(makeEvent("POST", ""));
  report("Empty body returns 400", r.statusCode === 400);
  r = await fn.handler(makeEvent("POST", "{}"));
  report("Missing email returns 400", r.statusCode === 400);
  r = await fn.handler(makeEvent("POST", JSON.stringify({ email: 123 })));
  report("Email that is not text returns 400", r.statusCode === 400);
  r = await fn.handler(makeEvent("POST", JSON.stringify({ email: "a".repeat(3000) + "@x.com" })));
  report("Body over 2 KB returns 400", r.statusCode === 400);

  r = await fn.handler(makeEvent("POST", JSON.stringify({ email: "a@b.com" })));
  report(
    "Headers: JSON + no-store",
    r.headers["Content-Type"] === "application/json" && r.headers["Cache-Control"] === "no-store"
  );

  // --- Invalid formats: 200 + bad + NO DNS calls ---
  const dnsForFormat = useDns({});
  const badFormats = [
    ["empty string", ""],
    ["only spaces", "     "],
    ["no @", "plainaddress"],
    ["a@b (no dot)", "a@b"],
    ["double @", "a@@b.com"],
    ["two dots in domain", "a@b..com"],
    ["two dots in local part", "a..b@c.com"],
    ["leading dot in local part", ".a@b.com"],
    ["space inside", "john smith@b.com"],
    ["hyphen at start of label", "john@-bad.com"],
    ["hyphen at end of label", "john@bad-.com"],
    ["1-letter ending", "john@example.c"],
    ["numeric ending", "john@1.2.3.4"],
    ["very long input", "a".repeat(300) + "@example.com"],
    ["local part over 64", "a".repeat(65) + "@example.com"],
    ["nothing before @", "@example.com"],
    ["nothing after @", "john@"],
    ["unicode in local part", "jöhn@example.com"],
    ["bad characters in domain", "john@exa_mple.com"],
  ];
  for (const [name, input] of badFormats) {
    const { res, data } = await post(input);
    const problem = contractOk(data);
    report(
      "Invalid format -> 200 + bad: " + name,
      res.statusCode === 200 && data.score === "bad" && data.checks.format.status === "fail" && !problem,
      problem || "score=" + data.score
    );
  }
  report("Invalid formats make zero DNS calls", dnsForFormat.calls.count === 0, "calls=" + dnsForFormat.calls.count);

  // --- Valid formats get cleaned up ---
  useDns(healthy("gmail.com"));
  let o = await post("  JOHN@Gmail.COM  ");
  report("Trim + lowercase works", o.data.email === "john@gmail.com" && o.data.checks.format.status === "pass", o.data.email);
  o = await post("john@gmail.com.");
  report("Trailing dot in domain is accepted", o.data.checks.format.status === "pass" && o.data.email === "john@gmail.com");

  useDns(healthy("xn--mnchen-3ya.de"));
  o = await post("user@münchen.de");
  report("Unicode domain is converted to punycode and checked", o.data.checks.format.status === "pass" && o.data.score === "good", o.data.score + " / " + o.data.reason);

  // --- Disposable ---
  useDns(healthy("mailinator.com"));
  o = await post("test@mailinator.com");
  report("Disposable (mailinator.com) -> bad", o.data.score === "bad" && o.data.checks.disposable.status === "fail");
  useDns(healthy("x.mailinator.com"));
  o = await post("test@x.mailinator.com");
  report("Disposable parent domain (x.mailinator.com) -> bad", o.data.checks.disposable.status === "fail");
  useDns(healthy("notmailinator-example.org"));
  o = await post("test@notmailinator-example.org");
  report("Similar but different domain is NOT disposable", o.data.checks.disposable.status === "pass");
  report("Disposable list loaded (300+ domains)", T.disposableCount() >= 300, "count=" + T.disposableCount());

  // --- Role ---
  useDns(healthy("example.org"));
  o = await post("info@example.org");
  report("Role (info@example.org) -> role warn + risky", o.data.checks.role.status === "warn" && o.data.score === "risky", o.data.score);
  o = await post("Support+news@example.org");
  report("Role with +tag and capitals is still caught", o.data.checks.role.status === "warn");
  o = await post("jane.doe@example.org");
  report("Normal name is not a role + score good", o.data.checks.role.status === "pass" && o.data.score === "good", o.data.score + " / " + o.data.reason);

  // --- Free vs business ---
  useDns(healthy("gmail.com"));
  o = await post("someone@gmail.com");
  report("Free (gmail.com) -> free warn but score stays good", o.data.checks.free_business.status === "warn" && o.data.score === "good", o.data.score);
  T.CONFIG.TREAT_FREE_AS_RISKY = true;
  o = await post("someone@gmail.com");
  report("TREAT_FREE_AS_RISKY = true -> risky", o.data.score === "risky", o.data.score);
  T.CONFIG.TREAT_FREE_AS_RISKY = false;
  useDns(healthy("acme-widgets.com"));
  o = await post("jane@acme-widgets.com");
  report("Business domain -> free_business pass", o.data.checks.free_business.status === "pass");

  // --- Typo ---
  useDns(healthy("gmial.com"));
  o = await post("john@gmial.com");
  report("Typo (gmial.com) suggests gmail.com", o.data.checks.typo.suggestion === "gmail.com" && o.data.checks.typo.status === "warn");
  // Risky with the small built-in list. If you refresh the list from GitHub, gmial.com is
  // listed there as a disposable look-alike, so "bad" is also correct. Either way the
  // reason must tell the person: Did you mean gmail.com?
  report("Typo -> risky (or bad) and the reason mentions gmail.com", (o.data.score === "risky" || o.data.score === "bad") && o.data.reason.includes("gmail.com"), o.data.reason);
  useDns(healthy("gmail.con"));
  o = await post("john@gmail.con");
  report("TLD typo (gmail.con) suggests gmail.com", o.data.checks.typo.suggestion === "gmail.com");
  useDns(healthy("gmail.com"));
  o = await post("john@gmail.com");
  report("Real gmail.com has no typo suggestion", o.data.checks.typo.suggestion === null);
  useDns(healthy("olive.com"));
  o = await post("jane@olive.com");
  report("olive.com is NOT flagged as a typo of live.com", o.data.checks.typo.suggestion === null, String(o.data.checks.typo.suggestion));
  useDns(healthy("q.com"));
  o = await post("jane@q.com");
  report("Very short domain q.com is not flagged", o.data.checks.typo.suggestion === null);
  const dl = T.damerauLevenshtein;
  report("Distance: a swap of two letters is 1 edit (gmial -> gmail)", dl("gmial", "gmail") === 1);
  report("Distance: classic cases (kitten/sitting = 3, same = 0, empty = length)", dl("kitten", "sitting") === 3 && dl("abc", "abc") === 0 && dl("", "abc") === 3 && dl("abc", "") === 3);
  report("Distance: true Damerau-Levenshtein (ca -> abc = 2)", dl("ca", "abc") === 2);

  // --- TYPO ENGINE v1.1 ---
  async function typoOf(domain) {
    useDns(healthy(domain));
    const r = await post("john@" + domain);
    return r.data;
  }
  const mustSuggest = [
    // the KNOWN_TYPOS list
    ["gmial.com", "gmail.com"], ["gmai.com", "gmail.com"], ["gmal.com", "gmail.com"],
    ["gamil.com", "gmail.com"], ["gmil.com", "gmail.com"], ["gmaill.com", "gmail.com"],
    ["gnail.com", "gmail.com"], ["hotmial.com", "hotmail.com"], ["hotmal.com", "hotmail.com"],
    ["yaho.com", "yahoo.com"], ["yahooo.com", "yahoo.com"], ["outlok.com", "outlook.com"],
    ["outlook.co", "outlook.com"], ["iclod.com", "icloud.com"],
    // same name, typo-looking ending
    ["gmail.co", "gmail.com"], ["hotmail.co", "hotmail.com"], ["protonmail.co", "protonmail.com"],
    ["yahoo.co", "yahoo.com"], ["gmail.cm", "gmail.com"], ["gmail.con", "gmail.com"],
    // fuzzy matching (not in the known list)
    ["protonmial.com", "protonmail.com"], // swap
    ["yahho.com", "yahoo.com"], // 1 letter changed
    ["outlookk.com", "outlook.com"], // 1 letter added
    ["protnmial.com", "protonmail.com"], // 2 edits, name has 9 letters
    ["hotmial.co.uk", "hotmail.co.uk"], // same ending (co.uk) is required and is kept
    // typo in the name AND a fake ending
    ["gmial.con", "gmail.com"],
    // ending that does not exist, on any domain
    ["acme-widgets.con", "acme-widgets.com"],
  ];
  for (const [typed, wanted] of mustSuggest) {
    const data = await typoOf(typed);
    report(
      "Typo: " + typed + " -> suggests " + wanted,
      data.checks.typo.suggestion === wanted && data.checks.typo.status === "warn" && data.reason.includes(wanted) && !contractOk(data),
      "suggestion=" + data.checks.typo.suggestion
    );
  }

  const mustNotFlag = [
    "yahoo.co.nz", "yahoo.com.ar", "google.org", "amazon.co.uk", // real regional / other endings
    "olive.com", "q.com", "acme-corp.com", // protections and normal business names
    "gmail.com", "yahoo.co.uk", "hotmail.co.uk", "outlook.com", // already popular
    "gmaxxl.com", // 2 edits but the name has fewer than 8 letters
    "startup.co", "acme.co", // real .co domains with unknown names
    "bigcompany.com", "mailbox-pros.com",
  ];
  for (const domain of mustNotFlag) {
    const data = await typoOf(domain);
    report(
      "No typo flag: " + domain,
      data.checks.typo.suggestion === null && data.checks.typo.status === "pass",
      "suggestion=" + data.checks.typo.suggestion
    );
  }


  // --- DNS outcomes and scoring ---
  useDns(healthy("goodcompany.com"));
  o = await post("jane@goodcompany.com");
  report("Healthy domain -> good + valid JSON contract", o.data.score === "good" && !contractOk(o.data), contractOk(o.data) || o.data.score);
  report("meta.mailbox_verified is false", o.data.meta.mailbox_verified === false);
  report("Top 2 MX hosts shown", o.data.checks.mx.detail.includes("mx1.goodcompany.com") && o.data.checks.mx.detail.includes("mx2.goodcompany.com"));

  useDns({
    "mx:ghost-domain.com": { err: "ENOTFOUND" },
    "a:ghost-domain.com": { err: "ENOTFOUND" },
    "aaaa:ghost-domain.com": { err: "ENOTFOUND" },
    "txt:ghost-domain.com": { err: "ENOTFOUND" },
    "txt:_dmarc.ghost-domain.com": { err: "ENOTFOUND" },
  });
  o = await post("jane@ghost-domain.com");
  report("Dead domain (ENOTFOUND) -> 200 + bad", o.res.statusCode === 200 && o.data.score === "bad" && o.data.checks.domain.status === "fail" && o.data.checks.mx.status === "fail");
  report("Dead domain: SPF/DMARC check is skipped but present", o.data.checks.spf_dmarc.status === "unknown");

  useDns({
    "mx:slow-dns.com": { err: "ETIMEOUT" },
    "a:slow-dns.com": { err: "ETIMEOUT" },
    "aaaa:slow-dns.com": { err: "ESERVFAIL" },
    "txt:slow-dns.com": { err: "ECONNREFUSED" },
    "txt:_dmarc.slow-dns.com": { err: "ETIMEOUT" },
  });
  o = await post("jane@slow-dns.com");
  report("Temporary DNS errors -> unknown (never bad)", o.res.statusCode === 200 && o.data.score === "unknown" && o.data.checks.domain.status === "unknown" && o.data.checks.mx.status === "unknown", o.data.score);
  report("Unknown results are NOT cached", T.cacheSize() === 0);

  useDns({ "mx:nullmx.com": [{ exchange: "", priority: 0 }], "a:nullmx.com": ["192.0.2.1"] });
  o = await post("jane@nullmx.com");
  report("Null MX -> bad", o.data.score === "bad" && o.data.checks.mx.status === "fail" && o.data.reason.includes("does not accept email"), o.data.reason);

  useDns({ "a:nomx.com": ["192.0.2.5"], "txt:nomx.com": [["v=spf1 -all"]], "txt:_dmarc.nomx.com": [["v=DMARC1; p=reject"]] });
  o = await post("jane@nomx.com");
  report("No MX but A record -> mx warn + risky", o.data.checks.mx.status === "warn" && o.data.score === "risky", o.data.score);

  useDns({ "a:nothing.com": { err: "ENODATA" } });
  o = await post("jane@nothing.com");
  report("Domain with no MX and no A -> bad", o.data.score === "bad" && o.data.checks.mx.status === "fail", o.data.score);

  const noAuth = healthy("noauth.com");
  delete noAuth["txt:noauth.com"];
  delete noAuth["txt:_dmarc.noauth.com"];
  useDns(noAuth);
  o = await post("jane@noauth.com");
  report("Both SPF and DMARC missing -> spf_dmarc warn + risky", o.data.checks.spf_dmarc.status === "warn" && o.data.score === "risky", o.data.score);

  const spfOnly = healthy("spfonly.com");
  delete spfOnly["txt:_dmarc.spfonly.com"];
  useDns(spfOnly);
  o = await post("jane@spfonly.com");
  report("Only DMARC missing -> warn but score stays good", o.data.checks.spf_dmarc.status === "warn" && o.data.score === "good", o.data.score);

  const chunked = healthy("chunked.com");
  chunked["txt:chunked.com"] = [["v=spf1 include:a.example.net ", "include:b.example.net ~all"]];
  useDns(chunked);
  o = await post("jane@chunked.com");
  report("Split TXT chunks are joined", o.data.checks.spf_dmarc.status === "pass");

  // --- Cache ---
  const cacheDns = useDns(healthy("cache-me.com"));
  await post("a@cache-me.com");
  const afterFirst = cacheDns.calls.count;
  await post("b@cache-me.com");
  report("Second email on the same domain uses the cache (no new DNS calls)", cacheDns.calls.count === afterFirst && afterFirst === 5, "calls=" + cacheDns.calls.count);

  // --- SPEED OF BIG DOMAINS (v1.1) ---
  // A TXT lookup that never answers. MX/A/AAAA answer normally.
  function hangingTxtDns(domain) {
    const d = fakeDns(healthy(domain));
    d.resolveTxt = () => {
      d.calls.count++;
      return new Promise(() => {}); // never answers
    };
    T.setResolver(d);
    T.clearCache();
    return d;
  }

  const hang = hangingTxtDns("slow-txt-corp.com");
  let started = Date.now();
  o = await post("jane@slow-txt-corp.com");
  let elapsed = Date.now() - started;
  report("Hanging TXT: the answer arrives in under 2.5 seconds", elapsed < 2500, elapsed + " ms");
  report("Hanging TXT: spf_dmarc is unknown", o.res.statusCode === 200 && o.data.checks.spf_dmarc.status === "unknown", o.data.checks.spf_dmarc.status);
  report("Hanging TXT: score is still correct (good)", o.data.score === "good" && o.data.checks.domain.status === "pass" && o.data.checks.mx.status === "pass", o.data.score);
  report("Hanging TXT: the contract is still complete", !contractOk(o.data), contractOk(o.data));

  const callsAfterFirst = hang.calls.count;
  started = Date.now();
  o = await post("info@slow-txt-corp.com");
  elapsed = Date.now() - started;
  report("Hanging TXT: only-SPF/DMARC-inconclusive result IS cached (second email is instant)", hang.calls.count === callsAfterFirst && elapsed < 200 && T.cacheSize() === 1, "calls=" + hang.calls.count + " ms=" + elapsed + " cache=" + T.cacheSize());
  report("Hanging TXT: the score still follows the rules (role -> risky)", o.data.score === "risky" && o.data.checks.spf_dmarc.status === "unknown", o.data.score);

  // Short cache time (2 minutes by default) for SPF/DMARC-only problems. Shrunk here so the test is fast.
  const oldShort = T.CONFIG.CACHE_TTL_SHORT_MS;
  T.CONFIG.CACHE_TTL_SHORT_MS = 50;
  const txtFails = healthy("txt-fails.com");
  txtFails["txt:txt-fails.com"] = { err: "ETIMEOUT" };
  txtFails["txt:_dmarc.txt-fails.com"] = { err: "ESERVFAIL" };
  let dnsShort = useDns(txtFails);
  await post("a@txt-fails.com");
  const callsA = dnsShort.calls.count;
  await post("b@txt-fails.com");
  report("Short cache: SPF/DMARC-only problem is cached right away", dnsShort.calls.count === callsA && T.cacheSize() === 1);
  await new Promise((r) => setTimeout(r, 90));
  await post("c@txt-fails.com");
  report("Short cache: it expires quickly, then the domain is looked up again", dnsShort.calls.count > callsA, "calls=" + dnsShort.calls.count);

  dnsShort = useDns(healthy("fully-fine.com"));
  await post("a@fully-fine.com");
  const callsB = dnsShort.calls.count;
  await new Promise((r) => setTimeout(r, 90));
  await post("b@fully-fine.com");
  report("Normal cache: a fully finished result does NOT use the short time", dnsShort.calls.count === callsB, "calls=" + dnsShort.calls.count);
  T.CONFIG.CACHE_TTL_SHORT_MS = oldShort;

  const mxFails = healthy("mx-fails.com");
  mxFails["mx:mx-fails.com"] = { err: "ETIMEOUT" };
  useDns(mxFails);
  o = await post("jane@mx-fails.com");
  report("MX problem: score unknown and NOT cached", o.data.score === "unknown" && o.data.checks.mx.status === "unknown" && T.cacheSize() === 0, o.data.score + " cache=" + T.cacheSize());

  // --- OPTIONAL ABUSE GUARD (v1.1) ---
  async function postFrom(headers, email) {
    const res = await fn.handler(makeEvent("POST", JSON.stringify({ email }), { headers }));
    return { res, data: JSON.parse(res.body) };
  }
  const guardDns = useDns(healthy("gmail.com"));
  const oldOrigins = T.CONFIG.ALLOWED_ORIGINS;
  const SITE = "https://mailcheck.netlify.app";

  T.CONFIG.ALLOWED_ORIGINS = [];
  o = await postFrom({ origin: "https://anything.example" }, "a@gmail.com");
  report("Origin guard: empty list allows every origin", o.res.statusCode === 200);

  T.CONFIG.ALLOWED_ORIGINS = [SITE];
  guardDns.calls.count = 0;
  o = await postFrom({ origin: "https://evil.example" }, "a@gmail.com");
  report("Origin guard: other origin is blocked with 403", o.res.statusCode === 403, String(o.res.statusCode));
  report('Origin guard: body is exactly {"error":"Not allowed."}', o.res.body === JSON.stringify({ error: "Not allowed." }), o.res.body);
  report("Origin guard: blocked answer has JSON + no-store headers", o.res.headers["Content-Type"] === "application/json" && o.res.headers["Cache-Control"] === "no-store");
  report("Origin guard: blocked request does no DNS work", guardDns.calls.count === 0, "calls=" + guardDns.calls.count);
  o = await postFrom({ origin: SITE }, "a@gmail.com");
  report("Origin guard: listed origin is allowed", o.res.statusCode === 200 && !contractOk(o.data));
  o = await postFrom({ Origin: "HTTPS://MailCheck.Netlify.app/" }, "a@gmail.com");
  report("Origin guard: capital letters in the header name, address case and a final slash are tolerated", o.res.statusCode === 200);
  o = await postFrom({ Origin: "https://evil.example" }, "a@gmail.com");
  report("Origin guard: header name 'Origin' with a capital O is also checked", o.res.statusCode === 403);
  o = await postFrom({}, "a@gmail.com");
  report("Origin guard: no Origin header at all is allowed", o.res.statusCode === 200);
  o = await postFrom({ origin: "null" }, "a@gmail.com");
  report("Origin guard: origin \"null\" is blocked when a list is set", o.res.statusCode === 403);
  T.CONFIG.ALLOWED_ORIGINS = oldOrigins;

  // --- EXACT RESPONSE CONTRACT (unchanged since v1.0) ---
  function keysAre(obj, expected) {
    return JSON.stringify(Object.keys(obj).sort()) === JSON.stringify(expected.slice().sort());
  }
  function strictContract(data) {
    if (!keysAre(data, ["email", "score", "reason", "checks", "meta"])) return "top-level keys";
    if (!["good", "risky", "bad", "unknown"].includes(data.score)) return "score value";
    if (!keysAre(data.checks, CHECK_NAMES)) return "check names";
    for (const n of CHECK_NAMES) {
      const expected = n === "typo" ? ["status", "detail", "suggestion"] : ["status", "detail"];
      if (!keysAre(data.checks[n], expected)) return "keys of " + n;
      if (!STATUSES.includes(data.checks[n].status)) return "status of " + n;
    }
    if (!keysAre(data.meta, ["checked_at", "mailbox_verified", "note"])) return "meta keys";
    if (data.meta.note !== "Domain and email setup checked. Mailbox existence is not confirmed.") return "meta.note text";
    return null;
  }
  const contractCases = [
    ["good result", healthy("exact-contract.com"), "jane@exact-contract.com"],
    ["risky result (typo)", healthy("gmial.com"), "jane@gmial.com"],
    ["bad result (disposable)", healthy("mailinator.com"), "jane@mailinator.com"],
    ["bad result (invalid format)", {}, "no-at-sign"],
    ["unknown result", { "mx:flaky.com": { err: "ETIMEOUT" }, "a:flaky.com": { err: "ETIMEOUT" }, "aaaa:flaky.com": { err: "ETIMEOUT" } }, "jane@flaky.com"],
  ];
  for (const [label, table, email] of contractCases) {
    useDns(table);
    const r = await post(email);
    const problem = strictContract(r.data);
    report("Exact contract (no extra or missing keys): " + label, r.res.statusCode === 200 && !problem, problem || "");
  }

  T.setResolver(null); // back to real DNS
  T.clearCache();
}

// ---------- ONLINE TESTS ----------

async function onlineTests() {
  console.log("\n=== ONLINE TESTS (real DNS - these need internet) ===");
  T.setResolver(null);
  T.clearCache();

  let o = await post("someone@gmail.com");
  if (o.data.score === "unknown") {
    skip("gmail.com is not bad", "DNS gave no answer - are you offline?");
  } else {
    report("ONLINE: gmail.com is not bad", o.data.score !== "bad", o.data.score + " / " + o.data.reason);
  }

  o = await post("someone@nope-this-domain-should-not-exist-84721.com");
  if (o.data.score === "unknown") {
    skip("Made-up domain is bad", "DNS gave no answer - are you offline?");
  } else {
    report("ONLINE: made-up domain is bad", o.res.statusCode === 200 && o.data.score === "bad", o.data.score + " / " + o.data.reason);
  }
}

// ---------- RUN ----------

(async () => {
  try {
    await offlineTests();
    if (process.argv.includes("--offline")) {
      console.log("\n(Online tests skipped because of --offline)");
    } else {
      await onlineTests();
    }
  } catch (err) {
    failed++;
    console.log("FAIL  The test runner crashed: " + (err && err.stack ? err.stack : err));
  }
  console.log("\n" + passed + " passed, " + failed + " failed" + (skippedCount ? " (" + skippedCount + " skipped)" : ""));
  process.exit(failed > 0 ? 1 : 0);
})();
