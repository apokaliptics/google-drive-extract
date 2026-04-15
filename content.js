// ============================================================
// Drive PDF Extractor — Content Script
// Downloads restricted Google Drive PDFs via canvas capture.
// ============================================================

(function () {
  "use strict";

  // ── Constants ───────────────────────────────────────────────
  const SCROLL_STEP = 500; // px per tick
  const SCROLL_INTERVAL = 300; // ms between ticks
  const BACKGROUND_SCROLL_STEP = 1600; // larger jumps while hidden
  const BACKGROUND_SCROLL_INTERVAL = 1000; // slower cadence while hidden
  const STABLE_WAIT = 2000; // ms to confirm no new images
  const BACKGROUND_STABLE_WAIT = 5000; // hidden tabs need a longer settle time
  const MAX_WAIT = 300000; // safety timeout (5 min)

  // ── State ───────────────────────────────────────────────────
  let isRunning = false;
  const extractionStatus = {
    state: "idle",
    message: "Ready to extract",
    detail: "Open a Google Drive PDF and press Extract.",
    progress: 0,
    pagesFound: 0,
    updatedAt: Date.now(),
  };

  // ── Helpers ─────────────────────────────────────────────────

  function getExtractionStatus() {
    return { ...extractionStatus };
  }

  function broadcastExtractionStatus() {
    if (!chrome?.runtime?.sendMessage) return;
    try {
      chrome.runtime.sendMessage({
        type: "DRIVE_PDF_EXTRACT_STATUS_CHANGED",
        status: getExtractionStatus(),
      });
    } catch (_) {
      // Ignore when no extension context is listening.
    }
  }

  function updateExtractionStatus(next) {
    Object.assign(extractionStatus, next, { updatedAt: Date.now() });
    broadcastExtractionStatus();
  }

  /** Extract a clean filename from the Drive UI or <title>. */
  function getFilename() {
    // Primary: the visible title in the Drive toolbar
    const selectors = [
      '[data-tooltip-unhoverable="true"]', // common tooltip‐title element
      ".uc-name-size a",
      '[role="heading"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) {
        return sanitize(el.textContent.trim());
      }
    }
    // Fallback: page title (strip " - Google Drive" suffix)
    let title = document.title.replace(/\s*-\s*Google Drive\s*$/i, "").trim();
    return sanitize(title || "drive-download");
  }

  function sanitize(name) {
    // Remove extension if present, we append .pdf ourselves
    name = name.replace(/\.pdf$/i, "");
    // Replace filesystem‐unsafe chars
    return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "drive-download";
  }

  /** Collect all <img> elements whose src starts with "blob:". */
  function collectBlobImages() {
    return Array.from(document.querySelectorAll("img"))
      .filter((img) => /^blob:/i.test(img.src))
      .filter((img) => img.naturalWidth > 0 && img.naturalHeight > 0);
  }

  /** Find the main scrollable container that holds the PDF pages. */
  function findScrollContainer() {
    // Strategy 1: look for the element that actually scrolls
    // and contains blob images.
    const candidates = document.querySelectorAll("*");
    for (const el of candidates) {
      const style = window.getComputedStyle(el);
      if (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        el.scrollHeight > el.clientHeight + 200 &&
        el.querySelector('img[src^="blob:"]')
      ) {
        return el;
      }
    }
    // Strategy 2: role="document" wrapper
    const doc = document.querySelector('[role="document"]');
    if (doc && doc.scrollHeight > doc.clientHeight) return doc;

    // Strategy 3: a common Drive viewer class
    const viewer = document.querySelector(".a-b-r-La");
    if (viewer) return viewer;

    // Fallback
    return document.scrollingElement || document.documentElement;
  }

  // ── UI ──────────────────────────────────────────────────────

  function injectButton() {
    if (document.getElementById("drive-pdf-extractor-btn")) return;

    const btn = document.createElement("button");
    btn.id = "drive-pdf-extractor-btn";
    btn.textContent = "⬇ Download Full PDF";

    Object.assign(btn.style, {
      position: "fixed",
      bottom: "28px",
      right: "28px",
      zIndex: "999999",
      padding: "13px 24px",
      border: "1px solid #d8e2ef",
      borderRadius: "14px",
      background: "linear-gradient(180deg, #ffffff, #f4f8ff)",
      color: "#1b2b44",
      fontSize: "15px",
      fontWeight: "700",
      fontFamily:
        "'Google Sans', 'Segoe UI', system-ui, -apple-system, sans-serif",
      cursor: "pointer",
      boxShadow:
        "0 18px 34px -24px rgba(40,76,121,.56), 0 2px 8px rgba(23,45,74,.12)",
      transition: "all .25s cubic-bezier(.4,0,.2,1)",
      letterSpacing: ".3px",
      userSelect: "none",
      display: "flex",
      alignItems: "center",
      gap: "8px",
    });

    btn.addEventListener("mouseenter", () => {
      btn.style.transform = "translateY(-2px) scale(1.03)";
      btn.style.boxShadow =
        "0 20px 40px -24px rgba(40,76,121,.68), 0 4px 10px rgba(23,45,74,.18)";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.transform = "translateY(0) scale(1)";
      btn.style.boxShadow =
        "0 18px 34px -24px rgba(40,76,121,.56), 0 2px 8px rgba(23,45,74,.12)";
    });

    btn.addEventListener("click", startExtraction);
    document.body.appendChild(btn);
  }

  // ── Progress Overlay ────────────────────────────────────────

  function createOverlay() {
    const overlay = document.createElement("div");
    overlay.id = "drive-pdf-overlay";
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      zIndex: "1000000",
      background: "rgba(243, 248, 255, .76)",
      backdropFilter: "blur(8px)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily:
        "'Google Sans', 'Segoe UI', system-ui, -apple-system, sans-serif",
    });

    const card = document.createElement("div");
    Object.assign(card.style, {
      background: "linear-gradient(180deg, #ffffff 0%, #f7faff 100%)",
      borderRadius: "20px",
      padding: "40px 48px",
      minWidth: "380px",
      maxWidth: "460px",
      textAlign: "center",
      border: "1px solid #dbe4f1",
      boxShadow: "0 34px 78px -34px rgba(31, 62, 103, .5)",
      color: "#1b2b44",
    });

    card.innerHTML = `
      <div style="margin-bottom:20px;">
        <svg width="48" height="48" viewBox="0 0 48 48" style="animation:spin 1.2s linear infinite;">
          <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
          <circle cx="24" cy="24" r="20" fill="none" stroke="#2f6fec" stroke-width="4"
                  stroke-dasharray="90 150" stroke-linecap="round"/>
        </svg>
      </div>
      <div id="dpx-status" style="font-size:17px;font-weight:700;margin-bottom:8px;color:#12213a;">
        Preparing…
      </div>
      <div id="dpx-detail" style="font-size:13px;color:#60728b;line-height:1.5;">
        Initialising auto‑scroll
      </div>
      <div style="margin-top:24px;width:100%;height:6px;border-radius:4px;background:#e8eef8;overflow:hidden;">
        <div id="dpx-bar" style="height:100%;width:0%;border-radius:4px;
             background:linear-gradient(90deg,#2f6fec,#63a2ff);transition:width .4s ease;"></div>
      </div>
    `;
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    return {
      setStatus: (t) => (document.getElementById("dpx-status").textContent = t),
      setDetail: (t) => (document.getElementById("dpx-detail").textContent = t),
      setProgress: (p) =>
        (document.getElementById("dpx-bar").style.width = `${p}%`),
      remove: () => overlay.remove(),
    };
  }

  // ── Core Logic ──────────────────────────────────────────────

  async function startExtraction() {
    if (isRunning) {
      updateExtractionStatus({
        state: "running",
        message: "Extraction already running",
      });
      return;
    }
    isRunning = true;
    updateExtractionStatus({
      state: "running",
      message: "Starting extraction",
      detail: "Preparing document scan",
      progress: 2,
      pagesFound: 0,
    });

    const btn = document.getElementById("drive-pdf-extractor-btn");
    if (btn) {
      btn.style.pointerEvents = "none";
      btn.style.opacity = "0.5";
    }

    const ui = createOverlay();

    try {
      // 1. Auto‑scroll to load all lazy pages ─────────────────
      ui.setStatus("Scrolling to load all pages…");
      updateExtractionStatus({
        state: "running",
        message: "Scanning pages",
        detail: "Auto-scrolling to trigger lazy loading",
        progress: 10,
      });
      await autoScroll(ui);

      // 2. Load jsPDF ──────────────────────────────────────────
      ui.setStatus("Loading PDF library…");
      ui.setDetail("Initializing bundled jsPDF library");
      ui.setProgress(50);
      updateExtractionStatus({
        state: "running",
        message: "Preparing PDF generator",
        detail: "Initializing bundled jsPDF",
        progress: 50,
      });
      await loadJsPDF();

      // 3. Generate PDF ────────────────────────────────────────
      ui.setStatus("Generating PDF…");
      const images = collectBlobImages();
      ui.setDetail(`Found ${images.length} page(s)`);
      updateExtractionStatus({
        state: "running",
        message: "Building PDF",
        detail: `Found ${images.length} page(s)`,
        pagesFound: images.length,
        progress: 55,
      });

      if (images.length === 0) {
        throw new Error(
          "No PDF page images found. Please make sure the document is fully loaded."
        );
      }

      const { jsPDF } = window.jspdf;

      // Use first image dimensions to set the page size
      const firstImg = images[0];
      const pageW = firstImg.naturalWidth;
      const pageH = firstImg.naturalHeight;

      const pdf = new jsPDF({
        orientation: pageW > pageH ? "landscape" : "portrait",
        unit: "px",
        format: [pageW, pageH],
        compress: true,
      });

      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const progress = 50 + Math.round(((i + 1) / images.length) * 48);

        ui.setDetail(`Rendering page ${i + 1} / ${images.length}`);
        ui.setProgress(progress);
        updateExtractionStatus({
          state: "running",
          message: "Building PDF",
          detail: `Rendering page ${i + 1} / ${images.length}`,
          pagesFound: images.length,
          progress,
        });

        // Draw to offscreen canvas
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);

        const imgData = canvas.toDataURL("image/jpeg", 0.95);

        if (i > 0) {
          pdf.addPage([w, h], w > h ? "landscape" : "portrait");
        }

        pdf.addImage(imgData, "JPEG", 0, 0, w, h);
      }

      // 4. Save ────────────────────────────────────────────────
      const filename = getFilename();
      ui.setStatus("Saving…");
      ui.setDetail(filename + ".pdf");
      ui.setProgress(100);
      updateExtractionStatus({
        state: "running",
        message: "Saving download",
        detail: filename + ".pdf",
        pagesFound: images.length,
        progress: 100,
      });
      pdf.save(filename + ".pdf");

      // Done
      ui.setStatus("✅ Download complete!");
      ui.setDetail(`${images.length} pages saved as "${filename}.pdf"`);
      updateExtractionStatus({
        state: "success",
        message: "Download complete",
        detail: `${images.length} pages saved as "${filename}.pdf"`,
        pagesFound: images.length,
        progress: 100,
      });
      setTimeout(() => ui.remove(), 2500);
    } catch (err) {
      console.error("[Drive PDF Extractor]", err);
      ui.setStatus("❌ Error");
      ui.setDetail(err.message || String(err));
      updateExtractionStatus({
        state: "error",
        message: "Extraction failed",
        detail: err.message || String(err),
      });
      setTimeout(() => ui.remove(), 5000);
    } finally {
      isRunning = false;
      if (btn) {
        btn.style.pointerEvents = "";
        btn.style.opacity = "";
      }
    }
  }

  /** Scrolls the viewer to the bottom, waiting for lazy images. */
  function autoScroll(ui) {
    return new Promise((resolve) => {
      let container = findScrollContainer();
      let lastImgCount = 0;
      let stableTime = 0;
      let elapsed = 0;

      const tick = () => {
        const isHidden = document.visibilityState === "hidden";
        const step = isHidden ? BACKGROUND_SCROLL_STEP : SCROLL_STEP;
        const interval = isHidden ? BACKGROUND_SCROLL_INTERVAL : SCROLL_INTERVAL;
        const settleWait = isHidden ? BACKGROUND_STABLE_WAIT : STABLE_WAIT;

        elapsed += interval;

        // Safety timeout
        if (elapsed > MAX_WAIT) {
          resolve(); // proceed with whatever we have
          return;
        }

        // Drive can swap viewer nodes, so reacquire when needed.
        if (!container || !container.isConnected) {
          container = findScrollContainer();
        }

        // Scroll down
        container.scrollTop += step;

        const currentCount = collectBlobImages().length;
        const modeSuffix = isHidden ? " - background" : "";
        ui.setDetail(`${currentCount} page(s) detected - scanning${modeSuffix}`);
        const progress = Math.min(45, Math.round((elapsed / MAX_WAIT) * 45));
        ui.setProgress(progress);
        updateExtractionStatus({
          state: "running",
          message: "Scanning pages",
          detail: `${currentCount} page(s) detected - scanning${modeSuffix}`,
          pagesFound: currentCount,
          progress,
        });

        const atBottom =
          container.scrollTop + container.clientHeight >=
          container.scrollHeight - 10;

        if (atBottom) {
          // We've reached the bottom; wait for stability.
          if (currentCount === lastImgCount) {
            stableTime += interval;
          } else {
            stableTime = 0;
          }

          if (stableTime >= settleWait) {
            resolve();
            return;
          }
        }

        lastImgCount = currentCount;
        setTimeout(tick, interval);
      };

      tick();
    });
  }

  /** Ensure bundled jsPDF is available in this content script context. */
  function loadJsPDF() {
    return new Promise((resolve, reject) => {
      if (window.jspdf?.jsPDF) {
        resolve();
        return;
      }

      reject(
        new Error(
          "Bundled jsPDF is not available. Reload the extension and refresh this Drive tab."
        )
      );
    });
  }

  // ── Runtime Messaging ───────────────────────────────────────

  if (chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || typeof message !== "object") return;

      if (message.type === "DRIVE_PDF_EXTRACT_START") {
        if (!isRunning) {
          startExtraction();
        }
        sendResponse({
          ok: true,
          status: getExtractionStatus(),
        });
        return;
      }

      if (message.type === "DRIVE_PDF_EXTRACT_STATUS") {
        sendResponse({
          ok: true,
          status: getExtractionStatus(),
        });
      }
    });
  }

  // ── Init ────────────────────────────────────────────────────
  // Wait a moment for the Drive UI to settle, then inject.
  setTimeout(injectButton, 1500);
  broadcastExtractionStatus();
})();
