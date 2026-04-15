# 🚀 Google Drive PDF Extractor

[![Version](https://img.shields.io/badge/version-1.1.0-blue.svg?style=for-the-badge)](https://github.com/apokaliptics/google-drive-extract)
[![Manifest](https://img.shields.io/badge/Manifest-V3-green.svg?style=for-the-badge)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![License](https://img.shields.io/badge/license-MIT-orange.svg?style=for-the-badge)](LICENSE)

A high-performance Chrome Extension designed to bypass viewing restrictions on Google Drive PDF files. It programmatically captures documents by reconstructing them from their high-resolution lazy-loaded image buffers.

---

## ✨ Key Features

-   **🔄 Intelligent Auto-Scroll** — Deep-scans the document viewer to force Google Drive to lazy-load every high-resolution page buffer.
-   **🎯 Precision Page Detection** — Real-time monitoring of `blob:` image sources ensuring no page is skipped or duplicated.
-   **💎 Lossless Reconstruction** — Captures each page at its native pixel resolution using an off-screen canvas rendering engine.
-   **🏷️ Automatic Metadata** — Intelligently extracts the original document title from Google Drive's internal DOM.
-   **🛰️ Enhanced Progress UI** — Modern, glassmorphic overlay with real-time status updates and a synchronized progress bar.
-   **🔐 Security Compliant** — Implements a custom **Trusted Types** policy to operate within Google's strict Content Security Policy (CSP).

---

## 🛠️ Installation

1.  **Clone or Download** this repository to your local machine.
2.  Open Google Chrome and navigate to `chrome://extensions/`.
3.  Enable **Developer mode** (toggle in the top-right corner).
4.  Click the **Load unpacked** button.
5.  Select the `google-drive-extract` folder.

---

## 📖 Usage Guide

1.  Navigate to any "View-Only" or restricted Google Drive PDF (`/file/d/.../view`).
2.  Click the extension icon in Chrome and press **Extract**.
3.  **Hands-off:** The extension will automatically scan, scroll, render, and save the file.
4.  Keep the Drive tab open until the status shows completion.

> [!TIP]
> The in-page floating button is still available as a fallback entry point.

> [!NOTE]
> For large documents (100+ pages), keep the Drive tab open. You can switch to other tabs while auto-scroll continues.

---

## 🏗️ Technical Architecture

| Feature | Specification |
| :--- | :--- |
| **Engine** | JavaScript (Vanilla) + jsPDF Core |
| **Runtime** | Manifest V3 Content Script |
| **Capture Method** | HTML5 Canvas Draw (JPEG @ 95%) |
| **Bypass Logic** | DOM Traversal + Lazy-Load Triggering |
| **Timeout Logic** | 120s Global Stability Watchdog |

---

## ⚠️ Disclaimer

This tool is intended for personal backup and educational purposes only. Users must comply with their local copyright laws and Google's Terms of Service. Always ensure you have the right to access the content you are downloading.

---

<p align="center">
  Developed with ❤️ for <em>Efficient Data Extraction</em>
</p>