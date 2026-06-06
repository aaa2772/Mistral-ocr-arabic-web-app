"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildMistralRequest,
  normalizeMistralError,
  parseMultipartFormData,
  parsePageSelection,
  validateUpload
} = require("../server");

test("parsePageSelection converts 1-based input to 0-based unique pages", function () {
  assert.deepEqual(parsePageSelection("1,3-5,3"), [0, 2, 3, 4]);
  assert.equal(parsePageSelection(""), undefined);
});

test("parsePageSelection rejects invalid page input", function () {
  assert.throws(function () {
    parsePageSelection("0");
  }, /start at 1/);

  assert.throws(function () {
    parsePageSelection("4-2");
  }, /positive numbers/);
});

test("validateUpload accepts supported file and rejects unsafe input", function () {
  assert.doesNotThrow(function () {
    validateUpload({
      type: "application/pdf",
      data: Buffer.from("%PDF-1.7")
    });
  });

  assert.throws(function () {
    validateUpload({
      type: "text/html",
      data: Buffer.from("<script>alert(1)</script>")
    });
  }, /Unsupported file type/);
});

test("validateUpload rejects files whose bytes do not match the declared type", function () {
  assert.throws(function () {
    validateUpload({
      type: "application/pdf",
      data: Buffer.from("<html>not a pdf</html>")
    });
  }, /content does not match/);

  assert.throws(function () {
    validateUpload({
      type: "image/png",
      data: Buffer.from("plain text")
    });
  }, /content does not match/);
});

test("parseMultipartFormData extracts fields and file safely", function () {
  const boundary = "----ocr-boundary";
  const body = Buffer.from([
    "--" + boundary,
    "Content-Disposition: form-data; name=\"pages\"",
    "",
    "1,2",
    "--" + boundary,
    "Content-Disposition: form-data; name=\"file\"; filename=\"receipt.png\"",
    "Content-Type: image/png",
    "",
    "PNGDATA",
    "--" + boundary + "--",
    ""
  ].join("\r\n"));

  const parsed = parseMultipartFormData(body, "multipart/form-data; boundary=" + boundary);
  assert.equal(parsed.fields.pages, "1,2");
  assert.equal(parsed.files.file.filename, "receipt.png");
  assert.equal(parsed.files.file.type, "image/png");
  assert.equal(parsed.files.file.data.toString(), "PNGDATA");
});

test("buildMistralRequest disables image echo and maps options", function () {
  const request = buildMistralRequest({
    type: "image/jpeg",
    data: Buffer.from("jpeg bytes")
  }, {
    pages: "2",
    tableFormat: "markdown",
    confidence: "page"
  });

  assert.equal(request.model, "mistral-ocr-latest");
  assert.equal(request.include_image_base64, false);
  assert.equal(request.document.type, "image_url");
  assert.match(request.document.image_url, /^data:image\/jpeg;base64,/);
  assert.deepEqual(request.pages, [1]);
  assert.equal(request.table_format, "markdown");
  assert.equal(request.confidence_scores_granularity, "page");
});

test("normalizeMistralError returns user-safe messages", function () {
  assert.equal(normalizeMistralError(401, {}).message, "Server OCR key is not authorized.");
  assert.equal(normalizeMistralError(429, {}).message, "Rate limit reached. Try again shortly.");
  assert.equal(normalizeMistralError(500, { message: "secret backend detail" }).message, "Mistral OCR is temporarily unavailable.");
});
