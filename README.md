# copilot-for-linux

## Overview
copilot-for-linux is an unofficial Electron-based desktop wrapper for Microsoft Copilot that provides a first‑class Linux desktop experience. It wraps the Microsoft 365 Copilot web app and adds powerful native features such as multi‑window Quick Chats, advanced find‑in‑page, robust export options, persistent window state, and tray integration.
The project is designed for power users who want tighter desktop integration, better content handling, and high‑fidelity exports compared to using Copilot in a browser.


## Key Features
Core Application

Electron Desktop App – Runs Microsoft Copilot as a standalone Linux desktop application.
Persistent Session – Uses a persistent Electron partition so you stay signed in across restarts.
Tray Integration – Tray icon with Show/Hide, Quick Chat controls, reload, cache clearing, and quit options.
Persistent Window State – Remembers size and position for the main window and Quick Chat windows.
Always‑on‑Top Support – Toggle per window.
Quick Chat System

Multiple Quick Chat Windows – Open, manage, rename, pin, and close multiple Quick Chats.
Send Selection to Quick Chat – Send highlighted text directly into a Quick Chat: Plain
Quoted
Auto‑submit
Targeted Sending – Send content to a specific Quick Chat window or choose interactively.
Clipboard‑Safe Injection – Works reliably even with iframe‑based editors.
Find‑in‑Page (Enhanced)

Custom Find Modal – Ctrl+F opens a native Find interface.
Match Case, Next/Previous – With live result counts.
Lazy‑Render Override (On‑Demand) – Temporarily forces rendered content visibility so Chromium search finds all messages, then restores performance optimizations when closed.
Layout & Readability Enhancements

Full‑Width Chat Layout – Injected CSS removes artificial margins and horizontal scroll.
Responsive Width Control – Automatically adapts to window and screen size.
Correct Wrapping – Code blocks, tables, diffs, and long URLs wrap instead of forcing horizontal scroll.
Export & Save Options

Save Entire Chat Pane As:Markdown (.md)
PDF (.pdf)
Clean HTML (.html)
MHTML (.mhtml)
Plain Text (.txt)
Save Selection As:Markdown
Plain Text
Copy Selection as Markdown – Ideal for documentation and tickets.
Clean Export Pipeline – Removes UI chrome, reactions, buttons, and noise before exporting.
Context & Developer Tools

Dynamic Layout - Automatically adjusts chat pane width and layout for optimal readability.
Enhanced Context Menus – Quick Chat actions, exports, inspect element, and selection tools.
Built‑in About Dialog – Runtime details (Electron, Chromium, Node, V8).
Application Help Viewer – Renders local Markdown documentation.


Keyboard Shortcuts (Highlights)

Ctrl+F – Find in page
F3 / Shift+F3 – Next / Previous match
Ctrl+S – Save Chat Pane
Ctrl+Shift+M – Copy / Save selection as Markdown
Ctrl+Alt+N – New Quick Chat
Ctrl+Alt+Q – Send selection to active Quick Chat
Ctrl+Alt+Shift+Q – Send selection as quote
Ctrl+Alt+Enter – Send & auto‑submit to Quick Chat


To build from source see Installation below.




## Installation

npm install




## Development

npm run start




## Build

# Linux RPM
npm run dist

# Windows (NSIS + portable)
npm run dist:win




Note: RPM packaging uses electron-builder and fpm, which is why setup.sh is included.




## Dependencies

electron ^41.x
electron-builder ^26.x
turndown – HTML → Markdown conversion
turndown-plugin-gfm – GitHub‑Flavored Markdown support
fpm – Linux packaging


## Disclaimer
This is an unofficial client. Microsoft Copilot, Microsoft 365, and related services are trademarks of Microsoft Corporation. This project is not affiliated with or endorsed by Microsoft.


## License
BSD 3‑Clause License
Copyright (c) 2026, copilot-for-linux contributors
Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.
THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.

