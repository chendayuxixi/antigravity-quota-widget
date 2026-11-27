/* --- AG TOKEN STATS MAIN START --- */
;(function agTokenStatsMain() {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');

    const CHANNEL = 'ag-token-stats:get';
    const QUOTA_CHANNEL = 'ag-quota:get';

    function readVarint(buf, pos) {
        let val = 0;
        let mul = 1;
        while (pos < buf.length) {
            const b = buf[pos++];
            val += (b & 0x7f) * mul;
            if (!(b & 0x80)) return [val, pos];
            mul *= 128;
        }
        throw new Error('varint EOF');
    }

    function decodeFields(buf) {
        const out = [];
        let pos = 0;
        while (pos < buf.length) {
            let tag;
            [tag, pos] = readVarint(buf, pos);
            const fn = Math.floor(tag / 8);
            const wt = tag & 7;
            if (wt === 0) {
                let v;
                [v, pos] = readVarint(buf, pos);
                out.push([fn, 0, v]);
            } else if (wt === 1) {
                pos += 8;
            } else if (wt === 2) {
                let len;
                [len, pos] = readVarint(buf, pos);
                out.push([fn, 2, buf.subarray(pos, pos + len)]);
                pos += len;
            } else if (wt === 5) {
                pos += 4;
            } else {
                break;
            }
        }
        return out;
    }

    function firstVarint(fields, fn) {
        for (const [f, wt, v] of fields) if (f === fn && wt === 0) return v;
        return 0;
    }

    function firstBytes(fields, fn) {
        for (const [f, wt, v] of fields) if (f === fn && wt === 2) return v;
        return null;
    }

    function parsePackedVarints(buf) {
        const out = [];
        let pos = 0;
        try {
            while (pos < buf.length) {
                let v;
                [v, pos] = readVarint(buf, pos);
                out.push(v);
            }
        } catch (_e) {}
        return out;
    }

    // gen_metadata: 2 = packed step indices, 1 = chat model metadata { 4 = usage {1 input, 2 cache read, 3 output}, 19 model id, 21 model label }
    function parseGenMetadata(buf) {
        const top = decodeFields(buf);
        const stepBytes = firstBytes(top, 2);
        const steps = stepBytes ? parsePackedVarints(stepBytes) : [];
        const meta = firstBytes(top, 1);
        if (!meta) return null;
        const mf = decodeFields(meta);
        const usageBytes = firstBytes(mf, 4);
        if (!usageBytes) return null;
        const uf = decodeFields(usageBytes);
        const labelBytes = firstBytes(mf, 21) || firstBytes(mf, 19);
        return {
            steps,
            model: labelBytes ? Buffer.from(labelBytes).toString('utf8') : 'unknown',
            input: firstVarint(uf, 1),
            cacheRead: firstVarint(uf, 2),
            output: firstVarint(uf, 3)
        };
    }

    // steps.metadata: 1 = created_at Timestamp { 1 = seconds }
    function parseStepTimestampMs(buf) {
        if (!buf) return 0;
        try {
            const created = firstBytes(decodeFields(buf), 1);
            if (!created) return 0;
            const secs = firstVarint(decodeFields(created), 1);
            return secs > 0 ? secs * 1000 : 0;
        } catch (_e) {
            return 0;
        }
    }

    function openReadOnly(DatabaseSync, file) {
        try {
            return { db: new DatabaseSync(file, { readOnly: true }), tmpDir: null };
        } catch (_e) {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-token-stats-'));
            const base = path.basename(file);
            for (const ext of ['', '-wal', '-shm']) {
                if (fs.existsSync(file + ext)) fs.copyFileSync(file + ext, path.join(tmpDir, base + ext));
            }
            return { db: new DatabaseSync(path.join(tmpDir, base), { readOnly: true }), tmpDir };
        }
    }

    function loadTitles(DatabaseSync, baseDir) {
        const titles = {};
        const file = path.join(baseDir, 'conversation_summaries.db');
        if (!fs.existsSync(file)) return titles;
        let handle;
        try {
            handle = openReadOnly(DatabaseSync, file);
            for (const row of handle.db.prepare('SELECT conversation_id, title FROM conversation_summaries').all()) {
                titles[row.conversation_id] = row.title || '';
            }
        } catch (_e) {
        } finally {
            if (handle) {
                try { handle.db.close(); } catch (_e) {}
                if (handle.tmpDir) try { fs.rmSync(handle.tmpDir, { recursive: true, force: true }); } catch (_e) {}
            }
        }
        return titles;
    }

    function collectTokenStats(baseDirOverride) {
        const { DatabaseSync } = require('node:sqlite');
        const baseDir = baseDirOverride || path.join(os.homedir(), '.gemini', 'antigravity');
        const convDir = path.join(baseDir, 'conversations');
        const titles = loadTitles(DatabaseSync, baseDir);
        const events = [];
        const errors = [];
        let files = [];
        try {
            files = fs.readdirSync(convDir).filter(f => f.endsWith('.db'));
        } catch (e) {
            return { ok: false, error: `cannot read ${convDir}: ${e.message}`, events, generatedAt: Date.now() };
        }
        for (const f of files) {
            const convId = f.slice(0, -3);
            let handle;
            try {
                handle = openReadOnly(DatabaseSync, path.join(convDir, f));
                const stepTs = new Map();
                for (const row of handle.db.prepare('SELECT idx, metadata FROM steps').all()) {
                    stepTs.set(Number(row.idx), parseStepTimestampMs(row.metadata ? Buffer.from(row.metadata) : null));
                }
                let lastTs = 0;
                const pendingNoTs = [];
                for (const row of handle.db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx').all()) {
                    if (!row.data) continue;
                    const g = parseGenMetadata(Buffer.from(row.data));
                    if (!g) continue;
                    let ts = 0;
                    for (const s of g.steps) {
                        const t = stepTs.get(s);
                        if (t) { ts = t; break; }
                    }
                    if (!ts) ts = lastTs;
                    lastTs = ts || lastTs;
                    const ev = {
                        ts,
                        conv: convId,
                        title: titles[convId] || '',
                        model: g.model,
                        input: g.input,
                        cacheRead: g.cacheRead,
                        output: g.output
                    };
                    if (!ts) pendingNoTs.push(ev);
                    events.push(ev);
                }
                if (pendingNoTs.length > 0) {
                    let earliest = 0;
                    for (const t of stepTs.values()) if (t && (!earliest || t < earliest)) earliest = t;
                    for (const ev of pendingNoTs) ev.ts = earliest;
                }
            } catch (e) {
                errors.push(`${f}: ${e.message}`);
            } finally {
                if (handle) {
                    try { handle.db.close(); } catch (_e) {}
                    if (handle.tmpDir) try { fs.rmSync(handle.tmpDir, { recursive: true, force: true }); } catch (_e) {}
                }
            }
        }
        return { ok: true, events, errors, files: files.length, generatedAt: Date.now() };
    }

    globalThis.__agCollectTokenStats = collectTokenStats;

    function getLanguageServerModule() {
        if (globalThis.__agLsOverride) return globalThis.__agLsOverride;
        try { return require('./languageServer'); } catch (_e) { return null; }
    }

    function fetchQuota(forceRefresh) {
        return new Promise(resolve => {
            try {
                const ls = getLanguageServerModule();
                const base = ls && typeof ls.getLsBaseUrl === 'function' ? ls.getLsBaseUrl() : '';
                const csrf = ls && typeof ls.getLsCsrfToken === 'function' ? ls.getLsCsrfToken() : '';
                if (!base || !csrf) {
                    resolve({ ok: false, error: 'language server not ready' });
                    return;
                }
                const url = new URL('/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary', base);
                const isLocal = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
                if (!isLocal) {
                    resolve({ ok: false, error: 'language server is not local' });
                    return;
                }
                const mod = url.protocol === 'https:' ? require('https') : require('http');
                const body = JSON.stringify({ forceRefresh: Boolean(forceRefresh) });
                const req = mod.request(url, {
                    method: 'POST',
                    rejectUnauthorized: false,
                    timeout: 15000,
                    headers: {
                        'content-type': 'application/json',
                        'connect-protocol-version': '1',
                        'x-codeium-csrf-token': csrf,
                        'content-length': Buffer.byteLength(body)
                    }
                }, res => {
                    const chunks = [];
                    res.on('data', c => chunks.push(c));
                    res.on('end', () => {
                        const raw = Buffer.concat(chunks).toString('utf8');
                        if (res.statusCode !== 200) {
                            resolve({ ok: false, error: `HTTP ${res.statusCode}: ${raw.slice(0, 300)}` });
                            return;
                        }
                        try {
                            resolve({ ok: true, data: JSON.parse(raw), fetchedAt: Date.now() });
                        } catch (e) {
                            resolve({ ok: false, error: `bad JSON: ${e.message}` });
                        }
                    });
                    res.on('error', e => resolve({ ok: false, error: e.message }));
                });
                req.on('timeout', () => req.destroy(new Error('timeout')));
                req.on('error', e => resolve({ ok: false, error: e.message }));
                req.write(body);
                req.end();
            } catch (e) {
                resolve({ ok: false, error: String(e && e.message || e) });
            }
        });
    }

    globalThis.__agFetchQuota = fetchQuota;

    let electron = null;
    try { electron = require('electron'); } catch (_e) {}
    if (!electron || typeof electron !== 'object' || !electron.ipcMain) return;

    function writeDiag(line) {
        try {
            const dir = electron.app && typeof electron.app.getPath === 'function' ? electron.app.getPath('userData') : os.tmpdir();
            fs.appendFileSync(path.join(dir, 'ag-token-stats.log'), `${new Date().toISOString()} ${line}\n`);
        } catch (_e) {}
    }

    try {
        electron.ipcMain.removeHandler(CHANNEL);
        electron.ipcMain.handle(CHANNEL, () => {
            try {
                const res = collectTokenStats();
                writeDiag(`tokens ok files=${res.files || 0} events=${res.events.length} errors=${(res.errors || []).length}`);
                return res;
            } catch (e) {
                writeDiag(`tokens error ${e && e.message}`);
                return { ok: false, error: String(e && e.message || e), events: [], generatedAt: Date.now() };
            }
        });
        electron.ipcMain.removeHandler(QUOTA_CHANNEL);
        electron.ipcMain.handle(QUOTA_CHANNEL, async (_ev, opts) => {
            const res = await fetchQuota(opts && opts.forceRefresh);
            if (res.ok) {
                writeDiag(`quota ok ${JSON.stringify(res.data).slice(0, 600)}`);
            } else {
                writeDiag(`quota error ${res.error}`);
            }
            return res;
        });
        writeDiag('handlers registered');
    } catch (e) {
        writeDiag(`register failed ${e && e.message}`);
    }
})();
/* --- AG TOKEN STATS MAIN END --- */
