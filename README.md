# copilot-for-linux

## Overview

copilot-for-linux is an unofficial Electron-based desktop wrapper for Microsoft Copilot that provides a first‑class Linux desktop experience. It wraps the Microsoft 365 Copilot web app and adds powerful native features such as multi‑window Quick Chats, advanced find‑in‑page, a profile‑based export system, persistent window state, user configuration, dual‑channel logging, and tray integration.

The project is designed for power users who want tighter desktop integration, better content handling, and high‑fidelity exports compared to using Copilot in a browser.

---

## Key Features

### Core Application

- **Electron Desktop App** – Runs Microsoft Copilot as a standalone Linux desktop application.
- **Persistent Session** – Uses a persistent Electron partition so you stay signed in across restarts.
- **Tray Integration** – Tray icon with Show/Hide, Quick Chat controls, reload, session/cache management, logs, config access, and quit options.
- **Persistent Window State** – Remembers size and position for the main window and Quick Chat windows.
- **Always‑on‑Top Support** – Toggle per window.
- **User Configuration** – All major features configurable via `config.json` (auto‑created on first run). See [Configuration](#configuration).

### Quick Chat System

- **Multiple Quick Chat Windows** – Open, manage, rename, pin, and close multiple Quick Chats.
- **Send Selection to Quick Chat** – Send highlighted text directly into a Quick Chat:
  - Plain
  - Quoted
  - Auto‑submit
- **Targeted Sending** – Send content to a specific Quick Chat window or choose interactively.
- **Clipboard‑Safe Injection** – Works reliably even with iframe‑based editors.

### Find‑in‑Page (Enhanced)

- **Custom Find Modal** – `Ctrl+F` opens a native Find interface.
- **Match Case, Next/Previous** – With live result counts.
- **Lazy‑Render Override (On‑Demand)** – Temporarily forces rendered content visibility so Chromium search finds all messages, then restores performance optimizations when closed.

### Layout & Readability Enhancements

- **Full‑Width Chat Layout** – Injected CSS removes artificial margins and horizontal scroll.
- **Responsive Width Control** – Automatically adapts to window and screen size.
- **Correct Wrapping** – Code blocks, tables, diffs, and long URLs wrap instead of forcing horizontal scroll.

### Export & Save Options

The application uses a **profile‑based export system** for both chat pane and selection exports.

#### Chat Pane Export Profiles

| Profile | Extension | Description |
|---------|-----------|-------------|
| Clean Markdown | `.md` | DOM cleaned (buttons, reactions removed), converted via Turndown. **Default.** |
| Raw Markdown | `.md` | HTML → Markdown without DOM cleanup. |
| Markdown with metadata | `.md` | Clean Markdown + YAML front‑matter (title, URL, timestamp). |
| HTML | `.html` | Cleaned standalone HTML with minimal CSS. |
| HTML Archive | `.mhtml` | Full MHTML via Chromium `savePage`. |
| Plain Text | `.txt` | Tags stripped, entities decoded, whitespace normalized. |
| PDF | `.pdf` | Rendered via hidden BrowserWindow + `printToPDF`. |

#### Selection Export Profiles

All profiles above except HTML Archive are available for selection exports.

#### Export Access Points

- **File → Save Chat Pane** (`Ctrl+S`) – Uses the default pane profile.
- **File → Export Chat Pane** – Choose any profile.
- **File → Export Selection** – Choose any profile.
- **Right‑click → Save Selection As** – Choose any profile.
- **Right‑click → Copy Selection as Markdown** (`Ctrl+Shift+M`) – Clipboard.

### Logging

- **Dual‑Channel Logging** – Console (stdout) and file logging, independently configurable via `config.json`.
- **Log File** – Written to the application logs folder (default: `copilot-for-linux.log`).
- **Log Format** – `[ISO-8601] [LEVEL] message`.
- **Tray Access** – Open Logs Folder directly from the tray menu.

### Context & Developer Tools

- **Dynamic Layout** – Automatically adjusts chat pane width and layout for optimal readability.
- **Enhanced Context Menus** – Quick Chat actions, export profiles, inspect element, and selection tools.
- **Built‑in About Dialog** – Runtime details (Electron, Chromium, Node, V8).
- **Application Help Viewer** – Renders local Markdown documentation from `assets/help.md` in a dedicated window.

### Keyboard Shortcuts (Highlights)

| Shortcut | Action |
|----------|--------|
| `Ctrl+F` | Find in page |
| `F3` / `Shift+F3` | Next / Previous match |
| `Ctrl+S` | Save Chat Pane |
| `Ctrl+Shift+M` | Copy / Save selection as Markdown |
| `Ctrl+Shift+A` | Select Chat Pane |
| `Ctrl+Alt+N` | New Quick Chat |
| `Ctrl+Alt+Q` | Send selection to active Quick Chat |
| `Ctrl+Alt+Shift+Q` | Send selection as quote |
| `Ctrl+Alt+Enter` | Send & auto‑submit to Quick Chat |
| `F1` | Application Help |

> To build from source see [Installation](#installation) below.

---

## Configuration

The application reads settings from `config.json` in the Electron user‑data directory:

- **Linux**: `~/.config/copilot-for-linux/config.json`
- **Windows**: `%APPDATA%/copilot-for-linux/config.json`

The file is auto‑created on first run with all defaults. It is self‑documenting — newly introduced keys are written automatically on startup.

### Key Reference

| Key | Default | Description |
|-----|---------|-------------|
| `copilotUrl` | `https://m365.cloud.microsoft/chat` | Target Copilot URL. |
| `partition` | `persist:copilot-for-linux` | Chromium session partition (env `COPILOT_PARTITION` overrides). |
| `enableLayoutCss` | `true` | Inject full‑width layout CSS. |
| `enableDirectOpen` | `true` | Shift+click direct‑download‑and‑open. |
| `enableQuickChat` | `true` | Enable Quick Chat subsystem. |
| `defaultExportFormat` | `md` | Default format for Save Chat Pane dialog (`md`, `pdf`, `html`, `mhtml`, `txt`). |
| `defaultPaneExportProfile` | `cleanMarkdown` | Default export profile for pane. |
| `defaultSelectionExportProfile` | `cleanMarkdown` | Default export profile for selection. |
| `quickPasteDelayMs` | `3000` | Fallback paste delay (ms). |
| `findContentVisibilityOverride` | `true` | Override lazy rendering during Find. |
| `devToolsEnabled` | `true` | Allow DevTools. |
| `enableConsoleLogging` | `true` | Log to stdout. |
| `enableFileLogging` | `true` | Log to file. |
| `logFileName` | `copilot-for-linux.log` | Log file name. |

> **Tip:** Open the config file from the tray menu → **Open Config File**.

---

## Installation

```bash
npm install
```

---

## Development

```bash
npm run start
```

---

## Build

### Linux RPM

```bash
npm run dist
```

### Windows (NSIS + portable)

```bash
npm run dist:win
```

> **Note:** RPM packaging uses electron-builder and fpm, which is why `setup.sh` is included.

---

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| electron | ^41.x | Electron runtime |
| electron-builder | ^26.x | Build and packaging |
| turndown | ^7.x | HTML → Markdown conversion |
| turndown-plugin-gfm | ^1.x | GitHub‑Flavored Markdown table support |
| fpm | — | Linux RPM packaging |

> **Note:** `package.json` currently lists `npm` (^11.7.0) as a runtime dependency. This is atypical — npm is normally a dev tool, not a bundled dependency. Consider moving it to `devDependencies` or removing it unless there is a specific runtime requirement.

---

## Project Structure

```
copilot-for-linux/
├── main.js          # Main process (app logic, menus, export, logging, config)
├── preload.js       # Preload script (IPC bridge, direct-open, hover tooltips)
├── renderer.js      # Renderer entry (minimal)
├── package.json     # Electron project manifest
├── assets/
│   ├── help.md      # In-app help documentation (rendered by Application Help viewer)
│   └── *.png        # Application icons (various sizes)
├── config.json      # Auto-generated user config (in userData, not repo)
└── README.md
```

---

## Disclaimer

This is an unofficial client. Microsoft Copilot, Microsoft 365, and related services are trademarks of Microsoft Corporation. This project is not affiliated with or endorsed by Microsoft.

---

## License

BSD 3‑Clause License

Copyright (c) 2026, copilot-for-linux contributors

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
