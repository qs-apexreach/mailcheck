"use strict";

/*
 * Optional helper: refresh data/disposable-domains.json from the free
 * open-source list "disposable-email-domains" on GitHub.
 *
 * Usage:
 *   1. Download the file  disposable_email_blocklist.conf  from
 *      https://github.com/disposable-email-domains/disposable-email-domains
 *   2. Put it in this project folder.
 *   3. Run:  node scripts/update-disposable.js disposable_email_blocklist.conf
 *
 * It keeps the domains already in your file (your own additions are not lost),
 * adds the new ones, removes duplicates, and rewrites the JSON in the right shape.
 */

const fs = require("fs");
const path = require("path");

const inputFile = process.argv[2];
if (!inputFile) {
  console.log("Usage: node scripts/update-disposable.js <downloaded-file.conf>");
  process.exit(1);
}

const target = path.join(__dirname, "..", "data", "disposable-domains.json");
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

const downloaded = fs
  .readFileSync(inputFile, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim().toLowerCase())
  .filter((line) => line && !line.startsWith("#") && DOMAIN_RE.test(line));

let existing = [];
try {
  existing = JSON.parse(fs.readFileSync(target, "utf8")).domains || [];
} catch (e) {
  /* no old file: that is fine */
}

const domains = Array.from(new Set(existing.concat(downloaded))).sort();

const output = {
  version: 1,
  updated: new Date().toISOString().slice(0, 10),
  source:
    "Hand-collected list plus the open-source 'disposable-email-domains' list on GitHub. Still not complete: new disposable domains appear every day.",
  domains,
};

fs.writeFileSync(target, JSON.stringify(output, null, 1) + "\n");
console.log(
  "Done. " + downloaded.length + " domains read, " + domains.length + " in the file now."
);
