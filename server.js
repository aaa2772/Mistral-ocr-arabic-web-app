"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");
const {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  Packer,
  PageBreak,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  UnderlineType,
  WidthType
} = require("docx");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_BODY_BYTES = MAX_FILE_BYTES + 1024 * 1024;
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120000;
const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCX_FONT = {
  ascii: "Dubai",
  hAnsi: "Dubai",
  cs: "Dubai",
  eastAsia: "Dubai"
};

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/bmp",
  "image/tiff",
  "image/avif"
]);

const STATIC_MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".woff2": "font/woff2"
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

loadEnvFile(path.join(ROOT, ".env"));

function createServer() {
  return http.createServer(async function (req, res) {
    try {
      const requestUrl = new URL(req.url || "/", "http://localhost");

      if (requestUrl.pathname === "/api/ocr") {
        await handleOcrRequest(req, res);
        return;
      }

      if (requestUrl.pathname === "/api/export/docx") {
        await handleDocxExportRequest(req, res);
        return;
      }

      await serveStatic(req, res, requestUrl);
    } catch (error) {
      sendJson(res, error.status || 500, {
        error: {
          message: error.status ? error.message : "Unexpected server error."
        }
      });
    }
  });
}

async function handleOcrRequest(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, securityHeaders());
    res.end();
    return;
  }

  if (req.method !== "POST") {
    throw new HttpError(405, "Only POST is supported.");
  }

  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    throw new HttpError(503, "Mistral API key is not configured on the server.");
  }

  const contentType = req.headers["content-type"] || "";
  if (!contentType.startsWith("multipart/form-data")) {
    throw new HttpError(415, "Upload must use multipart/form-data.");
  }

  const body = await readRequestBody(req, MAX_BODY_BYTES);
  const parsed = parseMultipartFormData(body, contentType);
  const file = parsed.files.file;

  validateUpload(file);

  const requestBody = buildMistralRequest(file, parsed.fields);
  const controller = new AbortController();
  const timeout = setTimeout(function () {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.mistral.ai/v1/ocr", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (error) {
        payload = {};
      }
    }

    if (!response.ok) {
      throw normalizeMistralError(response.status, payload);
    }

    sendJson(res, 200, payload);
  } catch (error) {
    if (error.name === "AbortError") {
      throw new HttpError(504, "OCR request timed out. Try a smaller file or fewer pages.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function handleDocxExportRequest(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, securityHeaders());
    res.end();
    return;
  }

  if (req.method !== "POST") {
    throw new HttpError(405, "Only POST is supported.");
  }

  const contentType = req.headers["content-type"] || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "DOCX export must use application/json.");
  }

  const body = await readRequestBody(req, MAX_JSON_BODY_BYTES);
  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch (error) {
    throw new HttpError(400, "Invalid DOCX export JSON.");
  }

  const normalized = normalizeDocxPayload(payload);
  const buffer = await buildDocxBuffer(normalized);
  sendBinary(res, 200, buffer, {
    "Content-Type": DOCX_MIME_TYPE,
    "Content-Disposition": buildContentDisposition(normalized.filename),
    "Cache-Control": "no-store"
  });
}

function buildMistralRequest(file, fields) {
  const dataUrl = "data:" + file.type + ";base64," + file.data.toString("base64");
  const document = file.type === "application/pdf"
    ? { type: "document_url", document_url: dataUrl }
    : { type: "image_url", image_url: dataUrl };

  const request = {
    model: "mistral-ocr-latest",
    document: document,
    include_image_base64: false
  };

  const pages = parsePageSelection(fields.pages || "");
  if (pages) {
    request.pages = pages;
  }

  if (fields.tableFormat) {
    if (!["markdown", "html"].includes(fields.tableFormat)) {
      throw new HttpError(400, "Invalid table format option.");
    }
    request.table_format = fields.tableFormat;
  }

  if (fields.confidence) {
    if (!["page", "word"].includes(fields.confidence)) {
      throw new HttpError(400, "Invalid confidence option.");
    }
    request.confidence_scores_granularity = fields.confidence;
  }

  if (readBooleanField(fields.extractHeader, "header extraction")) {
    request.extract_header = true;
  }

  if (readBooleanField(fields.extractFooter, "footer extraction")) {
    request.extract_footer = true;
  }

  const imageMode = String(fields.imageMode || "none").trim();
  if (!["none", "important"].includes(imageMode)) {
    throw new HttpError(400, "Invalid image extraction option.");
  }

  if (imageMode === "important") {
    request.include_image_base64 = true;
    request.image_limit = 8;
    request.image_min_size = 256;
  }

  return request;
}

function readBooleanField(value, label) {
  const input = String(value || "").trim().toLowerCase();
  if (!input || input === "false") {
    return false;
  }
  if (input === "true") {
    return true;
  }
  throw new HttpError(400, "Invalid " + label + " option.");
}

function normalizeDocxPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HttpError(400, "DOCX export payload must be an object.");
  }

  const filename = sanitizeDocxFilename(payload.filename);
  const direction = payload.direction === "ltr" ? "ltr" : "rtl";
  const blocks = normalizeDocxBlocks(payload.blocks);

  if (!blocks.length) {
    throw new HttpError(400, "DOCX export content is empty.");
  }

  return {
    filename: filename,
    direction: direction,
    blocks: blocks
  };
}

function sanitizeDocxFilename(value) {
  const base = String(value || "ocr-result.docx")
    .replace(/\.[^.]+$/, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "ocr-result";

  return base + ".docx";
}

function buildContentDisposition(filename) {
  const asciiName = filename
    .replace(/[^\x20-\x7e]/g, "-")
    .replace(/["\\]/g, "-") || "ocr-result.docx";
  return "attachment; filename=\"" + asciiName + "\"; filename*=UTF-8''" + encodeURIComponent(filename);
}

function normalizeDocxBlocks(blocks) {
  if (!Array.isArray(blocks)) {
    throw new HttpError(400, "DOCX export blocks must be an array.");
  }

  return blocks.slice(0, 400).map(normalizeDocxBlock).filter(Boolean);
}

function normalizeDocxBlock(block) {
  if (!block || typeof block !== "object") {
    return null;
  }

  if (block.type === "pageBreak") {
    return { type: "pageBreak" };
  }

  if (block.type === "heading") {
    const runs = normalizeDocxRuns(block.runs);
    if (!runs.length) {
      return null;
    }
    const level = Number(block.level);
    return {
      type: "heading",
      level: [1, 2, 3].includes(level) ? level : 2,
      runs: runs
    };
  }

  if (block.type === "paragraph") {
    const runs = normalizeDocxRuns(block.runs);
    return runs.length ? { type: "paragraph", runs: runs } : null;
  }

  if (block.type === "list") {
    const ordered = block.ordered === true;
    const items = Array.isArray(block.items)
      ? block.items.slice(0, 120).map(normalizeDocxRuns).filter(function (runs) {
          return runs.length;
        })
      : [];
    return items.length ? { type: "list", ordered: ordered, items: items } : null;
  }

  if (block.type === "table") {
    const rows = Array.isArray(block.rows)
      ? block.rows.slice(0, 80).map(normalizeDocxTableRow).filter(function (row) {
          return row.length;
        })
      : [];
    return rows.length ? { type: "table", rows: rows } : null;
  }

  return null;
}

function normalizeDocxTableRow(row) {
  if (!Array.isArray(row)) {
    return [];
  }

  return row.slice(0, 20).map(function (cell) {
    if (Array.isArray(cell)) {
      return normalizeDocxRuns(cell);
    }
    if (cell && typeof cell === "object" && Array.isArray(cell.runs)) {
      return normalizeDocxRuns(cell.runs);
    }
    return normalizeDocxRuns([{ text: String(cell || "") }]);
  });
}

function normalizeDocxRuns(runs) {
  if (!Array.isArray(runs)) {
    return [];
  }

  return runs.slice(0, 800).map(function (run) {
    if (typeof run === "string") {
      return normalizeDocxRun({ text: run });
    }
    return normalizeDocxRun(run);
  }).filter(Boolean);
}

function normalizeDocxRun(run) {
  if (!run || typeof run !== "object") {
    return null;
  }

  const text = String(run.text || "").replace(/\s+/g, " ").slice(0, 4000);
  if (!text.trim()) {
    return null;
  }

  return {
    text: text,
    bold: run.bold === true,
    italic: run.italic === true,
    underline: run.underline === true,
    code: run.code === true,
    href: sanitizeExportUrl(run.href)
  };
}

function sanitizeExportUrl(value) {
  const input = String(value || "").trim();
  if (!input) {
    return "";
  }

  try {
    const parsed = new URL(input);
    if (["http:", "https:", "mailto:"].includes(parsed.protocol)) {
      return parsed.href;
    }
  } catch (error) {
    return "";
  }

  return "";
}

async function buildDocxBuffer(payload) {
  const doc = new Document({
    creator: "Mistral OCR Arabic Web App",
    title: payload.filename.replace(/\.docx$/i, ""),
    styles: {
      default: {
        document: {
          run: {
            font: DOCX_FONT,
            size: 24
          },
          paragraph: {
            alignment: payload.direction === "rtl" ? AlignmentType.RIGHT : AlignmentType.LEFT,
            spacing: { after: 160 }
          }
        }
      }
    },
    numbering: {
      config: [{
        reference: "ocr-numbering",
        levels: [{
          level: 0,
          format: "decimal",
          text: "%1.",
          alignment: AlignmentType.START
        }]
      }]
    },
    sections: [{
      properties: {},
      children: payload.blocks.flatMap(function (block) {
        return blockToDocxChildren(block, payload.direction);
      })
    }]
  });

  return Packer.toBuffer(doc);
}

function blockToDocxChildren(block, direction) {
  if (block.type === "pageBreak") {
    return [new Paragraph({ children: [new PageBreak()] })];
  }

  if (block.type === "heading") {
    return [new Paragraph({
      heading: readHeadingLevel(block.level),
      bidirectional: direction === "rtl",
      alignment: direction === "rtl" ? AlignmentType.RIGHT : AlignmentType.LEFT,
      children: runsToDocxChildren(block.runs, direction)
    })];
  }

  if (block.type === "paragraph") {
    return [new Paragraph({
      bidirectional: direction === "rtl",
      alignment: direction === "rtl" ? AlignmentType.RIGHT : AlignmentType.LEFT,
      children: runsToDocxChildren(block.runs, direction)
    })];
  }

  if (block.type === "list") {
    return block.items.map(function (runs) {
      const options = {
        bidirectional: direction === "rtl",
        alignment: direction === "rtl" ? AlignmentType.RIGHT : AlignmentType.LEFT,
        children: runsToDocxChildren(runs, direction)
      };
      if (block.ordered) {
        options.numbering = { reference: "ocr-numbering", level: 0 };
      } else {
        options.bullet = { level: 0 };
      }
      return new Paragraph(options);
    });
  }

  if (block.type === "table") {
    return [new Table({
      alignment: direction === "rtl" ? AlignmentType.RIGHT : AlignmentType.LEFT,
      visuallyRightToLeft: direction === "rtl",
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top: { style: BorderStyle.SINGLE, size: 1, color: "D9E0E7" },
        bottom: { style: BorderStyle.SINGLE, size: 1, color: "D9E0E7" },
        left: { style: BorderStyle.SINGLE, size: 1, color: "D9E0E7" },
        right: { style: BorderStyle.SINGLE, size: 1, color: "D9E0E7" },
        insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: "D9E0E7" },
        insideVertical: { style: BorderStyle.SINGLE, size: 1, color: "D9E0E7" }
      },
      rows: block.rows.map(function (row) {
        return new TableRow({
          children: row.map(function (cellRuns) {
            return new TableCell({
              children: [new Paragraph({
                bidirectional: direction === "rtl",
                alignment: direction === "rtl" ? AlignmentType.RIGHT : AlignmentType.LEFT,
                children: runsToDocxChildren(cellRuns, direction)
              })]
            });
          })
        });
      })
    })];
  }

  return [];
}

function readHeadingLevel(level) {
  if (level === 1) {
    return HeadingLevel.HEADING_1;
  }
  if (level === 3) {
    return HeadingLevel.HEADING_3;
  }
  return HeadingLevel.HEADING_2;
}

function runsToDocxChildren(runs, direction) {
  return runs.map(function (run) {
    const textRun = new TextRun({
      text: run.text,
      bold: run.bold,
      boldComplexScript: run.bold,
      italics: run.italic,
      italicsComplexScript: run.italic,
      underline: run.underline ? { type: UnderlineType.SINGLE } : undefined,
      font: run.code ? "Courier New" : DOCX_FONT,
      rightToLeft: direction === "rtl",
      size: run.code ? 22 : 24
    });

    if (run.href) {
      return new ExternalHyperlink({
        link: run.href,
        children: [textRun]
      });
    }

    return textRun;
  });
}

function parsePageSelection(value) {
  const input = String(value || "").trim();
  if (!input) {
    return undefined;
  }

  const pages = [];
  const seen = new Set();

  input.split(",").forEach(function (part) {
    const token = part.trim();
    if (!token) {
      return;
    }

    const range = /^(\d+)\s*-\s*(\d+)$/.exec(token);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
        throw new HttpError(400, "Pages must be positive numbers such as 1,3-5.");
      }
      for (let page = start; page <= end; page += 1) {
        addPage(page);
      }
      return;
    }

    if (!/^\d+$/.test(token)) {
      throw new HttpError(400, "Pages must be positive numbers such as 1,3-5.");
    }
    addPage(Number(token));
  });

  function addPage(page) {
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new HttpError(400, "Pages must start at 1.");
    }
    const zeroBased = page - 1;
    if (!seen.has(zeroBased)) {
      seen.add(zeroBased);
      pages.push(zeroBased);
    }
  }

  return pages.length ? pages : undefined;
}

function validateUpload(file) {
  if (!file || !Buffer.isBuffer(file.data)) {
    throw new HttpError(400, "Exactly one file field named 'file' is required.");
  }

  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    throw new HttpError(415, "Unsupported file type. Use PDF, PNG, JPG, WEBP, BMP, TIFF, or AVIF.");
  }

  if (file.data.length > MAX_FILE_BYTES) {
    throw new HttpError(413, "File too large. The maximum size is 50MB.");
  }

  if (file.data.length === 0) {
    throw new HttpError(400, "Uploaded file is empty.");
  }

  const detectedType = detectFileType(file.data);
  if (detectedType !== file.type) {
    throw new HttpError(415, "File content does not match the selected file type.");
  }
}

function detectFileType(data) {
  if (data.length >= 5 && data.slice(0, 5).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }

  if (data.length >= 8 && data.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }

  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    data.length >= 12 &&
    data.slice(0, 4).toString("ascii") === "RIFF" &&
    data.slice(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  if (data.length >= 2 && data.slice(0, 2).toString("ascii") === "BM") {
    return "image/bmp";
  }

  if (
    data.length >= 4 &&
    (
      data.slice(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) ||
      data.slice(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))
    )
  ) {
    return "image/tiff";
  }

  if (isAvifFile(data)) {
    return "image/avif";
  }

  return "";
}

function isAvifFile(data) {
  if (data.length < 12 || data.slice(4, 8).toString("ascii") !== "ftyp") {
    return false;
  }

  const majorBrand = data.slice(8, 12).toString("ascii");
  if (majorBrand === "avif" || majorBrand === "avis") {
    return true;
  }

  for (let index = 16; index + 4 <= data.length; index += 4) {
    const brand = data.slice(index, index + 4).toString("ascii");
    if (brand === "avif" || brand === "avis") {
      return true;
    }
  }

  return false;
}

function normalizeMistralError(status, payload) {
  if (status === 401 || status === 403) {
    return new HttpError(status, "Server OCR key is not authorized.");
  }
  if (status === 413) {
    return new HttpError(413, "The OCR provider rejected this file as too large.");
  }
  if (status === 429) {
    return new HttpError(429, "Rate limit reached. Try again shortly.");
  }
  if (status >= 500) {
    return new HttpError(502, "Mistral OCR is temporarily unavailable.");
  }

  const message = payload && (payload.message || payload.detail);
  return new HttpError(status, typeof message === "string" && message.length <= 240
    ? message
    : "Mistral OCR request failed.");
}

function parseMultipartFormData(body, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const boundaryValue = boundaryMatch && (boundaryMatch[1] || boundaryMatch[2]);
  if (!boundaryValue) {
    throw new HttpError(400, "Missing multipart boundary.");
  }

  const boundary = Buffer.from("--" + boundaryValue);
  const parts = splitBuffer(body, boundary);
  const fields = {};
  const files = {};

  parts.forEach(function (part) {
    let chunk = trimPart(part);
    if (!chunk.length || chunk.equals(Buffer.from("--"))) {
      return;
    }
    if (chunk.slice(0, 2).equals(Buffer.from("--"))) {
      return;
    }

    const headerEnd = chunk.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) {
      return;
    }

    const headerText = chunk.slice(0, headerEnd).toString("utf8");
    let content = chunk.slice(headerEnd + 4);
    if (content.slice(-2).equals(Buffer.from("\r\n"))) {
      content = content.slice(0, -2);
    }

    const headers = parseHeaders(headerText);
    const disposition = parseDisposition(headers["content-disposition"] || "");
    if (!disposition.name) {
      return;
    }

    if (disposition.filename) {
      files[disposition.name] = {
        filename: path.basename(disposition.filename),
        type: normalizeMime(headers["content-type"] || ""),
        data: content
      };
    } else {
      fields[disposition.name] = content.toString("utf8").trim();
    }
  });

  return { fields: fields, files: files };
}

function splitBuffer(buffer, separator) {
  const result = [];
  let start = 0;
  let index = buffer.indexOf(separator, start);

  while (index !== -1) {
    result.push(buffer.slice(start, index));
    start = index + separator.length;
    index = buffer.indexOf(separator, start);
  }
  result.push(buffer.slice(start));
  return result;
}

function trimPart(part) {
  let chunk = part;
  if (chunk.slice(0, 2).equals(Buffer.from("\r\n"))) {
    chunk = chunk.slice(2);
  }
  if (chunk.slice(-2).equals(Buffer.from("\r\n"))) {
    chunk = chunk.slice(0, -2);
  }
  return chunk;
}

function parseHeaders(headerText) {
  const headers = {};
  headerText.split(/\r?\n/).forEach(function (line) {
    const index = line.indexOf(":");
    if (index === -1) {
      return;
    }
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  });
  return headers;
}

function parseDisposition(disposition) {
  const result = {};
  disposition.split(";").forEach(function (part) {
    const index = part.indexOf("=");
    if (index === -1) {
      return;
    }
    const key = part.slice(0, index).trim();
    let value = part.slice(index + 1).trim();
    if (value.startsWith("\"") && value.endsWith("\"")) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  });
  return result;
}

function normalizeMime(value) {
  return String(value || "").split(";")[0].trim().toLowerCase();
}

function readRequestBody(req, maxBytes) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let total = 0;

    req.on("data", function (chunk) {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new HttpError(413, "Upload request is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", function () {
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

async function serveStatic(req, res, requestUrl) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    throw new HttpError(405, "Only GET and HEAD are supported for static assets.");
  }

  const filePath = resolveStaticPath(requestUrl.pathname);
  const ext = path.extname(filePath);
  const contentType = STATIC_MIME_TYPES[ext];
  if (!contentType) {
    throw new HttpError(404, "Not found.");
  }

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch (error) {
    throw new HttpError(404, "Not found.");
  }

  if (!stat.isFile()) {
    throw new HttpError(404, "Not found.");
  }

  res.writeHead(200, Object.assign(securityHeaders(), {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600"
  }));

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  fs.createReadStream(filePath).pipe(res);
}

function resolveStaticPath(pathname) {
  const decoded = decodeURIComponent(pathname);
  const cleanPath = decoded === "/" ? "/index.html" : decoded;
  const normalized = path.normalize(cleanPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(ROOT, normalized);

  if (!filePath.startsWith(ROOT) || path.basename(filePath).startsWith(".")) {
    throw new HttpError(404, "Not found.");
  }

  if (["server.js", "package.json", "package-lock.json"].includes(path.basename(filePath))) {
    throw new HttpError(404, "Not found.");
  }

  return filePath;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, Object.assign(securityHeaders(), {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  }));
  res.end(body);
}

function sendBinary(res, status, body, headers) {
  res.writeHead(status, Object.assign(securityHeaders(), headers, {
    "Content-Length": body.length
  }));
  res.end(body);
}

function securityHeaders() {
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' blob: data:",
      "connect-src 'self'",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'"
    ].join("; "),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff"
  };
}

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, "utf8");
  content.split(/\r?\n/).forEach(function (line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }

    const index = trimmed.indexOf("=");
    if (index === -1) {
      return;
    }

    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  });
}

if (require.main === module) {
  createServer().listen(PORT, HOST, function () {
    console.log("OCR app listening on http://" + HOST + ":" + PORT);
  });
}

module.exports = {
  HttpError,
  buildDocxBuffer,
  buildMistralRequest,
  createServer,
  detectFileType,
  handleDocxExportRequest,
  normalizeMistralError,
  normalizeDocxPayload,
  parseMultipartFormData,
  parsePageSelection,
  validateUpload
};
