# copilot-for-linux

## Overview
copilot-for-linux is an Electron-based desktop application designed to provide Microsoft Copilot functionality on Linux systems. It integrates with Microsoft 365 services and offers a native-like experience with features such as dynamic layout adjustments, chat pane selection, and export options.  

## Features
- **Electron Integration**: Uses Electron to create a cross-platform desktop application.
- **Dynamic Layout**: Automatically adjusts chat pane width and layout for optimal readability.
- **Find-in-Page**: Includes a custom modal for searching text within the chat interface.
- **Export Options**:
  - Save chat pane as Markdown, HTML, MHTML, or plain text.
  - Copy selection as Markdown.
- **Tray Support**: Provides a system tray icon with quick actions (Show, Hide, About, Quit).
- **Persistent Window State**: Remembers window size and position across sessions.
- **Context Menu Enhancements**: Adds options for saving selections and inspecting elements.

## Installation
```bash
npm install
```

## Development
```bash
npm run start
```

## Build
```bash
npm run dist (only rpm builds currently)
```

## Dependencies
- electron ^39.2.6
- electron-builder ^26.0.12
- fpm 1.17.0 (this is why setup.sh is in the repository)

## License
BSD 3-Clause License

Copyright (c) 2026, copilot-for-linux contributors
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
