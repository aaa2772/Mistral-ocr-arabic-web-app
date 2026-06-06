"use strict";

const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const test = require("node:test");

const {
  buildMistralRequest,
  createServer,
  handleDocxExportRequest,
  normalizeMistralError,
  normalizeDocxPayload,
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

test("validateUpload accepts AVIF image signatures", function () {
  assert.doesNotThrow(function () {
    validateUpload({
      type: "image/avif",
      data: Buffer.from([
        0x00, 0x00, 0x00, 0x20,
        0x66, 0x74, 0x79, 0x70,
        0x61, 0x76, 0x69, 0x66,
        0x00, 0x00, 0x00, 0x00
      ])
    });
  });
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

test("buildMistralRequest maps advanced OCR quality options", function () {
  const request = buildMistralRequest({
    type: "application/pdf",
    data: Buffer.from("%PDF-1.7")
  }, {
    extractHeader: "true",
    extractFooter: "true",
    imageMode: "important"
  });

  assert.equal(request.include_image_base64, true);
  assert.equal(request.extract_header, true);
  assert.equal(request.extract_footer, true);
  assert.equal(request.image_limit, 8);
  assert.equal(request.image_min_size, 256);
});

test("buildMistralRequest rejects invalid image extraction mode", function () {
  assert.throws(function () {
    buildMistralRequest({
      type: "application/pdf",
      data: Buffer.from("%PDF-1.7")
    }, {
      imageMode: "all"
    });
  }, /Invalid image extraction option/);
});

test("normalizeMistralError returns user-safe messages", function () {
  assert.equal(normalizeMistralError(401, {}).message, "Server OCR key is not authorized.");
  assert.equal(normalizeMistralError(429, {}).message, "Rate limit reached. Try again shortly.");
  assert.equal(normalizeMistralError(500, { message: "secret backend detail" }).message, "Mistral OCR is temporarily unavailable.");
});

test("normalizeDocxPayload sanitizes unsafe links and preserves Arabic direction", function () {
  const payload = normalizeDocxPayload({
    filename: "arabic-result.docx",
    direction: "rtl",
    blocks: [{
      type: "paragraph",
      runs: [
        { text: "مرحبا", bold: true },
        { text: "رابط", href: "javascript:alert(1)" },
        { text: "موقع", href: "https://example.com" }
      ]
    }]
  });

  assert.equal(payload.filename, "arabic-result.docx");
  assert.equal(payload.direction, "rtl");
  assert.equal(payload.blocks[0].runs[1].href, "");
  assert.equal(payload.blocks[0].runs[2].href, "https://example.com/");
});

test("docx export endpoint returns a Word document", async function () {
  const response = await callDocxExport({
    filename: "arabic-result.docx",
    direction: "rtl",
    blocks: [
      { type: "heading", level: 1, runs: [{ text: "عنوان عربي" }] },
      { type: "paragraph", runs: [{ text: "نص قابل للتحرير", bold: true }] },
      {
        type: "table",
        rows: [
          [["الاسم"], ["القيمة"]],
          [["OCR"], ["جاهز"]]
        ]
      }
    ]
  });

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/);
  assert.match(response.headers["Content-Disposition"], /arabic-result\.docx/);
  assert.equal(response.body.slice(0, 2).toString("ascii"), "PK");
  assert.ok(response.body.length > 1000);
});

test("docx export endpoint rejects empty content", async function () {
  await assert.rejects(function () {
    return callDocxExport({
      filename: "empty.docx",
      direction: "rtl",
      blocks: []
    });
  }, /empty/i);
});

function callDocxExport(payload) {
  return new Promise(function (resolve, reject) {
    const req = Readable.from([Buffer.from(JSON.stringify(payload))]);
    req.method = "POST";
    req.headers = { "content-type": "application/json" };

    const res = {
      status: 0,
      headers: {},
      chunks: [],
      writeHead: function (status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end: function (chunk) {
        if (chunk) {
          this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        resolve({
          status: this.status,
          headers: this.headers,
          body: Buffer.concat(this.chunks)
        });
      }
    };

    handleDocxExportRequest(req, res).catch(reject);
  });
}
