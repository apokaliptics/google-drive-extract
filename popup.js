const panel = document.querySelector(".panel");
const extractBtn = document.getElementById("extractBtn");
const statusLabel = document.getElementById("statusLabel");
const statusDetail = document.getElementById("statusDetail");
const progressFill = document.getElementById("progressFill");
const hintText = document.getElementById("hintText");

const DRIVE_VIEW_URL = /^https:\/\/drive\.google\.com\/file\/d\/[^/]+\/view/i;
const DRIVE_TAB_URL_PATTERN = "https://drive.google.com/file/d/*/view*";

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
    hintText.textContent =
      "Extraction keeps running if you switch tabs. Reopen this popup to monitor page count and progress.";
    return;
  }

  extractBtn.textContent = "Extract";
  hintText.textContent = canExtract
    ? "You can start on a Drive tab and switch away while scanning continues."
    : "Open a Google Drive PDF tab to begin extraction.";
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

function queryTabs(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(Array.isArray(tabs) ? tabs : []);
    });
  });
}

async function getActiveTab() {
  const tabs = await queryTabs({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function isDrivePdfTab(tab) {
  return Boolean(tab && tab.url && DRIVE_VIEW_URL.test(tab.url));
}

function withBackgroundContext(status, isBackgroundTab) {
  if (!status || !isBackgroundTab || status.state !== "running") {
    return status;
  }

  const baseDetail = status.detail ? `${status.detail} ` : "";
  return {
    ...status,
    detail: `${baseDetail}(continuing in another tab)`,
  };
}

function applyExtractorStatus(status, canExtract) {
  if (!status) {
    setUiState({
      state: "idle",
      message: "Ready",
      detail: "Open a Google Drive PDF tab, then press Extract.",
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

async function getExtractorStatusForTab(tab) {
  if (!tab || typeof tab.id !== "number") {
    return null;
  }

  try {
    const response = await sendToTab(tab.id, {
      type: "DRIVE_PDF_EXTRACT_STATUS",
    });

    if (!response?.ok) {
      return null;
    }

    return response.status || null;
  } catch (_error) {
    return null;
  }
}

async function resolveTargetTab() {
  const activeTab = await getActiveTab();
  const seen = new Set();
  const candidates = [];

  const pushCandidate = (tab) => {
    if (!isDrivePdfTab(tab) || typeof tab.id !== "number") {
      return;
    }
    if (seen.has(tab.id)) {
      return;
    }
    seen.add(tab.id);
    candidates.push(tab);
  };

  pushCandidate(activeTab);

  try {
    const driveTabs = await queryTabs({ url: [DRIVE_TAB_URL_PATTERN] });
    driveTabs.forEach(pushCandidate);
  } catch (_error) {
    // Fall back to whatever we already have.
  }

  if (candidates.length === 0) {
    return { activeTab, targetTab: null, status: null };
  }

  let runningMatch = null;
  let activeMatch = null;
  let fallbackMatch = null;

  for (const tab of candidates) {
    const status = await getExtractorStatusForTab(tab);
    if (!status) {
      continue;
    }

    if (!fallbackMatch) {
      fallbackMatch = { tab, status };
    }

    if (activeTab && tab.id === activeTab.id) {
      activeMatch = { tab, status };
    }

    if (status.state === "running") {
      runningMatch = { tab, status };
      break;
    }
  }

  const bestMatch = runningMatch || activeMatch || fallbackMatch;
  if (bestMatch) {
    return {
      activeTab,
      targetTab: bestMatch.tab,
      status: bestMatch.status,
    };
  }

  // We found Drive tabs, but content scripts may not be reachable yet.
  return {
    activeTab,
    targetTab: candidates[0],
    status: null,
  };
}

async function refreshStatus() {
  const context = await resolveTargetTab();
  if (!context.targetTab || typeof context.targetTab.id !== "number") {
    activeTabId = null;
    setUiState({
      state: "idle",
      message: "Open Drive PDF",
      detail: "Switch to a Google Drive file preview URL (/file/d/.../view).",
      progress: 0,
      canExtract: false,
    });
    return;
  }

  activeTabId = context.targetTab.id;

  if (!context.status) {
    setUiState({
      state: "error",
      message: "Cannot reach page",
      detail: "Open the Drive PDF tab and reload it once so extraction can initialize.",
      progress: 0,
      canExtract: false,
    });
    return;
  }

  const isBackgroundTab =
    !context.activeTab || context.activeTab.id !== context.targetTab.id;
  applyExtractorStatus(withBackgroundContext(context.status, isBackgroundTab), true);
}

async function startExtraction() {
  if (typeof activeTabId !== "number") {
    await refreshStatus();
  }

  if (typeof activeTabId !== "number") {
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
      detail: "Open the Drive PDF tab once and try again.",
      progress: 0,
      canExtract: false,
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

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "DRIVE_PDF_EXTRACT_STATUS_CHANGED") return;
  if (typeof sender?.tab?.id === "number") {
    activeTabId = sender.tab.id;
  }
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
