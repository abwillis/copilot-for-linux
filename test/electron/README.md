# Electron integration tests

These tests run against real `BrowserWindow`, `WebContents`, `WebFrameMain`,
preload, IPC, CSS, and packaged-app behavior. They deliberately complement the
fast module and virtualizer simulations under `test/` rather than replacing
them.

## Local fixture suite

```sh
npm run test:electron
```

On a headless Linux host:

```sh
xvfb-run -a npm run test:electron
```

The suite starts a loopback-only HTTP fixture and verifies:

- renderer-agent injection after a full navigation;
- reinjection into a same-origin frame after frame navigation;
- the configured renderer global and agent version;
- the normal and sandboxed/context-isolated preload bridges;
- CSS insertion, replacement, and reload behavior;
- trusted settings IPC get/validate/save;
- export cancellation when the source window closes;
- cancellation while capture is awaiting a real renderer RPC;
- frame destruction during a pending RPC;
- existing-file replacement and temporary/backup cleanup.

## Packaged startup/export smoke

Build the unpacked target for the current operating system, then run it:

```sh
# Linux
npm run pack:smoke:linux
xvfb-run -a npm run test:packaged

# Windows
npm run pack:smoke:win
npm run test:packaged
```

The packaged executable starts through the production `main.js`, waits for the
app-configured renderer agent, exports a real DOM selection, exports again to the
same path, and checks that replacement left no temporary or backup files.
Linux and Windows execute this same smoke in the CI matrix.
