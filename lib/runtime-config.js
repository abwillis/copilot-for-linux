'use strict';

const util = require('util');

function createRuntimeConfig(deps = {}) {
    const {
        app,
        fs,
        path,
        defaultAppConfig,
        partitionEnvVar,
        onConfigLoaded,
        onDiagnosticSessionChanged,
    } = deps;

    if (!app || !fs || !path) {
        throw new Error('createRuntimeConfig requires app, fs, and path dependencies.');
    }

    if (!defaultAppConfig || typeof defaultAppConfig !== 'object') {
        throw new Error('createRuntimeConfig requires defaultAppConfig.');
    }

    let APP_CONFIG = { ...defaultAppConfig };

    const ORIGINAL_CONSOLE = Object.freeze({
        log: console.log.bind(console),
        info: console.info.bind(console),
        debug: console.debug.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
    });

    let consoleLoggingEnabled = true;
    let fileLoggingEnabled = false;
    let activeLogFilePath = null;
    let activeRendererLogFilePath = null;
    let diagnosticSessionEndsAt = 0;
    let diagnosticSessionTimer = null;
    let acceptingBufferedLogs = true;
    let logQueue = [];
    let queuedLogBytes = 0;
    let logFlushTimer = null;
    let logFlushPromise = Promise.resolve();
    let logWriterOptions = {
        flushIntervalMs: 250,
        bufferMaxBytes: 65536,
        maxBytes: 5242880,
        maxAgeMs: 7 * 24 * 60 * 60 * 1000,
        maxFiles: 5,
    };

    function sanitizeLogFileName(name) {
        return String(name || defaultAppConfig.logFileName)
            .trim()
            .replace(/[^a-zA-Z0-9._-]/g, '-')
            || defaultAppConfig.logFileName;
    }

    function getConfigFilePath() {
        return path.join(app.getPath('userData'), 'config.json');
    }

    function getLogsDirectoryPath() {
        const logsDir = path.join(app.getPath('userData'), 'logs');
        try { fs.mkdirSync(logsDir, { recursive: true }); } catch {}
        return logsDir;
    }

    function getLogFilePath() {
        return path.join(getLogsDirectoryPath(), sanitizeLogFileName(APP_CONFIG.logFileName));
    }

    function formatConsoleArg(value) {
        if (typeof value === 'string') return value;
        try {
            return util.inspect(value, {
                depth: 6,
                colors: false,
                breakLength: 160,
            });
        } catch {
            try { return JSON.stringify(value); } catch {}
        }
        return String(value);
    }

    function configureBufferedWriter() {
        const maxBytes = Math.max(1024, Number(APP_CONFIG.logMaxBytes) || 5242880);
        logWriterOptions = {
            flushIntervalMs: Math.max(10, Number(APP_CONFIG.logFlushIntervalMs) || 250),
            bufferMaxBytes: Math.min(
                maxBytes,
                Math.max(1024, Number(APP_CONFIG.logBufferMaxBytes) || 65536)
            ),
            maxBytes,
            maxAgeMs: Math.max(0, Number(APP_CONFIG.logMaxAgeDays) || 0) * 24 * 60 * 60 * 1000,
            maxFiles: Math.max(1, Number(APP_CONFIG.logMaxFiles) || 5),
        };
    }

    async function pathExists(target) {
        try {
            await fs.promises.access(target);
            return true;
        } catch {
            return false;
        }
    }

    async function pruneExpiredArchives(target) {
        if (!(logWriterOptions.maxAgeMs > 0)) return;
        const now = Date.now();
        for (let i = 1; i < logWriterOptions.maxFiles; i++) {
            const archive = `${target}.${i}`;
            try {
                const stat = await fs.promises.stat(archive);
                if (now - stat.mtimeMs >= logWriterOptions.maxAgeMs) {
                    await fs.promises.unlink(archive);
                }
            } catch {}
        }
    }

    async function rotateLogIfNeeded(target, incomingBytes) {
        let stat = null;
        try { stat = await fs.promises.stat(target); } catch {}
        await pruneExpiredArchives(target);
        if (!stat || stat.size <= 0) return;

        const tooLarge = stat.size + incomingBytes > logWriterOptions.maxBytes;
        const tooOld = logWriterOptions.maxAgeMs > 0 &&
            Date.now() - stat.mtimeMs >= logWriterOptions.maxAgeMs;
        if (!tooLarge && !tooOld) return;

        if (logWriterOptions.maxFiles <= 1) {
            try { await fs.promises.unlink(target); } catch {}
            return;
        }

        const lastArchive = `${target}.${logWriterOptions.maxFiles - 1}`;
        try { await fs.promises.unlink(lastArchive); } catch {}
        for (let i = logWriterOptions.maxFiles - 2; i >= 1; i--) {
            const from = `${target}.${i}`;
            const to = `${target}.${i + 1}`;
            if (await pathExists(from)) {
                try { await fs.promises.rename(from, to); } catch {}
            }
        }
        try { await fs.promises.rename(target, `${target}.1`); } catch {}
    }

    async function writeLogBatch(batch) {
        const grouped = new Map();
        for (const entry of batch) {
            if (!entry?.target || !entry?.line) continue;
            grouped.set(entry.target, (grouped.get(entry.target) || '') + entry.line);
        }
        for (const [target, payload] of grouped) {
            try {
                await fs.promises.mkdir(path.dirname(target), { recursive: true });
                await rotateLogIfNeeded(target, Buffer.byteLength(payload, 'utf8'));
                await fs.promises.appendFile(target, payload, 'utf8');
            } catch {
                // Logging must never break the application or recurse via console.
            }
        }
    }

    function scheduleLogFlush(delayMs = logWriterOptions.flushIntervalMs) {
        if (logFlushTimer || !logQueue.length) return;
        logFlushTimer = setTimeout(() => {
            logFlushTimer = null;
            void flushLogBuffers();
        }, delayMs);
        if (typeof logFlushTimer.unref === 'function') logFlushTimer.unref();
    }

    function enqueueLogLine(target, line) {
        if (!acceptingBufferedLogs || !fileLoggingEnabled || !target) return;
        const rendered = String(line || '');
        logQueue.push({ target, line: rendered });
        queuedLogBytes += Buffer.byteLength(rendered, 'utf8');
        if (queuedLogBytes >= logWriterOptions.bufferMaxBytes) {
            if (logFlushTimer) clearTimeout(logFlushTimer);
            logFlushTimer = null;
            scheduleLogFlush(0);
        } else {
            scheduleLogFlush();
        }
    }

    async function flushLogBuffers() {
        if (logFlushTimer) {
            clearTimeout(logFlushTimer);
            logFlushTimer = null;
        }
        const batch = logQueue;
        logQueue = [];
        queuedLogBytes = 0;
        if (batch.length) {
            logFlushPromise = logFlushPromise
                .then(() => writeLogBatch(batch))
                .catch(() => {});
        }
        await logFlushPromise;
        if (logQueue.length) scheduleLogFlush();
    }

    function appendConsoleLogToFile(level, args) {
        if (!fileLoggingEnabled || !activeLogFilePath) return;
        try {
            const timestamp = new Date().toISOString();
            const rendered = Array.from(args).map(formatConsoleArg).join(' ');
            enqueueLogLine(activeLogFilePath, `[${timestamp}] [${level}] ${rendered}\n`);
        } catch {}
    }

    // ---- Renderer console capture -------------------------------------------
    // Renderer-side console.* (renderer/agent.js, preload, and the hosted web
    // app) runs in a different process and never passes through the patched
    // main-process console below, so it previously reached NO log file. These
    // helpers mirror it into a dedicated renderer log file. A separate file is
    // used deliberately: the hosted web app is chatty, and interleaving it with
    // the app's own main-process log would bury the useful lines.
    function getRendererLogFilePath() {
        return path.join(
            getLogsDirectoryPath(),
            sanitizeLogFileName(
                APP_CONFIG.rendererLogFileName || defaultAppConfig.rendererLogFileName
            )
        );
    }

    function appendRendererLogToFile(level, text, meta) {
        if (!fileLoggingEnabled) return;
        const target = activeRendererLogFilePath || getRendererLogFilePath();
        if (!target) return;
        try {
            const timestamp = new Date().toISOString();
            const where = meta && meta.source
                ? ` (${meta.source}${meta.line ? ':' + meta.line : ''})`
                : '';
            const label = meta && meta.label ? `[${meta.label}] ` : '';
            enqueueLogLine(target, `[${timestamp}] [${level}] ${label}${text}${where}\n`);
        } catch {}
    }

    // Normalize Electron's console-message payload. Electron >=30 passes a
    // details object; older versions pass positional args. Support both so this
    // keeps working across upgrades.
    function normalizeConsoleMessageArgs(a, b, c, d) {
        if (a && typeof a === 'object' && ('message' in a || 'level' in a)) {
            const lvl = String(a.level ?? 'info').toUpperCase();
            return {
                level: lvl === 'WARNING' ? 'WARN' : lvl,
                message: String(a.message ?? ''),
                line: a.lineNumber ?? null,
                source: a.sourceId ?? null,
            };
        }
        const levels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
        return {
            level: levels[Number(a)] || 'INFO',
            message: String(b ?? ''),
            line: c ?? null,
            source: d ?? null,
        };
    }

    // Attach to a webContents so its console output is captured. Safe to call
    // repeatedly; a per-webContents flag prevents duplicate listeners. The
    // listener is always installed so a diagnostic session can be started after
    // the window was created, but it discards events unless capture is enabled.
    function attachRendererConsoleCapture(webContents, label) {
        if (!webContents || typeof webContents.on !== 'function') return false;
        try {
            if (webContents.__rendererConsoleCaptureAttached) return false;
            webContents.__rendererConsoleCaptureAttached = true;
        } catch { /* frozen object: fall through and attach anyway */ }

        try {
            webContents.on('console-message', (_event, a, b, c, d) => {
                // Re-read the flag each time so a config reload takes effect.
                if (!isRendererConsoleCaptureActive()) return;
                const info = normalizeConsoleMessageArgs(a, b, c, d);
                appendRendererLogToFile(info.level, info.message, {
                    source: info.source,
                    line: info.line,
                    label: label || 'renderer',
                });
            });
            return true;
        } catch {
            return false;
        }
    }

    // ---- Verbose diagnostics -------------------------------------------------
    // For large diagnostic dumps: always honors enableFileLogging, but stays off
    // the console unless verboseDiagnosticsToConsole is true. This keeps
    // multi-hundred-line JSON blobs out of the terminal while preserving them in
    // the log file for analysis.
    function logVerbose(...args) {
        if (APP_CONFIG.verboseDiagnosticsToConsole === true) {
            if (consoleLoggingEnabled) ORIGINAL_CONSOLE.log(...args);
        }
        appendConsoleLogToFile('VERBOSE', args);
    }

    function isDiagnosticSessionActive() {
        if (!(diagnosticSessionEndsAt > Date.now())) {
            if (diagnosticSessionEndsAt) {
                diagnosticSessionEndsAt = 0;
                if (diagnosticSessionTimer) clearTimeout(diagnosticSessionTimer);
                diagnosticSessionTimer = null;
                applyConsoleLoggingConfig();
                if (typeof onDiagnosticSessionChanged === 'function') {
                    try { onDiagnosticSessionChanged(getDiagnosticSessionStatus()); } catch {}
                }
            }
            return false;
        }
        return true;
    }

    function isRendererConsoleCaptureActive() {
        return APP_CONFIG.enableRendererConsoleCapture === true || isDiagnosticSessionActive();
    }

    function getDiagnosticSessionStatus() {
        const active = diagnosticSessionEndsAt > Date.now();
        return {
            active,
            endsAt: active ? new Date(diagnosticSessionEndsAt).toISOString() : null,
            remainingMs: active ? Math.max(0, diagnosticSessionEndsAt - Date.now()) : 0,
            durationMinutes: Number(APP_CONFIG.diagnosticSessionDurationMinutes) || 15,
        };
    }

    function startDiagnosticSession(minutes = APP_CONFIG.diagnosticSessionDurationMinutes) {
        const durationMinutes = Math.max(1, Math.min(120, Math.round(Number(minutes) || 15)));
        diagnosticSessionEndsAt = Date.now() + durationMinutes * 60 * 1000;
        if (diagnosticSessionTimer) clearTimeout(diagnosticSessionTimer);
        diagnosticSessionTimer = setTimeout(() => {
            diagnosticSessionEndsAt = 0;
            diagnosticSessionTimer = null;
            applyConsoleLoggingConfig();
            if (typeof onDiagnosticSessionChanged === 'function') {
                try { onDiagnosticSessionChanged(getDiagnosticSessionStatus()); } catch {}
            }
        }, durationMinutes * 60 * 1000);
        if (typeof diagnosticSessionTimer.unref === 'function') diagnosticSessionTimer.unref();
        applyConsoleLoggingConfig();
        appendConsoleLogToFile('INFO', [`Diagnostic session started for ${durationMinutes} minute(s).`]);
        const status = getDiagnosticSessionStatus();
        if (typeof onDiagnosticSessionChanged === 'function') {
            try { onDiagnosticSessionChanged(status); } catch {}
        }
        return status;
    }

    async function stopDiagnosticSession() {
        if (diagnosticSessionTimer) clearTimeout(diagnosticSessionTimer);
        diagnosticSessionTimer = null;
        if (diagnosticSessionEndsAt > Date.now()) {
            appendConsoleLogToFile('INFO', ['Diagnostic session stopped.']);
        }
        diagnosticSessionEndsAt = 0;
        applyConsoleLoggingConfig();
        await flushLogBuffers();
        const status = getDiagnosticSessionStatus();
        if (typeof onDiagnosticSessionChanged === 'function') {
            try { onDiagnosticSessionChanged(status); } catch {}
        }
        return status;
    }

    async function deleteDiagnosticLogFiles() {
        acceptingBufferedLogs = false;
        if (logFlushTimer) {
            clearTimeout(logFlushTimer);
            logFlushTimer = null;
        }
        logQueue = [];
        queuedLogBytes = 0;
        await logFlushPromise.catch(() => {});
        try {
            const directory = getLogsDirectoryPath();
            const baseNames = new Set([
                path.basename(getLogFilePath()),
                path.basename(getRendererLogFilePath()),
            ]);
            const entries = await fs.promises.readdir(directory, { withFileTypes: true });
            let deleted = 0;
            for (const entry of entries) {
                if (!entry.isFile()) continue;
                const matches = Array.from(baseNames).some(base => {
                    if (entry.name === base) return true;
                    const suffix = entry.name.slice(base.length + 1);
                    return entry.name.startsWith(`${base}.`) && /^\d+$/.test(suffix);
                });
                if (!matches) continue;
                try {
                    await fs.promises.unlink(path.join(directory, entry.name));
                    deleted++;
                } catch {}
            }
            return { ok: true, deleted };
        } catch (error) {
            return { ok: false, deleted: 0, error: String(error?.message || error) };
        } finally {
            acceptingBufferedLogs = true;
        }
    }

    function makeConsoleMethod(level) {
        const original = ORIGINAL_CONSOLE[level.toLowerCase()] || ORIGINAL_CONSOLE.log;
        return (...args) => {
            if (consoleLoggingEnabled) original(...args);
            appendConsoleLogToFile(level, args);
        };
    }

    function applyConsoleLoggingConfig() {
        consoleLoggingEnabled = APP_CONFIG.enableConsoleLogging !== false;
        configureBufferedWriter();
        fileLoggingEnabled = APP_CONFIG.enableFileLogging === true ||
            diagnosticSessionEndsAt > Date.now();
        activeLogFilePath = fileLoggingEnabled ? getLogFilePath() : null;
        activeRendererLogFilePath = fileLoggingEnabled ? getRendererLogFilePath() : null;

        console.log = makeConsoleMethod('LOG');
        console.info = makeConsoleMethod('INFO');
        console.debug = makeConsoleMethod('DEBUG');
        console.warn = makeConsoleMethod('WARN');
        console.error = makeConsoleMethod('ERROR');
    }

    async function shutdownLogging() {
        if (diagnosticSessionTimer) clearTimeout(diagnosticSessionTimer);
        diagnosticSessionTimer = null;
        diagnosticSessionEndsAt = 0;
        acceptingBufferedLogs = false;
        await flushLogBuffers();
        console.log = ORIGINAL_CONSOLE.log;
        console.info = ORIGINAL_CONSOLE.info;
        console.debug = ORIGINAL_CONSOLE.debug;
        console.warn = ORIGINAL_CONSOLE.warn;
        console.error = ORIGINAL_CONSOLE.error;
    }

    function normalizeBooleanConfig(value, fallback) {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') {
            const lowered = value.trim().toLowerCase();
            if (['true', '1', 'yes', 'on'].includes(lowered)) return true;
            if (['false', '0', 'no', 'off'].includes(lowered)) return false;
        }
        return fallback;
    }

    function normalizePositiveIntegerConfig(value, fallback) {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) return Math.round(n);
        return fallback;
    }

    function normalizeExportFormat(value, fallback) {
        const fmt = String(value ?? fallback).trim().toLowerCase().replace(/^\./, '');
        return ['md', 'markdown', 'pdf', 'html', 'mhtml', 'txt'].includes(fmt) ? fmt : fallback;
    }

    function normalizeExportProfile(value, fallback) {
        const profile = String(value ?? fallback).trim();
        return [
            'cleanMarkdown',
            'rawMarkdown',
            'markdownWithMetadata',
            'markdownExternalImages',
            'html',
            'htmlArchive',
            'plainText',
            'pdf',
        ].includes(profile)
            ? profile
            : fallback;
    }

    function normalizeAppConfig(raw = {}) {
        const source = (raw && typeof raw === 'object') ? raw : {};
        const merged = { ...defaultAppConfig, ...source };

        merged.appUrl = String(merged.appUrl || defaultAppConfig.appUrl).trim();
        merged.partition = String(
            process.env[partitionEnvVar] ??
            merged.partition ??
            defaultAppConfig.partition
        ).trim();
        merged.enableLayoutCss = normalizeBooleanConfig(merged.enableLayoutCss, defaultAppConfig.enableLayoutCss);
        merged.layoutWidthVw = Math.max(83, Math.min(100,
            normalizePositiveIntegerConfig(merged.layoutWidthVw, defaultAppConfig.layoutWidthVw)
        ));
        merged.theme = ['system', 'light', 'dark'].includes(String(merged.theme))
            ? String(merged.theme)
            : defaultAppConfig.theme;
        const legacyDirectOpenEnabled = normalizeBooleanConfig(
            merged.enableDirectOpen,
            defaultAppConfig.enableDirectOpen
        );
        const hasDirectOpenBehavior = Object.prototype.hasOwnProperty.call(source, 'directOpenBehavior');
        merged.directOpenBehavior = hasDirectOpenBehavior && ['disabled', 'shift-click'].includes(String(source.directOpenBehavior))
            ? String(source.directOpenBehavior)
            : (legacyDirectOpenEnabled ? 'shift-click' : 'disabled');
        // Keep the legacy boolean synchronized for older modules and hand-edited
        // config files while the richer behavior setting becomes authoritative.
        merged.enableDirectOpen = merged.directOpenBehavior !== 'disabled';
        merged.enableQuickChat = normalizeBooleanConfig(merged.enableQuickChat, defaultAppConfig.enableQuickChat);
        merged.quickChatCloseBehavior = ['hide', 'close'].includes(String(merged.quickChatCloseBehavior))
            ? String(merged.quickChatCloseBehavior)
            : defaultAppConfig.quickChatCloseBehavior;
        merged.spellcheckEnabled = normalizeBooleanConfig(merged.spellcheckEnabled, defaultAppConfig.spellcheckEnabled);
        merged.spellcheckLanguages = Array.isArray(merged.spellcheckLanguages)
            ? merged.spellcheckLanguages.map(value => String(value || '').trim()).filter(Boolean)
            : [...defaultAppConfig.spellcheckLanguages];
        for (const key of ['permissionNotifications', 'permissionMedia', 'permissionGeolocation', 'permissionClipboardRead']) {
            merged[key] = ['ask', 'allow', 'deny'].includes(String(merged[key]))
                ? String(merged[key])
                : defaultAppConfig[key];
        }
        merged.launchAtLogin = normalizeBooleanConfig(merged.launchAtLogin, defaultAppConfig.launchAtLogin);
        merged.startMinimized = normalizeBooleanConfig(merged.startMinimized, defaultAppConfig.startMinimized);
        merged.showTrayIcon = normalizeBooleanConfig(merged.showTrayIcon, defaultAppConfig.showTrayIcon);
        if (!merged.showTrayIcon) merged.startMinimized = false;
        merged.globalShortcutsEnabled = normalizeBooleanConfig(merged.globalShortcutsEnabled, defaultAppConfig.globalShortcutsEnabled);
        for (const key of ['globalShortcutShowMain', 'globalShortcutNewQuickChat', 'globalShortcutShowQuickChat']) {
            merged[key] = String(merged[key] ?? defaultAppConfig[key]).trim();
        }
        merged.defaultExportFormat = normalizeExportFormat(merged.defaultExportFormat, defaultAppConfig.defaultExportFormat);
        merged.defaultPaneExportProfile = normalizeExportProfile(merged.defaultPaneExportProfile, defaultAppConfig.defaultPaneExportProfile);
        merged.defaultSelectionExportProfile = normalizeExportProfile(merged.defaultSelectionExportProfile, defaultAppConfig.defaultSelectionExportProfile);
        merged.quickPasteDelayMs = normalizePositiveIntegerConfig(merged.quickPasteDelayMs, defaultAppConfig.quickPasteDelayMs);
        merged.findContentVisibilityOverride = normalizeBooleanConfig(merged.findContentVisibilityOverride, defaultAppConfig.findContentVisibilityOverride);
        merged.devToolsEnabled = normalizeBooleanConfig(merged.devToolsEnabled, defaultAppConfig.devToolsEnabled);
        merged.enableExportDiagnostics = normalizeBooleanConfig(merged.enableExportDiagnostics, defaultAppConfig.enableExportDiagnostics);
        merged.enableExportHealthMetrics = normalizeBooleanConfig(merged.enableExportHealthMetrics, defaultAppConfig.enableExportHealthMetrics);
        merged.enableConsoleLogging = normalizeBooleanConfig(merged.enableConsoleLogging, defaultAppConfig.enableConsoleLogging);
        merged.enableFileLogging = normalizeBooleanConfig(merged.enableFileLogging, defaultAppConfig.enableFileLogging);
        merged.logFileName = sanitizeLogFileName(merged.logFileName || defaultAppConfig.logFileName);
        merged.logFlushIntervalMs = normalizePositiveIntegerConfig(merged.logFlushIntervalMs, defaultAppConfig.logFlushIntervalMs);
        merged.logBufferMaxBytes = normalizePositiveIntegerConfig(merged.logBufferMaxBytes, defaultAppConfig.logBufferMaxBytes);
        merged.logMaxBytes = normalizePositiveIntegerConfig(merged.logMaxBytes, defaultAppConfig.logMaxBytes);
        merged.logMaxAgeDays = normalizePositiveIntegerConfig(merged.logMaxAgeDays, defaultAppConfig.logMaxAgeDays);
        merged.logMaxFiles = normalizePositiveIntegerConfig(merged.logMaxFiles, defaultAppConfig.logMaxFiles);
        merged.enableRendererConsoleCapture = normalizeBooleanConfig(merged.enableRendererConsoleCapture, defaultAppConfig.enableRendererConsoleCapture);
        merged.rendererLogFileName = sanitizeLogFileName(merged.rendererLogFileName || defaultAppConfig.rendererLogFileName);
        merged.verboseDiagnosticsToConsole = normalizeBooleanConfig(merged.verboseDiagnosticsToConsole, defaultAppConfig.verboseDiagnosticsToConsole);
        merged.diagnosticSessionDurationMinutes = normalizePositiveIntegerConfig(
            merged.diagnosticSessionDurationMinutes,
            defaultAppConfig.diagnosticSessionDurationMinutes
        );

        // Export/diagnostic flags added alongside the PDF and markdown export
        // work. These were previously merged straight from config.json without
        // coercion, which made them silently unsettable: config.json is plain
        // JSON with no comments, so a hand-edited "false"/"off"/"no" arrives as
        // a STRING, and every consumer tests these with `!== false`. A string is
        // never === false, so the feature stayed ENABLED even though the file
        // said otherwise -- including the documented escape hatches such as
        // expandReasoningForSnapshot:false and stripDecorativeIcons:false.
        merged.enablePdfChunking = normalizeBooleanConfig(merged.enablePdfChunking, defaultAppConfig.enablePdfChunking);
        merged.pdfChunkPageThreshold = normalizePositiveIntegerConfig(merged.pdfChunkPageThreshold, defaultAppConfig.pdfChunkPageThreshold);
        merged.pdfChunkSize = normalizePositiveIntegerConfig(merged.pdfChunkSize, defaultAppConfig.pdfChunkSize);
        merged.pdfChunkPageHeightPx = normalizePositiveIntegerConfig(merged.pdfChunkPageHeightPx, defaultAppConfig.pdfChunkPageHeightPx);
        merged.enableConversationExportDiagnostic = normalizeBooleanConfig(merged.enableConversationExportDiagnostic, defaultAppConfig.enableConversationExportDiagnostic);
        merged.enableReasoningExpansion = normalizeBooleanConfig(merged.enableReasoningExpansion, defaultAppConfig.enableReasoningExpansion);
        merged.expandReasoningForSnapshot = normalizeBooleanConfig(merged.expandReasoningForSnapshot, defaultAppConfig.expandReasoningForSnapshot);
        merged.reasoningExpandBudgetMs = normalizePositiveIntegerConfig(merged.reasoningExpandBudgetMs, defaultAppConfig.reasoningExpandBudgetMs);
        merged.stripDecorativeIcons = normalizeBooleanConfig(merged.stripDecorativeIcons, defaultAppConfig.stripDecorativeIcons);
        merged.cleanMarkdownStripsJunk = normalizeBooleanConfig(merged.cleanMarkdownStripsJunk, defaultAppConfig.cleanMarkdownStripsJunk);
        merged.flattenRetryMaxPasses = normalizePositiveIntegerConfig(merged.flattenRetryMaxPasses, defaultAppConfig.flattenRetryMaxPasses);
        merged.flattenRetryBudgetMs = normalizePositiveIntegerConfig(merged.flattenRetryBudgetMs, defaultAppConfig.flattenRetryBudgetMs);
        merged.scrollerStableSamples = normalizePositiveIntegerConfig(merged.scrollerStableSamples, defaultAppConfig.scrollerStableSamples);
        merged.scrollerStablePollMs = normalizePositiveIntegerConfig(merged.scrollerStablePollMs, defaultAppConfig.scrollerStablePollMs);
        merged.scrollerStableBudgetMs = normalizePositiveIntegerConfig(merged.scrollerStableBudgetMs, defaultAppConfig.scrollerStableBudgetMs);
        merged.scrollerStableBeforePdf = normalizeBooleanConfig(merged.scrollerStableBeforePdf, defaultAppConfig.scrollerStableBeforePdf);

        if (!merged.appUrl) merged.appUrl = defaultAppConfig.appUrl;
        if (!merged.partition) merged.partition = defaultAppConfig.partition;

        return merged;
    }

    function writeConfigFile(configPath, config) {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        const tempPath = `${configPath}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
        fs.renameSync(tempPath, configPath);
    }

    function loadAppConfig() {
        const configPath = getConfigFilePath();
        let parsed = null;

        try {
            if (fs.existsSync(configPath)) {
                parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            }
        } catch (err) {
            console.error('Failed to read config.json; using defaults:', err);
        }

        APP_CONFIG = normalizeAppConfig(parsed ?? defaultAppConfig);

        if (typeof onConfigLoaded === 'function') {
            onConfigLoaded(APP_CONFIG);
        }

        applyConsoleLoggingConfig();

        try {
            writeConfigFile(configPath, APP_CONFIG);
        } catch (err) {
            console.error('Failed to write config.json:', err);
        }

        return APP_CONFIG;
    }

    function ensureConfigFile() {
        loadAppConfig();
        return getConfigFilePath();
    }
    function updateAppConfig(patch = {}) {
        const next = normalizeAppConfig({ ...APP_CONFIG, ...patch });
        const configPath = getConfigFilePath();
        // Commit to disk before swapping the in-memory snapshot. A failed write
        // therefore leaves both the running application and config.json intact.
        writeConfigFile(configPath, next);
        APP_CONFIG = next;
        if (typeof onConfigLoaded === 'function') onConfigLoaded(APP_CONFIG);
        applyConsoleLoggingConfig();
        return { ...APP_CONFIG };
    }

    function getAppConfig() {
        const diagnosticSessionActive = isDiagnosticSessionActive();
        return {
            ...APP_CONFIG,
            diagnosticSessionActive,
            // Conversation content diagnostics cannot be made persistent via
            // config.json. They are enabled only by the temporary session.
            enableConversationExportDiagnostic: diagnosticSessionActive,
            enableFileLogging: APP_CONFIG.enableFileLogging === true || diagnosticSessionActive,
            enableRendererConsoleCapture:
                APP_CONFIG.enableRendererConsoleCapture === true || diagnosticSessionActive,
        };
    }
    function getStoredAppConfig() {
        return { ...APP_CONFIG };
    }

    return {
        sanitizeLogFileName,
        getConfigFilePath,
        getLogsDirectoryPath,
        getLogFilePath,
        getRendererLogFilePath,
        formatConsoleArg,
        appendConsoleLogToFile,
        appendRendererLogToFile,
        attachRendererConsoleCapture,
        flushLogBuffers,
        deleteDiagnosticLogFiles,
        getDiagnosticSessionStatus,
        startDiagnosticSession,
        stopDiagnosticSession,
        shutdownLogging,
        logVerbose,
        makeConsoleMethod,
        applyConsoleLoggingConfig,
        normalizeBooleanConfig,
        normalizePositiveIntegerConfig,
        normalizeExportFormat,
        normalizeExportProfile,
        normalizeAppConfig,
        writeConfigFile,
        loadAppConfig,
        ensureConfigFile,
        updateAppConfig,
        getAppConfig,
        getStoredAppConfig,
    };
}

module.exports = { createRuntimeConfig };
