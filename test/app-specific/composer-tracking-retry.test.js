'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const layout = require('../../app-specific/layout-css');

// Minimal webContents: top frame answers startComposerTracking through
// executeJavaScript; optional extra sub-frame answers through frame.executeJavaScript.
function fixture({ topMissingFor = 0, topAlwaysMissing = false, subFrameMissing = false } = {}) {
    const wc = new EventEmitter();
    let topCalls = 0;
    const missing = { ok: false, missing: true, method: 'startComposerTracking', global: '__test' };
    wc.isDestroyed = () => false;
    wc.getURL = () => 'https://copilot.cloud.microsoft/chats/abc?secret=1';
    wc.mainFrame = { framesInSubtree: [] };
    wc.mainFrame.framesInSubtree.push(wc.mainFrame);
    if (subFrameMissing) {
        wc.mainFrame.framesInSubtree.push({ routingId: 5, executeJavaScript: async () => missing });
    }
    wc.executeJavaScript = async source => {
        if (!source.includes('startComposerTracking')) return { ok: true };
        topCalls += 1;
        return topAlwaysMissing || topCalls <= topMissingFor ? missing : { ok: true, installed: true };
    };
    const api = layout.createLayoutCSS({
        rendererApiGlobal: '__test',
        dynamicWidth: { cssVar: '--test-vw', minVw: 70, maxVw: 100, defaultVw: 100 },
        getRuntimeConfig: () => ({ layoutWidthVw: 100 }),
        composerRetryDelaysMs: [1, 1, 1],
    });
    return { api, win: { webContents: wc, isDestroyed: () => false }, topCalls: () => topCalls };
}

async function captureWarnings(action) {
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args.map(String).join(' '));
    try { await action(); } finally { console.warn = original; }
    return warnings;
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('retries on a transient "agent missing" and stays quiet when it recovers', async () => {
    const f = fixture({ topMissingFor: 2 });
    const warnings = await captureWarnings(() => f.api.attachComposerTracking(f.win));
    assert.equal(f.topCalls(), 3);
    assert.deepEqual(warnings, []);
});

test('logs one warning, with origin only, after retries are exhausted on the top frame', async () => {
    const f = fixture({ topAlwaysMissing: true });
    const warnings = await captureWarnings(() => f.api.attachComposerTracking(f.win));
    assert.equal(f.topCalls(), 4);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /top frame \(https:\/\/copilot\.cloud\.microsoft\) after 4 attempts/);
    assert.doesNotMatch(warnings[0], /secret|chats\/abc/);
});

test('stays quiet when only a sub-frame lacks the agent', async () => {
    const f = fixture({ subFrameMissing: true });
    const warnings = await captureWarnings(() => f.api.attachComposerTracking(f.win));
    assert.deepEqual(warnings, []);
});

test('a newer install supersedes a retry loop that is still waiting', async () => {
    const f = fixture({ topAlwaysMissing: true });
    const warnings = await captureWarnings(async () => {
        await Promise.all([f.api.attachComposerTracking(f.win), f.api.attachComposerTracking(f.win)]);
        await wait(30);
    });
    assert.equal(warnings.length, 1);
});
