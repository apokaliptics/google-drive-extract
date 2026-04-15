// ============================================================
// Drive PDF Extractor — Content Script
// Downloads restricted Google Drive PDFs via canvas capture.
// ============================================================

(function () {
  "use strict";

  // ── Trusted Types Policy ────────────────────────────────────
  // Google Drive enforces Trusted Types. We create a permissive
  // policy so we can inject the jsPDF <script> tag safely.
  if (window.trustedTypes && window.trustedTypes.createPolicy) {
    try {
      window.trustedTypes.createPolicy("default", {
        createHTML: (s) => s,
        createScript: (s) => s,
        createScriptURL: (s) => s,
      });
    } catch (_) {
      // Policy may already exist — that's fine.
    }
  }

  // ── Constants ───────────────────────────────────────────────
  const JSPDF_CDN =
    "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
  const SCROLL_STEP = 500; // px per tick
  const SCROLL_INTERVAL = 300; // ms between ticks
  const STABLE_WAIT = 2000; // ms to confirm no new images
  const MAX_WAIT = 120000; // safety timeout (2 min)

  // ── State ───────────────────────────────────────────────────
  let isRunning = false;

  // ── Helpers ─────────────────────────────────────────────────

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
      padding: "14px 28px",
      border: "none",
      borderRadius: "12px",
      background: "linear-gradient(135deg, #4285F4, #34A853)",
      color: "#fff",
      fontSize: "15px",
      fontWeight: "700",
      fontFamily:
        "'Google Sans', 'Segoe UI', system-ui, -apple-system, sans-serif",
      cursor: "pointer",
      boxShadow:
        "0 4px 20px rgba(66,133,244,.45), 0 1px 4px rgba(0,0,0,.18)",
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
        "0 8px 30px rgba(66,133,244,.55), 0 2px 8px rgba(0,0,0,.22)";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.transform = "translateY(0) scale(1)";
      btn.style.boxShadow =
        "0 4px 20px rgba(66,133,244,.45), 0 1px 4px rgba(0,0,0,.18)";
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
      background: "rgba(0,0,0,.72)",
      backdropFilter: "blur(6px)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily:
        "'Google Sans', 'Segoe UI', system-ui, -apple-system, sans-serif",
    });

    const card = document.createElement("div");
    Object.assign(card.style, {
      background: "#1e1e2e",
      borderRadius: "20px",
      padding: "40px 48px",
      minWidth: "380px",
      maxWidth: "460px",
      textAlign: "center",
      boxShadow: "0 24px 80px rgba(0,0,0,.5)",
      color: "#e0e0e0",
    });

    card.innerHTML = `
      <div style="margin-bottom:20px;">
        <svg width="48" height="48" viewBox="0 0 48 48" style="animation:spin 1.2s linear infinite;">
          <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
          <circle cx="24" cy="24" r="20" fill="none" stroke="#4285F4" stroke-width="4"
                  stroke-dasharray="90 150" stroke-linecap="round"/>
        </svg>
      </div>
      <div id="dpx-status" style="font-size:17px;font-weight:600;margin-bottom:8px;color:#fff;">
        Preparing…
      </div>
      <div id="dpx-detail" style="font-size:13px;color:#aaa;line-height:1.5;">
        Initialising auto‑scroll
      </div>
      <div style="margin-top:24px;width:100%;height:6px;border-radius:4px;background:#333;overflow:hidden;">
        <div id="dpx-bar" style="height:100%;width:0%;border-radius:4px;
             background:linear-gradient(90deg,#4285F4,#34A853);transition:width .4s ease;"></div>
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
    if (isRunning) return;
    isRunning = true;

    const btn = document.getElementById("drive-pdf-extractor-btn");
    btn.style.pointerEvents = "none";
    btn.style.opacity = "0.5";

    const ui = createOverlay();

    try {
      // 1. Auto‑scroll to load all lazy pages ─────────────────
      ui.setStatus("Scrolling to load all pages…");
      await autoScroll(ui);

      // 2. Load jsPDF ──────────────────────────────────────────
      ui.setStatus("Loading PDF library…");
      ui.setDetail("Fetching jsPDF from CDN");
      ui.setProgress(50);
      await loadJsPDF();

      // 3. Generate PDF ────────────────────────────────────────
      ui.setStatus("Generating PDF…");
      const images = collectBlobImages();
      ui.setDetail(`Found ${images.length} page(s)`);

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

        ui.setDetail(`Rendering page ${i + 1} / ${images.length}`);
        ui.setProgress(50 + Math.round((i / images.length) * 48));

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
      pdf.save(filename + ".pdf");

      // Done
      ui.setStatus("✅ Download complete!");
      ui.setDetail(`${images.length} pages saved as "${filename}.pdf"`);
      setTimeout(() => ui.remove(), 2500);
    } catch (err) {
      console.error("[Drive PDF Extractor]", err);
      ui.setStatus("❌ Error");
      ui.setDetail(err.message || String(err));
      setTimeout(() => ui.remove(), 5000);
    } finally {
      isRunning = false;
      btn.style.pointerEvents = "";
      btn.style.opacity = "";
    }
  }

  /** Scrolls the viewer to the bottom, waiting for lazy images. */
  function autoScroll(ui) {
    return new Promise((resolve, reject) => {
      const container = findScrollContainer();
      let lastImgCount = 0;
      let stableTime = 0;
      let elapsed = 0;

      const timer = setInterval(() => {
        elapsed += SCROLL_INTERVAL;

        // Safety timeout
        if (elapsed > MAX_WAIT) {
          clearInterval(timer);
          resolve(); // proceed with whatever we have
          return;
        }

        // Scroll down
        container.scrollTop += SCROLL_STEP;

        const currentCount = collectBlobImages().length;
        ui.setDetail(`${currentCount} page(s) detected — scrolling…`);
        ui.setProgress(Math.min(45, Math.round((elapsed / MAX_WAIT) * 45)));

        const atBottom =
          container.scrollTop + container.clientHeight >=
          container.scrollHeight - 10;

        if (atBottom) {
          // We've reached the bottom; wait for stability
          if (currentCount === lastImgCount) {
            stableTime += SCROLL_INTERVAL;
          } else {
            stableTime = 0;
          }

          if (stableTime >= STABLE_WAIT) {
            clearInterval(timer);
            resolve();
            return;
          }
        }

        lastImgCount = currentCount;
      }, SCROLL_INTERVAL);
    });
  }

  /** Dynamically load jsPDF if not already present. */
  function loadJsPDF() {
    return new Promise((resolve, reject) => {
      if (window.jspdf) {
        resolve();
        return;
      }

      const script = document.createElement("script");
      script.src = JSPDF_CDN;
      script.onload = () => resolve();
      script.onerror = () =>
        reject(new Error("Failed to load jsPDF from CDN."));
      document.head.appendChild(script);
    });
  }

  // ── Init ────────────────────────────────────────────────────
  // Wait a moment for the Drive UI to settle, then inject.
  setTimeout(injectButton, 1500);
})();
