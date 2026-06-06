(function () {
  "use strict";

  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
  }

  const MAX_FILE_BYTES = 50 * 1024 * 1024;
  const VALID_TYPES = new Set([
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/bmp",
    "image/tiff"
  ]);
  const RECENT_KEY = "recent_scans";
  const MAX_RECENT = 10;
  const MAX_RENDERED_TABLES = 6;
  const MAX_LOW_CONFIDENCE_WORDS = 8;

  const state = {
    currentFile: null,
    currentImageUrl: "",
    pdfDoc: null,
    currentPage: 1,
    totalPages: 1,
    scale: 1,
    requestId: 0,
    abortController: null,
    recentScans: loadRecentScans()
  };

  const els = {};

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    cacheElements();
    bindEvents();
    renderRecentScans();
    clearResultMetadata();
    updatePageControls();
  }

  function cacheElements() {
    [
      "uploadZone",
      "fileInput",
      "cameraInput",
      "mobileScanBtn",
      "processingSection",
      "processingLabel",
      "progressBar",
      "cancelBtn",
      "resultsSection",
      "previewContainer",
      "pageNum",
      "zoomBtn",
      "prevPageBtn",
      "nextPageBtn",
      "editorContent",
      "downloadBtn",
      "printBtn",
      "linkBtn",
      "scanList",
      "clearHistoryBtn",
      "toastContainer",
      "pagesInput",
      "tableFormatSelect",
      "confidenceSelect",
      "resultDetails",
      "resultSummary",
      "confidenceDetails",
      "tableDetails"
    ].forEach(function (id) {
      els[id] = document.getElementById(id);
    });
  }

  function bindEvents() {
    els.uploadZone.addEventListener("click", function () {
      els.fileInput.click();
    });
    els.uploadZone.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        els.fileInput.click();
      }
    });
    els.uploadZone.addEventListener("dragover", function (event) {
      event.preventDefault();
      els.uploadZone.classList.add("dragover");
    });
    els.uploadZone.addEventListener("dragleave", function () {
      els.uploadZone.classList.remove("dragover");
    });
    els.uploadZone.addEventListener("drop", function (event) {
      event.preventDefault();
      els.uploadZone.classList.remove("dragover");
      if (event.dataTransfer.files.length) {
        handleFile(event.dataTransfer.files[0]);
      }
    });

    els.fileInput.addEventListener("change", function (event) {
      if (event.target.files.length) {
        handleFile(event.target.files[0]);
      }
    });
    els.cameraInput.addEventListener("change", function (event) {
      if (event.target.files.length) {
        handleFile(event.target.files[0]);
      }
    });
    els.mobileScanBtn.addEventListener("click", function () {
      els.cameraInput.click();
    });
    els.cancelBtn.addEventListener("click", cancelActiveRequest);
    els.zoomBtn.addEventListener("click", zoomPreview);
    els.prevPageBtn.addEventListener("click", prevPage);
    els.nextPageBtn.addEventListener("click", nextPage);
    els.downloadBtn.addEventListener("click", downloadText);
    els.printBtn.addEventListener("click", printText);
    els.linkBtn.addEventListener("click", addLink);
    els.clearHistoryBtn.addEventListener("click", clearRecentScans);

    document.querySelectorAll("[data-command]").forEach(function (button) {
      button.addEventListener("click", function () {
        execCmd(button.dataset.command);
      });
    });

    els.editorContent.addEventListener("paste", function (event) {
      event.preventDefault();
      const text = event.clipboardData.getData("text/plain");
      document.execCommand("insertText", false, text);
    });
    els.editorContent.addEventListener("input", normalizeEditorLinks);
  }

  function handleFile(file) {
    if (window.location.protocol === "file:") {
      showToast("شغل الخادم المحلي عبر npm start ثم افتح http://localhost:3000 أو المنفذ الذي يظهر في الطرفية.", "error");
      resetFileInputs();
      return;
    }

    if (!VALID_TYPES.has(file.type)) {
      showToast("نوع الملف غير مدعوم. استخدم PDF أو PNG أو JPG أو WEBP أو BMP أو TIFF.", "error");
      resetFileInputs();
      return;
    }

    if (file.size > MAX_FILE_BYTES) {
      showToast("الملف كبير جدا. الحد الأقصى 50MB.", "error");
      resetFileInputs();
      return;
    }

    state.currentFile = file;
    resetFileInputs();
    processOCR(file);
  }

  async function processOCR(file) {
    const requestId = state.requestId + 1;
    state.requestId = requestId;
    cancelActiveRequest({ silent: true });

    const controller = new AbortController();
    state.abortController = controller;

    setProcessing(true, "جاري رفع الملف ومعالجته");
    els.resultsSection.classList.remove("active");
    els.editorContent.replaceChildren();
    clearResultMetadata();

    try {
      const formData = new FormData();
      formData.append("file", file, file.name);
      formData.append("pages", els.pagesInput.value.trim());
      formData.append("tableFormat", els.tableFormatSelect.value);
      formData.append("confidence", els.confidenceSelect.value);

      const response = await fetch("/api/ocr", {
        method: "POST",
        body: formData,
        signal: controller.signal
      });

      if (requestId !== state.requestId) {
        return;
      }

      if (!response.ok) {
        throw new Error(await readApiError(response));
      }

      const data = await response.json();
      els.progressBar.className = "progress-fill done";
      await renderPreview(file);

      if (requestId !== state.requestId) {
        return;
      }

      showResults(data);
      saveToRecent(file.name, data);
      showToast("اكتملت معالجة OCR بنجاح.", "success");
    } catch (error) {
      if (error.name === "AbortError") {
        showToast("تم إلغاء المعالجة.", "info");
      } else {
        showToast(error.message || "تعذر تنفيذ OCR.", "error");
      }
    } finally {
      if (requestId === state.requestId) {
        state.abortController = null;
        setTimeout(function () {
          setProcessing(false);
        }, 450);
      }
    }
  }

  async function readApiError(response) {
    const fallback = "فشل طلب OCR. حاول مرة أخرى.";
    try {
      const data = await response.json();
      return data && data.error && data.error.message ? data.error.message : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function cancelActiveRequest(options) {
    if (state.abortController) {
      state.abortController.abort();
      state.abortController = null;
      if (!options || !options.silent) {
        state.requestId += 1;
      }
    }
  }

  function setProcessing(active, label) {
    els.processingSection.classList.toggle("active", active);
    els.processingLabel.textContent = label || "جاري المعالجة";
    els.progressBar.className = "progress-fill";
    els.progressBar.style.width = "";
  }

  function resetFileInputs() {
    els.fileInput.value = "";
    els.cameraInput.value = "";
  }

  async function renderPreview(file) {
    els.previewContainer.replaceChildren();
    state.currentPage = 1;
    state.scale = 1;
    revokeImageUrl();

    if (file.type === "application/pdf") {
      if (!window.pdfjsLib) {
        renderPreviewMessage("تعذر تحميل عارض PDF المحلي، لكن النص المستخرج متاح للتحرير.");
        return;
      }

      const buffer = await file.arrayBuffer();
      state.pdfDoc = await window.pdfjsLib.getDocument({ data: buffer }).promise;
      state.totalPages = state.pdfDoc.numPages;
      await renderPdfPage(state.currentPage);
    } else {
      state.pdfDoc = null;
      state.totalPages = 1;
      const img = document.createElement("img");
      state.currentImageUrl = URL.createObjectURL(file);
      img.src = state.currentImageUrl;
      img.alt = file.name;
      els.previewContainer.appendChild(img);
    }

    updatePageControls();
  }

  async function renderPdfPage(pageNumber) {
    if (!state.pdfDoc) {
      return;
    }
    els.previewContainer.replaceChildren();
    const page = await state.pdfDoc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: state.scale * 1.5 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({
      canvasContext: canvas.getContext("2d"),
      viewport: viewport
    }).promise;
    els.previewContainer.appendChild(canvas);
  }

  function renderPreviewMessage(message) {
    state.pdfDoc = null;
    state.totalPages = 1;
    const p = document.createElement("p");
    p.className = "preview-empty";
    p.textContent = message;
    els.previewContainer.replaceChildren(p);
    updatePageControls();
  }

  function updatePageControls() {
    els.pageNum.textContent = state.currentPage + " / " + state.totalPages;
    els.prevPageBtn.disabled = !state.pdfDoc || state.currentPage <= 1;
    els.nextPageBtn.disabled = !state.pdfDoc || state.currentPage >= state.totalPages;
  }

  function prevPage() {
    if (!state.pdfDoc || state.currentPage <= 1) {
      return;
    }
    state.currentPage -= 1;
    renderPdfPage(state.currentPage);
    updatePageControls();
  }

  function nextPage() {
    if (!state.pdfDoc || state.currentPage >= state.totalPages) {
      return;
    }
    state.currentPage += 1;
    renderPdfPage(state.currentPage);
    updatePageControls();
  }

  function zoomPreview() {
    state.scale = state.scale >= 2 ? 0.75 : state.scale + 0.25;
    if (state.pdfDoc) {
      renderPdfPage(state.currentPage);
    } else {
      const img = els.previewContainer.querySelector("img");
      if (img) {
        img.style.transform = "scale(" + state.scale + ")";
      }
    }
  }

  function showResults(data) {
    const markdown = Array.isArray(data.pages)
      ? data.pages.map(function (page) {
          return typeof page.markdown === "string" ? page.markdown : "";
        }).join("\n\n---\n\n")
      : "";

    els.editorContent.replaceChildren(renderMarkdownFragment(markdown));
    els.editorContent.dir = "auto";
    normalizeEditorLinks();
    renderResultMetadata(data);
    els.resultsSection.classList.add("active");
  }

  function clearResultMetadata() {
    els.resultDetails.hidden = true;
    els.resultSummary.replaceChildren();
    els.confidenceDetails.replaceChildren();
    els.tableDetails.replaceChildren();
  }

  function renderResultMetadata(data) {
    const pages = Array.isArray(data.pages) ? data.pages : [];
    const tables = collectTables(data);
    const confidenceRows = collectConfidenceScores(pages);

    els.resultSummary.replaceChildren(
      createSummaryMetric("الصفحات", String(pages.length), "عدد الصفحات التي عالجها OCR"),
      createSummaryMetric("الجداول", String(tables.length), tables.length ? "جداول منفصلة رجعت من Mistral" : "لا توجد جداول منفصلة"),
      createSummaryMetric("الثقة", confidenceRows.length ? "متاحة" : "غير متاحة", confidenceRows.length ? "تم عرض درجات الثقة أدناه" : "اختر مستوى الثقة قبل الرفع لعرضها")
    );

    renderConfidenceDetails(confidenceRows);
    renderTableDetails(tables);
    els.resultDetails.hidden = false;
  }

  function createSummaryMetric(label, value, hint) {
    const item = document.createElement("div");
    item.className = "summary-metric";

    const labelEl = document.createElement("span");
    labelEl.className = "metric-label";
    labelEl.textContent = label;

    const valueEl = document.createElement("strong");
    valueEl.textContent = value;

    const hintEl = document.createElement("span");
    hintEl.className = "metric-hint";
    hintEl.textContent = hint;

    item.appendChild(labelEl);
    item.appendChild(valueEl);
    item.appendChild(hintEl);
    return item;
  }

  function collectTables(data) {
    const tables = [];
    const pages = Array.isArray(data.pages) ? data.pages : [];

    addTables(data.tables, null);
    pages.forEach(function (page, index) {
      addTables(page && page.tables, index + 1);
    });

    function addTables(source, pageNumber) {
      if (!Array.isArray(source)) {
        return;
      }
      source.forEach(function (table, index) {
        const normalized = normalizeTable(table, pageNumber, index + 1);
        if (normalized) {
          tables.push(normalized);
        }
      });
    }

    return tables;
  }

  function normalizeTable(table, pageNumber, position) {
    const title = pageNumber ? "صفحة " + pageNumber + " · جدول " + position : "جدول " + position;

    if (typeof table === "string") {
      return { title: title, format: "text", content: table };
    }

    if (!table || typeof table !== "object") {
      return null;
    }

    if (typeof table.markdown === "string") {
      return { title: table.title || title, format: "markdown", content: table.markdown };
    }

    if (typeof table.html === "string") {
      return { title: table.title || title, format: "html", content: table.html };
    }

    if (typeof table.content === "string") {
      return { title: table.title || title, format: table.format || "text", content: table.content };
    }

    return { title: table.title || title, format: "json", content: JSON.stringify(table, null, 2) };
  }

  function renderConfidenceDetails(confidenceRows) {
    els.confidenceDetails.replaceChildren();
    els.confidenceDetails.appendChild(createDetailTitle("الثقة", confidenceRows.length ? "درجات الثقة حسب الصفحة" : "لم ترجع درجات ثقة"));

    if (!confidenceRows.length) {
      els.confidenceDetails.appendChild(createDetailEmpty("اختر مستوى الصفحة أو الكلمة قبل رفع الملف لعرض هذه البيانات."));
      return;
    }

    const list = document.createElement("div");
    list.className = "confidence-list";
    confidenceRows.forEach(function (row) {
      const item = document.createElement("article");
      item.className = "confidence-item";

      const header = document.createElement("div");
      header.className = "confidence-header";
      const title = document.createElement("strong");
      title.textContent = "صفحة " + row.page;
      const score = document.createElement("span");
      score.textContent = row.average === null ? "متوسط غير متاح" : "متوسط " + formatPercent(row.average);
      header.appendChild(title);
      header.appendChild(score);

      const bar = document.createElement("div");
      bar.className = "confidence-bar";
      const fill = document.createElement("span");
      fill.style.width = row.average === null ? "0%" : formatPercent(row.average);
      bar.appendChild(fill);

      const meta = document.createElement("p");
      meta.textContent = row.minimum === null ? "أدنى ثقة غير متاحة." : "أدنى ثقة: " + formatPercent(row.minimum) + ".";

      item.appendChild(header);
      item.appendChild(bar);
      item.appendChild(meta);

      if (row.words.length) {
        const words = document.createElement("div");
        words.className = "word-score-list";
        row.words.slice(0, MAX_LOW_CONFIDENCE_WORDS).forEach(function (word) {
          const chip = document.createElement("span");
          chip.textContent = word.text + " · " + formatPercent(word.score);
          words.appendChild(chip);
        });
        item.appendChild(words);
      }

      list.appendChild(item);
    });
    els.confidenceDetails.appendChild(list);
  }

  function collectConfidenceScores(pages) {
    const rows = [];
    pages.forEach(function (page, index) {
      const source = page && (page.confidence_scores || page.confidenceScores || page.confidence);
      if (!source || typeof source !== "object") {
        return;
      }

      const average = readScore(source.average_page_confidence_score, source.averagePageConfidenceScore, source.average, source.avg);
      const minimum = readScore(source.minimum_page_confidence_score, source.minimumPageConfidenceScore, source.minimum, source.min);
      const words = normalizeWordScores(source.word_confidence_scores || source.wordConfidenceScores || source.words || []);

      rows.push({
        page: Number.isFinite(Number(page.index)) ? Number(page.index) + 1 : index + 1,
        average: average,
        minimum: minimum,
        words: words
      });
    });
    return rows;
  }

  function normalizeWordScores(words) {
    if (!Array.isArray(words)) {
      return [];
    }
    return words.map(function (entry) {
      if (Array.isArray(entry)) {
        return { text: String(entry[0] || ""), score: readScore(entry[1]) };
      }
      if (!entry || typeof entry !== "object") {
        return null;
      }
      return {
        text: String(entry.word || entry.text || entry.value || "").slice(0, 48),
        score: readScore(entry.confidence_score, entry.confidenceScore, entry.confidence, entry.score)
      };
    }).filter(function (entry) {
      return entry && entry.text && entry.score !== null;
    }).sort(function (a, b) {
      return a.score - b.score;
    });
  }

  function readScore() {
    for (let index = 0; index < arguments.length; index += 1) {
      const value = Number(arguments[index]);
      if (Number.isFinite(value)) {
        return value;
      }
    }
    return null;
  }

  function formatPercent(value) {
    const percent = value <= 1 ? value * 100 : value;
    return Math.max(0, Math.min(100, percent)).toFixed(1).replace(/\.0$/, "") + "%";
  }

  function renderTableDetails(tables) {
    els.tableDetails.replaceChildren();
    els.tableDetails.appendChild(createDetailTitle("الجداول", tables.length ? tables.length + " جدول منفصل" : "لم ترجع جداول منفصلة"));

    if (!tables.length) {
      els.tableDetails.appendChild(createDetailEmpty("اختيار Markdown أو HTML معقم يساعد على عرض الجداول هنا عندما يرجعها مزود OCR."));
      return;
    }

    tables.slice(0, MAX_RENDERED_TABLES).forEach(function (table) {
      const item = document.createElement("article");
      item.className = "extracted-table";

      const heading = document.createElement("h3");
      heading.textContent = table.title;

      const body = document.createElement("div");
      body.className = "extracted-table-body editor-content";
      body.contentEditable = "false";

      if (table.format === "markdown") {
        body.appendChild(renderMarkdownFragment(table.content));
      } else if (table.format === "html") {
        body.appendChild(renderSafeHtmlFragment(table.content));
      } else {
        const pre = document.createElement("pre");
        pre.textContent = table.content;
        body.appendChild(pre);
      }

      item.appendChild(heading);
      item.appendChild(body);
      els.tableDetails.appendChild(item);
    });

    if (tables.length > MAX_RENDERED_TABLES) {
      els.tableDetails.appendChild(createDetailEmpty("تم عرض أول " + MAX_RENDERED_TABLES + " جداول فقط لتجنب ازدحام الواجهة."));
    }
  }

  function createDetailTitle(title, subtitle) {
    const header = document.createElement("div");
    header.className = "detail-title";
    const h = document.createElement("h2");
    h.textContent = title;
    const p = document.createElement("p");
    p.textContent = subtitle;
    header.appendChild(h);
    header.appendChild(p);
    return header;
  }

  function createDetailEmpty(message) {
    const empty = document.createElement("p");
    empty.className = "detail-empty";
    empty.textContent = message;
    return empty;
  }

  function renderSafeHtmlFragment(html) {
    const allowedTags = new Set(["TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TH", "TD", "CAPTION", "P", "BR", "STRONG", "B", "EM", "I", "CODE"]);
    const fragment = document.createDocumentFragment();
    const parsed = new DOMParser().parseFromString(String(html || ""), "text/html");

    Array.from(parsed.body.childNodes).forEach(function (node) {
      const clean = cloneSafeHtmlNode(node, allowedTags);
      if (clean) {
        fragment.appendChild(clean);
      }
    });

    return fragment;
  }

  function cloneSafeHtmlNode(node, allowedTags) {
    if (node.nodeType === Node.TEXT_NODE) {
      return document.createTextNode(node.nodeValue || "");
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return null;
    }

    if (!allowedTags.has(node.tagName)) {
      const span = document.createElement("span");
      Array.from(node.childNodes).forEach(function (child) {
        const clean = cloneSafeHtmlNode(child, allowedTags);
        if (clean) {
          span.appendChild(clean);
        }
      });
      return span;
    }

    const clone = document.createElement(node.tagName.toLowerCase());
    if (node.tagName === "TH" || node.tagName === "TD") {
      copyPositiveIntegerAttribute(node, clone, "colspan");
      copyPositiveIntegerAttribute(node, clone, "rowspan");
    }

    Array.from(node.childNodes).forEach(function (child) {
      const clean = cloneSafeHtmlNode(child, allowedTags);
      if (clean) {
        clone.appendChild(clean);
      }
    });
    return clone;
  }

  function copyPositiveIntegerAttribute(source, target, name) {
    const value = Number(source.getAttribute(name));
    if (Number.isInteger(value) && value > 0 && value <= 20) {
      target.setAttribute(name, String(value));
    }
  }

  function renderMarkdownFragment(markdown) {
    const fragment = document.createDocumentFragment();
    const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
    let i = 0;
    let paragraph = [];

    function flushParagraph() {
      if (!paragraph.length) {
        return;
      }
      const p = document.createElement("p");
      appendInline(p, paragraph.join(" "));
      fragment.appendChild(p);
      paragraph = [];
    }

    while (i < lines.length) {
      const rawLine = lines[i];
      const line = rawLine.trim();

      if (!line) {
        flushParagraph();
        i += 1;
        continue;
      }

      if (/^---+$/.test(line)) {
        flushParagraph();
        fragment.appendChild(document.createElement("hr"));
        i += 1;
        continue;
      }

      const heading = /^(#{1,3})\s+(.+)$/.exec(line);
      if (heading) {
        flushParagraph();
        const level = String(Math.min(heading[1].length, 3));
        const h = document.createElement("h" + level);
        appendInline(h, heading[2]);
        fragment.appendChild(h);
        i += 1;
        continue;
      }

      if (isMarkdownImage(line)) {
        flushParagraph();
        fragment.appendChild(renderImagePlaceholder(line));
        i += 1;
        continue;
      }

      if (isTableStart(lines, i)) {
        flushParagraph();
        const tableResult = renderTable(lines, i);
        fragment.appendChild(tableResult.table);
        i = tableResult.nextIndex;
        continue;
      }

      if (/^\s*[-*+]\s+/.test(rawLine) || /^\s*\d+[.)]\s+/.test(rawLine)) {
        flushParagraph();
        const listResult = renderList(lines, i);
        fragment.appendChild(listResult.list);
        i = listResult.nextIndex;
        continue;
      }

      paragraph.push(line);
      i += 1;
    }

    flushParagraph();
    return fragment;
  }

  function appendInline(parent, text) {
    const pattern = /(`([^`]+)`|\[([^\]]{1,300})\]\(([^)\s]+)\))/g;
    let lastIndex = 0;
    let match;

    while ((match = pattern.exec(text))) {
      if (match.index > lastIndex) {
        parent.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }

      if (match[2]) {
        const code = document.createElement("code");
        code.textContent = match[2];
        parent.appendChild(code);
      } else if (match[3] && match[4]) {
        const href = sanitizeUrl(match[4]);
        if (href) {
          const a = document.createElement("a");
          a.href = href;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = match[3];
          parent.appendChild(a);
        } else {
          parent.appendChild(document.createTextNode(match[3]));
        }
      }

      lastIndex = pattern.lastIndex;
    }

    if (lastIndex < text.length) {
      parent.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

  function isMarkdownImage(line) {
    return /^!\[[^\]]*\]\([^)]+\)$/.test(line);
  }

  function renderImagePlaceholder(line) {
    const match = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(line);
    const p = document.createElement("p");
    p.className = "markdown-asset-placeholder";
    p.textContent = "عنصر صورة من نتيجة OCR: " + ((match && match[1]) || "بدون وصف");
    return p;
  }

  function isTableStart(lines, index) {
    return isTableRow(lines[index]) && isTableSeparator(lines[index + 1] || "");
  }

  function isTableRow(line) {
    return typeof line === "string" && line.includes("|") && line.trim().length > 2;
  }

  function isTableSeparator(line) {
    return /^\s*\|?[\s:|-]+\|[\s:|-]*\s*$/.test(line || "");
  }

  function splitTableCells(line) {
    return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (cell) {
      return cell.trim();
    });
  }

  function renderTable(lines, index) {
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const tbody = document.createElement("tbody");
    const headerRow = document.createElement("tr");

    splitTableCells(lines[index]).forEach(function (cell) {
      const th = document.createElement("th");
      appendInline(th, cell);
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);

    let cursor = index + 2;
    while (cursor < lines.length && isTableRow(lines[cursor])) {
      const row = document.createElement("tr");
      splitTableCells(lines[cursor]).forEach(function (cell) {
        const td = document.createElement("td");
        appendInline(td, cell);
        row.appendChild(td);
      });
      tbody.appendChild(row);
      cursor += 1;
    }

    table.appendChild(thead);
    table.appendChild(tbody);
    return { table: table, nextIndex: cursor };
  }

  function renderList(lines, index) {
    const ordered = /^\s*\d+[.)]\s+/.test(lines[index]);
    const list = document.createElement(ordered ? "ol" : "ul");
    let cursor = index;
    const pattern = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;

    while (cursor < lines.length && pattern.test(lines[cursor])) {
      const li = document.createElement("li");
      appendInline(li, lines[cursor].replace(pattern, "").trim());
      list.appendChild(li);
      cursor += 1;
    }

    return { list: list, nextIndex: cursor };
  }

  function execCmd(command, value) {
    document.execCommand(command, false, value || null);
    els.editorContent.focus();
    normalizeEditorLinks();
  }

  function addLink() {
    const url = window.prompt("أدخل الرابط:");
    if (!url) {
      return;
    }
    const safeUrl = sanitizeUrl(url);
    if (!safeUrl) {
      showToast("الرابط غير آمن. يسمح فقط بـ http و https و mailto.", "error");
      return;
    }
    execCmd("createLink", safeUrl);
  }

  function sanitizeUrl(url) {
    try {
      const parsed = new URL(url, window.location.href);
      if (["http:", "https:", "mailto:"].includes(parsed.protocol)) {
        return parsed.href;
      }
    } catch (error) {
      return "";
    }
    return "";
  }

  function normalizeEditorLinks() {
    els.editorContent.querySelectorAll("a").forEach(function (link) {
      const safeUrl = sanitizeUrl(link.getAttribute("href") || "");
      if (!safeUrl) {
        const text = document.createTextNode(link.textContent || "");
        link.replaceWith(text);
        return;
      }
      link.href = safeUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      Array.from(link.attributes).forEach(function (attr) {
        if (!["href", "target", "rel"].includes(attr.name)) {
          link.removeAttribute(attr.name);
        }
      });
    });
  }

  async function downloadText() {
    const text = els.editorContent.innerText;
    if (!text.trim()) {
      showToast("لا يوجد نص لتنزيله.", "error");
      return;
    }

    const name = (state.currentFile ? state.currentFile.name.replace(/\.[^.]+$/, "") : "ocr-result") + ".txt";
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });

    if (typeof window.showSaveFilePicker === "function") {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{
            description: "Text file",
            accept: { "text/plain": [".txt"] }
          }]
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        showToast("تم حفظ ملف النص.", "success");
        return;
      } catch (error) {
        if (error && error.name === "AbortError") {
          return;
        }
        // Fall through to the anchor download path for browsers without picker support.
      }
    }

    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = name;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    window.setTimeout(function () {
      URL.revokeObjectURL(objectUrl);
      a.remove();
    }, 1000);
    showToast("بدأ تنزيل الملف. إذا لم يظهر الملف داخل متصفح Codex، افتح التطبيق في Chrome أو Safari.", "info");
  }

  function printText() {
    normalizeEditorLinks();
    const content = serializeSafeNode(els.editorContent);
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      showToast("المتصفح منع نافذة الطباعة.", "error");
      return;
    }
    printWindow.document.write("<!doctype html><html lang=\"ar\" dir=\"auto\"><head><meta charset=\"utf-8\"><title>Print</title><link rel=\"stylesheet\" href=\"styles.css\"></head><body class=\"print-document\"><main class=\"editor-content\">" + content + "</main></body></html>");
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  }

  function serializeSafeNode(root) {
    const allowedTags = new Set([
      "A", "B", "BR", "CODE", "DIV", "EM", "H1", "H2", "H3", "H4", "H5", "H6",
      "HR", "I", "LI", "OL", "P", "PRE", "SPAN", "STRONG", "TABLE", "TBODY",
      "TD", "TH", "THEAD", "TR", "U", "UL"
    ]);

    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return escapeHtml(node.nodeValue || "");
      }
      if (node.nodeType !== Node.ELEMENT_NODE) {
        return "";
      }
      if (!allowedTags.has(node.tagName)) {
        return Array.from(node.childNodes).map(walk).join("");
      }

      const tag = node.tagName.toLowerCase();
      let attrs = "";
      if (node.tagName === "A") {
        const href = sanitizeUrl(node.getAttribute("href") || "");
        if (href) {
          attrs = " href=\"" + escapeHtml(href) + "\" rel=\"noopener noreferrer\" target=\"_blank\"";
        }
      }
      return "<" + tag + attrs + ">" + Array.from(node.childNodes).map(walk).join("") + "</" + tag + ">";
    }

    return Array.from(root.childNodes).map(walk).join("");
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function saveToRecent(name, data) {
    const scan = {
      name: String(name || "untitled").slice(0, 180),
      date: new Date().toLocaleDateString(),
      pages: Array.isArray(data.pages) ? data.pages.length : 0
    };

    state.recentScans.unshift(scan);
    state.recentScans = state.recentScans.slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(state.recentScans));
    renderRecentScans();
  }

  function renderRecentScans() {
    els.scanList.replaceChildren();

    if (!state.recentScans.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "لا توجد ملفات حديثة.";
      els.scanList.appendChild(empty);
      return;
    }

    state.recentScans.forEach(function (scan) {
      const item = document.createElement("div");
      item.className = "scan-item";

      const icon = document.createElement("span");
      icon.className = "scan-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.appendChild(createFileIcon());

      const info = document.createElement("div");
      info.className = "scan-info";

      const name = document.createElement("div");
      name.className = "name";
      name.textContent = scan.name;

      const date = document.createElement("div");
      date.className = "date";
      date.textContent = scan.date + " · " + scan.pages + " صفحة";

      info.appendChild(name);
      info.appendChild(date);
      item.appendChild(icon);
      item.appendChild(info);
      els.scanList.appendChild(item);
    });
  }

  function createFileIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    [
      ["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" }],
      ["path", { d: "M14 2v6h6" }],
      ["path", { d: "M8 13h8" }],
      ["path", { d: "M8 17h6" }]
    ].forEach(function (entry) {
      const node = document.createElementNS("http://www.w3.org/2000/svg", entry[0]);
      Object.keys(entry[1]).forEach(function (key) {
        node.setAttribute(key, entry[1][key]);
      });
      svg.appendChild(node);
    });
    return svg;
  }

  function clearRecentScans() {
    state.recentScans = [];
    localStorage.removeItem(RECENT_KEY);
    renderRecentScans();
    showToast("تم مسح السجل المحلي.", "success");
  }

  function loadRecentScans() {
    try {
      const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.slice(0, MAX_RECENT).map(function (scan) {
        return {
          name: String(scan.name || "untitled").slice(0, 180),
          date: String(scan.date || ""),
          pages: Number.isFinite(Number(scan.pages)) ? Number(scan.pages) : 0
        };
      });
    } catch (error) {
      return [];
    }
  }

  function showToast(message, type) {
    const toast = document.createElement("div");
    toast.className = "toast " + (type || "info");
    toast.textContent = message;
    els.toastContainer.appendChild(toast);
    window.setTimeout(function () {
      toast.remove();
    }, 4800);
  }

  function revokeImageUrl() {
    if (state.currentImageUrl) {
      URL.revokeObjectURL(state.currentImageUrl);
      state.currentImageUrl = "";
    }
  }

  window.addEventListener("beforeunload", revokeImageUrl);

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("./sw.js").catch(function () {
        // The app still works without the offline shell.
      });
    });
  }
})();
