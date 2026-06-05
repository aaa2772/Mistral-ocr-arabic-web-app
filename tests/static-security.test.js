"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

test("frontend no longer stores browser API keys or uses unsafe markdown injection", function () {
  const app = read("app.js");
  const html = read("index.html");
  const combined = app + "\n" + html;

  assert.equal(combined.includes("mistral_api_key"), false);
  assert.equal(combined.includes("marked.parse"), false);
  assert.equal(app.includes("innerHTML"), false);
});

test("page uses local assets instead of third-party runtime CDNs", function () {
  const html = read("index.html");

  assert.equal(html.includes("fonts.googleapis.com"), false);
  assert.equal(html.includes("font-awesome"), false);
  assert.equal(html.includes("cdnjs.cloudflare.com"), false);
  assert.equal(html.includes("cdn.jsdelivr.net"), false);
  assert.equal(html.includes("vendor/pdf.min.js"), true);
});
