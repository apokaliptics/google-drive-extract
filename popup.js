const panel = document.querySelector(".panel");
const extractBtn = document.getElementById("extractBtn");
const statusLabel = document.getElementById("statusLabel");
const statusDetail = document.getElementById("statusDetail");
const progressFill = document.getElementById("progressFill");
const hintText = document.getElementById("hintText");

const DRIVE_VIEW_URL = /^https:\/\/drive\.google\.com\/file\/d\/[^/]+\/view/i;

let activeTabId = null;
let pollTimer = null;

function setUiState({
  state = "idle",
  message = "Ready",
  detail = "",
  progress = 0,
  canExtract = false,
}) {
  panel.dataset.state = state;
  statusLabel.textContent = message;
  statusDetail.textContent = detail;
  progressFill.style.width = `${Math.max(0, Math.min(100, progress))}%`;
  extractBtn.disabled = !canExtract || state === "running";

  if (state === "running") {
    extractBtn.textContent = "Running...";
    hintText.textContent = "Keep the Drive tab active while scanning and downloading.";
    return;
  }

  extractBtn.textContent = "Extract";
  hintText.textContent = "Keep the Drive tab open while extraction runs.";
}

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function isDrivePdfTab(tab) {
  return Boolean(tab && tab.url && DRIVE_VIEW_URL.test(tab.url));
}

function applyExtractorStatus(status, canExtract) {
  if (!status) {
    setUiState({
      state: "idle",
      message: "Ready",
      detail: "Open a Google Drive PDF in this tab, then press Extract.",
      progress: 0,
      canExtract,
    });
    return;
  }

  setUiState({
    state: status.state || "idle",
    message: status.message || "Ready",
    detail: status.detail || "",
    progress: Number(status.progress || 0),
    canExtract,
  });
}

async function refreshStatus() {
  const activeTab = await getActiveTab();

  if (!activeTab || typeof activeTab.id !== "number") {
    activeTabId = null;
    setUiState({
      state: "error",
      message: "No active tab",
      detail: "Open a Google Drive PDF tab and reopen this popup.",
      progress: 0,
      canExtract: false,
    });
    return;
  }

  activeTabId = activeTab.id;

  if (!isDrivePdfTab(activeTab)) {
    setUiState({
      state: "idle",
      message: "Open Drive PDF",
      detail: "Switch to a Google Drive file preview URL (/file/d/.../view).",
      progress: 0,
      canExtract: false,
    });
    return;
  }

  try {
    const response = await sendToTab(activeTabId, {
      type: "DRIVE_PDF_EXTRACT_STATUS",
    });
    applyExtractorStatus(response?.status, true);
  } catch (_error) {
    setUiState({
      state: "error",
      message: "Cannot reach page",
      detail: "Reload the Drive tab once so the content script can initialize.",
      progress: 0,
      canExtract: false,
    });
  }
}

async function startExtraction() {
  if (typeof activeTabId !== "number") {
    await refreshStatus();
    return;
  }

  setUiState({
    state: "running",
    message: "Starting extraction",
    detail: "Sending command to Drive tab...",
    progress: 5,
    canExtract: true,
  });

  try {
    const response = await sendToTab(activeTabId, {
      type: "DRIVE_PDF_EXTRACT_START",
    });

    if (!response?.ok) {
      throw new Error("Failed to start extraction.");
    }

    applyExtractorStatus(response.status, true);
  } catch (_error) {
    setUiState({
      state: "error",
      message: "Start failed",
      detail: "Make sure a Google Drive PDF preview is open, then try again.",
      progress: 0,
      canExtract: true,
    });
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    refreshStatus().catch(() => {
      // UI already handles failures.
    });
  }, 1200);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "DRIVE_PDF_EXTRACT_STATUS_CHANGED") return;
  applyExtractorStatus(message.status, true);
});

extractBtn.addEventListener("click", () => {
  startExtraction().catch(() => {
    // startExtraction handles failures.
  });
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    refreshStatus().catch(() => {
      // refreshStatus handles failures.
    });
    startPolling();
    return;
  }
  stopPolling();
});

window.addEventListener("unload", stopPolling);

refreshStatus().catch(() => {
  // refreshStatus handles failures.
});
startPolling();
