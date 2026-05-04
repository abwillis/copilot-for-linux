# Copilot for Linux — Help

This document describes the **capabilities**, **application menus**, **right‑click (context) menus**, **keyboard accelerators**, and **tray menu** features available in the Copilot for Linux Electron application.

---

## Overview & Capabilities

Copilot for Linux is an Electron-based wrapper around Microsoft Copilot that adds powerful desktop-oriented workflows on Linux (and Windows builds), including:

- **Main Chat + Multi Quick Chat Windows**
  - Run multiple independent *Quick Chat* windows alongside the main chat.
  - Each Quick Chat can be renamed, pinned (Always on Top), focused, or closed independently.
- **Send Selection to Copilot**
  - Send text selections from the main window or Quick Chat windows directly into another Quick Chat.
  - Supports plain text, quoted text, and optional auto‑submit.
- **Clipboard‑Safe Injection**
  - Selection content is converted to Markdown and pasted safely using clipboard-based injection (iframe‑safe).
- **Advanced Find in Page**
  - Custom Find dialog with live match count.
  - Temporarily disables Copilot’s lazy rendering so *all* messages are searchable.
- **Chat Pane Export**
  - Save the entire chat pane as:
    - Markdown (.md)
    - PDF (.pdf)
    - Clean HTML (.html)
    - MHTML (.mhtml)
    - Plain text (.txt)
- **Selection Export**
  - Copy or save selected content as Markdown or plain text.
- **Improved Layout & Wrapping**
  - Forces full‑width layout.
  - Prevents horizontal scrolling.
  - Ensures code blocks, tables, and long URLs wrap correctly.
- **Shift‑Click Direct Download Open**
  - Shift‑clicking downloadable links automatically downloads to a temp file and opens it using the system default application.
- **Persistent Session & Window State**
  - Uses a persistent Chromium session partition.
  - Remembers window size and position for main and Quick Chat windows.

---

## Application Menu

### File Menu

| Menu Item | Description |
|---------|-------------|
| **Save Chat Pane** | Save the entire chat pane (Markdown, PDF, HTML, MHTML, or TXT). |
| **Save Selection as Markdown** | Save the currently selected content as a Markdown file. |

---

### Edit Menu

| Menu Item | Description |
|---------|-------------|
| **Find** | Open the custom Find-in-Page dialog. |
| **Find Next** | Jump to the next match in the page. |
| **Find Previous** | Jump to the previous match in the page. |
| **Clear Highlights** | Clear current find highlights. |
| **Select Chat Pane** | Select the entire chat pane content for copy/export. |

---

### Quick Chat Menu

This menu dynamically reflects currently open Quick Chat windows.

| Menu Item | Description |
|---------|-------------|
| **New Quick Chat Window** | Open a new Quick Chat window. |
| **Show Active Quick Chat** | Bring the active Quick Chat to the front. |
| **Send Selection to Active Quick Chat** | Send current selection as plain text. |
| **Send Selection as Quote** | Send selection as quoted Markdown. |
| **Send Selection & Auto Submit** | Paste and automatically submit the message. |
| **Send Selection to Specific Quick Chat** | Choose a Quick Chat target. |
| **Quick Chat #N (submenu)** | Window‑specific actions (Bring to Front, Send Here, Pin, Rename, Close). |
| **Close All Quick Chat Windows** | Close all Quick Chat windows. |

---

### Session Menu

| Menu Item | Description |
|---------|-------------|
| **Reload Copilot** | Reload the page normally. |
| **Hard Reload** | Reload while bypassing cache. |
| **Clear Copilot Cache** | Clear Chromium cache only. |
| **Clear Cookies / Sign Out** | Clear cookies and storage and reload. |
| **Copy Current URL** | Copy the current Copilot URL to clipboard. |
| **Open Current URL in External Browser** | Open in default system browser. |

---

### Help Menu

| Menu Item | Description |
|---------|-------------|
| **About** | Show application version and runtime information. |

---

## Right‑Click (Context) Menu

The context menu adapts based on selection and window type.

### Standard Editing

| Action | Notes |
|------|-------|
| Cut | Enabled in editable fields. |
| Copy | Enabled when text is selected. |
| Paste | Enabled in editable fields. |
| Select All | Always available. |

### Quick Chat Actions

| Action | Description |
|------|-------------|
| Send to Quick Chat | Send selection to the active Quick Chat. |
| Send as Quote to Quick Chat | Send quoted Markdown. |
| Send & Auto Submit to Quick Chat | Paste and auto‑submit. |
| New Quick Chat Window | Open a new Quick Chat. |

### Chat Pane Actions

| Action | Description |
|------|-------------|
| Select Chat Pane | Select full conversation output. |
| Save Chat Pane | Export entire pane. |

### Export

| Action | Description |
|------|-------------|
| Copy Selection as Markdown | Markdown to clipboard. |
| Save Selection as Markdown | Save to file. |
| Save Selection as Plain Text | Save cleaned text. |

### Developer

| Action | Description |
|------|-------------|
| Inspect Element | Open DevTools at cursor location. |

---

## Keyboard Accelerators

| Shortcut | Action |
|--------|--------|
| **Ctrl+S** | Save Chat Pane |
| **Ctrl+Shift+M** | Save / Copy Selection as Markdown |
| **Ctrl+F** | Find in Page |
| **F3** | Find Next |
| **Shift+F3** | Find Previous |
| **Esc** | Clear Find Highlights |
| **Ctrl+Alt+N** | New Quick Chat Window |
| **Ctrl+Alt+2** | Show Active Quick Chat |
| **Ctrl+Alt+Q** | Send Selection to Active Quick Chat |
| **Ctrl+Alt+Shift+Q** | Send Selection as Quote |
| **Ctrl+Alt+Enter** | Send Selection & Auto Submit |
| **Ctrl+Alt+W** | Choose Quick Chat Target |
| **Ctrl+R** | Reload |
| **Ctrl+Shift+R** | Hard Reload |
| **Ctrl+Shift+C** | Inspect Element |
| **F1** | About |

---

## Tray Menu

| Tray Item | Description |
|----------|-------------|
| **Show** | Show the main window. |
| **Hide** | Hide the main window. |
| **New Quick Chat** | Create a new Quick Chat window. |
| **Show Active Quick Chat** | Bring active Quick Chat to front. |
| **Save Chat Pane** | Export current chat. |
| **Reload** | Reload Copilot. |
| **Toggle Always on Top** | Pin/unpin the active window. |
| **Clear Copilot Cache** | Clear cache only. |
| **Clear Cookies / Sign Out** | Full sign‑out and reload. |
| **Open Logs Folder** | Open application logs directory. |
| **Open Config File** | Open user config JSON. |
| **About** | Show app information. |
| **Quit** | Exit the application. |

---

## Tips

- **Shift + Click on links** to auto‑download and open files.
- Use **Quick Chat windows** for side‑by‑side comparisons or long‑running prompts.
- Markdown export preserves **code blocks**, **tables**, and **diffs** reliably.

---

*End of Help Documentation*