"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_BODY_BYTES = MAX_FILE_BYTES + 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120000;

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/bmp",
  "image/tiff"
]);

const STATIC_MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8"
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

  return request;
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
    throw new HttpError(415, "Unsupported file type. Use PDF, PNG, JPG, WEBP, BMP, or TIFF.");
  }

  if (file.data.length > MAX_FILE_BYTES) {
    throw new HttpError(413, "File too large. The maximum size is 50MB.");
  }

  if (file.data.length === 0) {
    throw new HttpError(400, "Uploaded file is empty.");
  }
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
  buildMistralRequest,
  normalizeMistralError,
  parseMultipartFormData,
  parsePageSelection,
  validateUpload
};
