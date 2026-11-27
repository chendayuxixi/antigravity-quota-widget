/* --- AG QUOTA WIDGET START --- */
;(function initQuotaTokenWidget() {
    try {
        if (typeof window === 'undefined' || typeof document === 'undefined') return;
        if (window !== window.top) return;
        if (!/^https?:$/i.test(String(window.location && window.location.protocol || ''))) return;
        if (window.__agQuotaWidgetLoaded) return;
        let ipc = null;
        try { ipc = typeof require === 'function' ? require('electron').ipcRenderer : null; } catch (_e) {}
        if (!ipc || typeof ipc.invoke !== 'function') return;
        window.__agQuotaWidgetLoaded = true;

        const DAY_MS = 86400000;
        const PIN_KEY = '__ag_pinned_quota_bucket_v1';
        const NOTIFY_KEY = '__ag_notify_enabled_v1';

        function dateStr(ms) {
            const d = new Date(ms);
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        }

        let savedPin = 'auto';
        let savedNotify = true;
        try {
            const p = window.localStorage && window.localStorage.getItem(PIN_KEY);
            if (p) savedPin = p;
            const n = window.localStorage && window.localStorage.getItem(NOTIFY_KEY);
            if (n === '0' || n === 'false') savedNotify = false;
        } catch (_e) {}

        const state = {
            panelOpen: false,
            loading: false,
            events: [],
            latestContext: null,
            tokenError: '',
            tokensAt: 0,
            quota: null,
            quotaError: '',
            quotaAt: 0,
            pinnedBucket: savedPin,
            notifyEnabled: savedNotify,
            exportMsg: '',
            preset: 'today',
            startDate: dateStr(Date.now()),
            endDate: dateStr(Date.now())
        };

        const prevRunState = new Map();

        function setPinnedBucket(key) {
            state.pinnedBucket = key || 'auto';
            try { if (window.localStorage) window.localStorage.setItem(PIN_KEY, state.pinnedBucket); } catch (_e) {}
            renderWidget();
        }

        function toggleNotify() {
            state.notifyEnabled = !state.notifyEnabled;
            try { if (window.localStorage) window.localStorage.setItem(NOTIFY_KEY, state.notifyEnabled ? '1' : '0'); } catch (_e) {}
            if (state.notifyEnabled && typeof Notification === 'function' && Notification.permission === 'default') {
                try { Notification.requestPermission(); } catch (_e) {}
            }
            renderWidget();
        }

        function playChime(kind) {
            try {
                const AudioCtx = window.AudioContext || window.webkitAudioContext;
                if (!AudioCtx) return;
                const ctx = new AudioCtx();
                const notes = kind === 'wait' ? [523.25, 659.25, 523.25] : [587.33, 880.0];
                notes.forEach((freq, i) => {
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.type = 'sine';
                    osc.frequency.value = freq;
                    const t0 = ctx.currentTime + i * 0.13;
                    gain.gain.setValueAtTime(0.0001, t0);
                    gain.gain.exponentialRampToValueAtTime(0.12, t0 + 0.02);
                    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.24);
                    osc.connect(gain);
                    gain.connect(ctx.destination);
                    osc.start(t0);
                    osc.stop(t0 + 0.26);
                });
                setTimeout(() => { try { ctx.close(); } catch (_e) {} }, 800);
            } catch (_e) {}
        }

        function fireAlert(kind, title) {
            if (!state.notifyEnabled) return;
            playChime(kind);
            const heading = kind === 'wait' ? 'Antigravity 等待你的确认' : 'Antigravity 任务已完成';
            const body = title ? `对话：${title}` : (kind === 'wait' ? '有命令或操作需要你确认' : '可以回来查看结果了');
            try {
                if (typeof Notification === 'function') {
                    if (Notification.permission === 'granted') {
                        new Notification(heading, { body });
                    } else if (Notification.permission === 'default') {
                        Notification.requestPermission().then(p => {
                            if (p === 'granted') new Notification(heading, { body });
                        }).catch(() => {});
                    }
                }
            } catch (_e) {}
        }

        async function pollRunStatus() {
            if (!state.notifyEnabled) return;
            try {
                const res = await ipc.invoke('ag-status:get');
                if (!res || !res.ok || !Array.isArray(res.conversations)) return;
                for (const c of res.conversations) {
                    const prev = prevRunState.get(c.id);
                    if (prev) {
                        if (prev.running && !c.running && !c.waiting) {
                            fireAlert('done', c.title);
                            refresh(false);
                        } else if (!prev.waiting && c.waiting) {
                            fireAlert('wait', c.title);
                        }
                    }
                    prevRunState.set(c.id, { running: Boolean(c.running), waiting: Boolean(c.waiting) });
                }
            } catch (_e) {}
        }

        function fmtNum(n) {
            const v = Number(n) || 0;
            if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
            if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
            return String(Math.round(v));
        }
        function fmtFull(n) {
            return (Number(n) || 0).toLocaleString('en-US');
        }
        function fmtTime(ms) {
            return ms ? new Date(ms).toLocaleTimeString() : '--';
        }
        function fmtResetTime(resetTime) {
            if (!resetTime) return '';
            let ms = 0;
            if (typeof resetTime === 'string') ms = Date.parse(resetTime);
            else if (typeof resetTime === 'object' && resetTime.seconds !== undefined) ms = Number(resetTime.seconds) * 1000;
            if (!ms || Number.isNaN(ms)) return '';
            const diff = ms - Date.now();
            if (diff <= 0) return '即将重置';
            const mins = Math.floor(diff / 60000);
            const hrs = Math.floor(mins / 60);
            if (hrs >= 24) return `${Math.floor(hrs / 24)}天${hrs % 24}小时后重置`;
            return hrs > 0 ? `${hrs}小时${mins % 60}分后重置` : `${Math.max(1, mins)}分后重置`;
        }

        function extractQuotaGroups(data) {
            if (!data || typeof data !== 'object') return null;
            const groups = data.groups || (data.response && data.response.groups);
            if (!Array.isArray(groups)) return null;
            return groups.map(g => {
                const gName = g.displayName || '模型额度';
                return {
                    displayName: gName,
                    description: g.description || '',
                    buckets: (Array.isArray(g.buckets) ? g.buckets : []).map(b => {
                        let frac = b.remainingFraction;
                        if (frac === undefined && b.remaining && typeof b.remaining === 'object') {
                            frac = b.remaining.remainingFraction !== undefined ? b.remaining.remainingFraction : b.remaining.value;
                        }
                        frac = frac === undefined || frac === null ? null : Number(frac);
                        const bName = b.displayName || b.bucketId || '模型';
                        return {
                            key: b.bucketId || `${gName}::${bName}`,
                            bucketId: b.bucketId || '',
                            displayName: bName,
                            groupName: gName,
                            remainingFraction: frac === null || Number.isNaN(frac) ? null : Math.max(0, Math.min(1, frac)),
                            resetTime: b.resetTime || null,
                            description: b.description || '',
                            disabled: Boolean(b.disabled)
                        };
                    })
                };
            });
        }

        function rangeForPreset() {
            const now = Date.now();
            if (state.preset === 'today') return [dateStr(now), dateStr(now)];
            if (state.preset === '7d') return [dateStr(now - 6 * DAY_MS), dateStr(now)];
            if (state.preset === '30d') return [dateStr(now - 29 * DAY_MS), dateStr(now)];
            if (state.preset === 'all') return ['', ''];
            return [state.startDate || '', state.endDate || ''];
        }

        function filteredEvents() {
            const [start, end] = rangeForPreset();
            const list = [];
            for (const ev of state.events) {
                if (!ev || !ev.ts) continue;
                const d = dateStr(ev.ts);
                if (start && d < start) continue;
                if (end && d > end) continue;
                list.push(ev);
            }
            return { start, end, list };
        }

        function aggregate() {
            const { start, end, list } = filteredEvents();
            const total = { input: 0, cacheRead: 0, output: 0, gens: 0 };
            const byModel = new Map();
            const byConv = new Map();
            for (const ev of list) {
                total.input += ev.input || 0;
                total.cacheRead += ev.cacheRead || 0;
                total.output += ev.output || 0;
                total.gens += 1;
                const sum = (ev.input || 0) + (ev.cacheRead || 0) + (ev.output || 0);
                const m = byModel.get(ev.model) || { name: ev.model, total: 0, gens: 0 };
                m.total += sum; m.gens += 1; byModel.set(ev.model, m);
                const c = byConv.get(ev.conv) || { name: ev.title || ev.conv.slice(0, 8), total: 0, gens: 0 };
                c.total += sum; c.gens += 1; byConv.set(ev.conv, c);
            }
            const sortDesc = arr => arr.sort((a, b) => b.total - a.total);
            return { start, end, total, byModel: sortDesc([...byModel.values()]), byConv: sortDesc([...byConv.values()]).slice(0, 5) };
        }

        function csvCell(v) {
            const s = String(v === undefined || v === null ? '' : v);
            return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        }

        function buildCsvContent() {
            const { start, end, list } = filteredEvents();
            const header = ['日期', '时间', '对话标题', '对话ID', '模型', '输入(Input)', '缓存读取(CacheRead)', '输出(Output)', '总计(含缓存)', '净消耗(不含缓存)'];
            const rows = [header.map(csvCell).join(',')];
            for (const ev of list) {
                const d = new Date(ev.ts);
                const dt = dateStr(ev.ts);
                const tm = d.toTimeString().slice(0, 8);
                const inp = ev.input || 0;
                const cache = ev.cacheRead || 0;
                const out = ev.output || 0;
                rows.push([dt, tm, ev.title || '', ev.conv || '', ev.model || '', inp, cache, out, inp + cache + out, inp + out].map(csvCell).join(','));
            }
            const rangeTag = start || end ? `${start || 'start'}_${end || 'end'}` : 'all';
            return { filename: `antigravity-tokens-${rangeTag}.csv`, content: '\uFEFF' + rows.join('\r\n'), count: list.length };
        }

        function exportCsv() {
            try {
                const { filename, content, count } = buildCsvContent();
                if (typeof Blob === 'function' && window.URL && typeof window.URL.createObjectURL === 'function') {
                    const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
                    const url = window.URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.setAttribute('href', url);
                    a.setAttribute('download', filename);
                    a.style.display = 'none';
                    document.body.appendChild(a);
                    if (typeof a.click === 'function') a.click();
                    setTimeout(() => {
                        try { a.remove && a.remove(); } catch (_e) {}
                        try { window.URL.revokeObjectURL(url); } catch (_e) {}
                    }, 500);
                }
                state.exportMsg = `已导出 ${count} 条记录 (${filename})`;
                renderWidget();
                setTimeout(() => { state.exportMsg = ''; renderWidget(); }, 4000);
            } catch (e) {
                state.exportMsg = `导出失败：${e && e.message || e}`;
                renderWidget();
            }
        }

        async function refresh(forceQuota) {
            if (state.loading) return;
            state.loading = true;
            renderWidget();
            const [tok, quota] = await Promise.all([
                ipc.invoke('ag-token-stats:get').catch(e => ({ ok: false, error: String(e && e.message || e) })),
                ipc.invoke('ag-quota:get', { forceRefresh: Boolean(forceQuota) }).catch(e => ({ ok: false, error: String(e && e.message || e) }))
            ]);
            if (tok && tok.ok) {
                state.events = Array.isArray(tok.events) ? tok.events : [];
                state.latestContext = tok.latestContext || null;
                state.tokenError = '';
                state.tokensAt = tok.generatedAt || Date.now();
            } else {
                state.tokenError = /No handler registered/i.test(tok && tok.error || '')
                    ? '主进程统计模块未加载，请完全退出后重新运行安装脚本'
                    : `读取失败：${tok && tok.error || '未知错误'}`;
            }
            if (quota && quota.ok) {
                const groups = extractQuotaGroups(quota.data);
                if (groups) {
                    state.quota = groups;
                    state.quotaError = '';
                } else {
                    state.quotaError = '额度接口返回了未识别的数据格式';
                }
                state.quotaAt = quota.fetchedAt || Date.now();
            } else {
                state.quotaError = /No handler registered/i.test(quota && quota.error || '')
                    ? '主进程统计模块未加载，请完全退出后重新运行安装脚本'
                    : `获取失败：${quota && quota.error || '未知错误'}`;
            }
            state.loading = false;
            renderWidget();
        }

        function shortBucketLabel(b) {
            if (!b) return '额度';
            if (b.bucketId) {
                const id = String(b.bucketId);
                if (/gemini.*5h/i.test(id)) return 'Gemini 5h';
                if (/gemini.*week/i.test(id)) return 'Gemini 周';
                if (/claude.*5h/i.test(id)) return 'Claude 5h';
                if (/claude.*week/i.test(id)) return 'Claude 周';
                if (/gpt.*5h/i.test(id)) return 'GPT 5h';
                if (/gpt.*week/i.test(id)) return 'GPT 周';
                return id.length > 14 ? id.slice(0, 14) : id;
            }
            const full = b.groupName ? `${b.groupName} ${b.displayName}` : b.displayName;
            return full.length > 14 ? full.slice(0, 14) : full;
        }

        function activeQuotaBadge() {
            if (!state.quota) return { pct: null, label: '额度', title: '查看当前额度、上下文与 Token 消耗统计' };
            const all = [];
            for (const g of state.quota) for (const b of g.buckets) all.push(b);
            if (state.pinnedBucket && state.pinnedBucket !== 'auto') {
                const hit = all.find(b => b.key === state.pinnedBucket);
                if (hit && hit.remainingFraction !== null) {
                    const pct = Math.round(hit.remainingFraction * 100);
                    return { pct, label: shortBucketLabel(hit), title: `已固定显示：${hit.groupName} · ${hit.displayName} (${pct}%)` };
                }
            }
            let minB = null;
            for (const b of all) {
                if (!b.disabled && b.remainingFraction !== null && (!minB || b.remainingFraction < minB.remainingFraction)) minB = b;
            }
            if (!minB) return { pct: null, label: '额度', title: '查看当前额度、上下文与 Token 消耗统计' };
            const pct = Math.round(minB.remainingFraction * 100);
            return { pct, label: '额度', title: `当前自动显示最低额度：${minB.groupName} · ${minB.displayName} (${pct}%)` };
        }

        function contextPct() {
            const c = state.latestContext;
            if (!c || !c.limit) return null;
            return Math.min(100, Math.round((c.used / c.limit) * 100));
        }

        function colorForQuota(pct) {
            if (pct === null) return '#60a5fa';
            return pct < 10 ? '#ef4444' : (pct < 25 ? '#eab308' : '#22c55e');
        }

        function colorForCtx(pct) {
            if (pct === null) return '#60a5fa';
            return pct >= 90 ? '#ef4444' : (pct >= 75 ? '#eab308' : '#22c55e');
        }

        function el(tag, attrs, children) {
            const node = document.createElement(tag);
            if (attrs) for (const [k, v] of Object.entries(attrs)) {
                if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
                else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
                else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, String(v));
            }
            const list = Array.isArray(children) ? children : (children === undefined || children === null ? [] : [children]);
            for (const c of list) if (c !== null && c !== undefined && c !== false) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
            return node;
        }

        function ensureStyles() {
            if (document.getElementById('ag-quota-widget-style')) return;
            const style = document.createElement('style');
            style.id = 'ag-quota-widget-style';
            style.textContent = `
#ag-quota-root{position:fixed;right:16px;bottom:16px;z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;font-size:12px;color:#e5e7eb}
#ag-quota-btn{display:inline-flex;align-items:center;gap:6px;padding:6px 11px;border-radius:999px;border:1px solid rgba(255,255,255,.16);background:rgba(24,24,27,.9);color:#f4f4f5;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35)}
#ag-quota-btn:hover{border-color:rgba(96,165,250,.7)}
#ag-quota-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
#ag-quota-panel{position:absolute;right:0;bottom:42px;width:370px;max-height:74vh;overflow-y:auto;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:rgba(24,24,27,.97);box-shadow:0 12px 32px rgba(0,0,0,.5);padding:12px 14px}
.agq-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,.08);font-weight:600;font-size:13px}
.agq-sec{margin-bottom:14px}
.agq-title{font-size:11px;color:#a1a1aa;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;gap:6px}
.agq-row{margin-bottom:6px;padding:5px 7px;border-radius:8px;border:1px solid transparent;cursor:pointer;transition:background .15s ease,border-color .15s ease}
.agq-row:hover{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.12)}
.agq-row.pinned{background:rgba(59,130,246,.14);border-color:rgba(96,165,250,.55)}
.agq-pin{font-size:10px;color:#93c5fd;margin-left:5px}
.agq-rowtop{display:flex;justify-content:space-between;gap:8px;margin-bottom:3px}
.agq-bar{height:5px;border-radius:999px;background:rgba(255,255,255,.1);overflow:hidden}
.agq-fill{height:100%;border-radius:999px}
.agq-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.agq-card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:8px;padding:7px 9px}
.agq-card.wide{grid-column:span 2}
.agq-k{font-size:10px;color:#a1a1aa}
.agq-v{font-size:14px;font-weight:600;margin-top:2px;font-variant-numeric:tabular-nums}
.agq-sub{font-size:10px;color:#71717a;margin-top:1px;font-variant-numeric:tabular-nums}
.agq-link{background:none;border:none;color:#60a5fa;cursor:pointer;font-size:11px;padding:0;margin-left:8px}
.agq-link:disabled{color:#71717a;cursor:default}
.agq-filters{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;align-items:center}
.agq-pill{border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#d4d4d8;border-radius:6px;padding:2px 7px;font-size:11px;cursor:pointer}
.agq-pill.active{background:rgba(59,130,246,.28);border-color:#60a5fa;color:#fff}
.agq-dates{display:flex;align-items:center;gap:4px;width:100%;margin-top:2px}
.agq-date{flex:1;min-width:0;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);color:#e5e7eb;border-radius:6px;padding:2px 5px;font-size:11px;color-scheme:dark}
.agq-list{margin-top:8px}
.agq-li{display:flex;justify-content:space-between;gap:8px;padding:3px 0;border-bottom:1px dashed rgba(255,255,255,.06)}
.agq-li span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agq-muted{color:#a1a1aa;line-height:1.5}
.agq-err{color:#fca5a5;line-height:1.5}
.agq-warn{color:#fde047;font-size:11px;margin-top:4px}
.agq-ok{color:#86efac;font-size:11px;margin-top:4px}
`;
            (document.head || document.documentElement).appendChild(style);
        }

        function renderContext(panel) {
            const c = state.latestContext;
            if (!c || !c.limit) return;
            const pct = contextPct();
            const sec = el('div', { class: 'agq-sec', id: 'agq-ctx-sec' }, [
                el('div', { class: 'agq-title' }, [
                    el('span', null, '当前上下文窗口'),
                    el('span', null, c.model || '')
                ]),
                el('div', { class: 'agq-card' }, [
                    el('div', { class: 'agq-rowtop' }, [
                        el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, c.title || (c.conv ? c.conv.slice(0, 8) : '当前对话')),
                        el('span', { style: { color: colorForCtx(pct), fontWeight: '600', flexShrink: '0' } }, `${fmtNum(c.used)} / ${fmtNum(c.limit)} (${pct}%)`)
                    ]),
                    el('div', { class: 'agq-bar' }, [
                        el('div', { class: 'agq-fill', style: { width: `${pct}%`, background: colorForCtx(pct) } })
                    ]),
                    pct >= 80 ? el('div', { class: 'agq-warn' }, '上下文已超 80%，建议使用 /compact 压缩或新建对话。') : null
                ])
            ]);
            panel.appendChild(sec);
        }

        function renderQuota(panel) {
            const isPinned = state.pinnedBucket && state.pinnedBucket !== 'auto';
            const sec = el('div', { class: 'agq-sec' }, [
                el('div', { class: 'agq-title' }, [
                    el('span', null, '当前模型额度（点击条目可固定显示）'),
                    el('span', null, [
                        isPinned ? el('button', {
                            class: 'agq-link',
                            id: 'agq-pin-auto',
                            type: 'button',
                            style: { marginLeft: '0', marginRight: '6px' },
                            onClick: () => setPinnedBucket('auto')
                        }, '恢复自动最低') : null,
                        el('span', null, `更新 ${fmtTime(state.quotaAt)}`)
                    ])
                ])
            ]);
            if (state.quota && state.quota.length > 0) {
                let rows = 0;
                for (const g of state.quota) for (const b of g.buckets) {
                    const pct = b.remainingFraction === null ? null : Math.round(b.remainingFraction * 100);
                    const reset = fmtResetTime(b.resetTime);
                    const pinned = state.pinnedBucket === b.key;
                    const labelText = g.buckets.length > 1 || !g.displayName ? `${g.displayName} · ${b.displayName}` : b.displayName;
                    sec.appendChild(el('div', {
                        class: 'agq-row' + (pinned ? ' pinned' : ''),
                        'data-bucket-key': b.key,
                        title: (pinned ? '点击取消固定，恢复自动显示最低额度' : '点击固定此额度到右下角悬浮按钮') + (b.description ? '\n' + b.description : ''),
                        onClick: () => setPinnedBucket(pinned ? 'auto' : b.key)
                    }, [
                        el('div', { class: 'agq-rowtop' }, [
                            el('span', null, [labelText, pinned ? el('span', { class: 'agq-pin' }, '★ 已固定') : null]),
                            el('span', { style: { color: '#d4d4d8', flexShrink: '0' } }, `${pct === null ? '--' : pct + '%'}${reset ? ' · ' + reset : ''}`)
                        ]),
                        el('div', { class: 'agq-bar' }, [el('div', { class: 'agq-fill', style: { width: `${pct === null ? 0 : pct}%`, background: colorForQuota(pct) } })])
                    ]));
                    rows++;
                }
                if (rows === 0) sec.appendChild(el('div', { class: 'agq-muted' }, '当前账号没有返回任何额度分组。'));
            }
            if (state.quotaError) sec.appendChild(el('div', { class: 'agq-err' }, state.quotaError));
            if (!state.quota && !state.quotaError) sec.appendChild(el('div', { class: 'agq-muted' }, state.loading ? '正在获取…' : '暂无数据'));
            panel.appendChild(sec);
        }

        function renderTokens(panel) {
            const sec = el('div', { class: 'agq-sec', style: { marginBottom: '4px' } }, [
                el('div', { class: 'agq-title' }, [
                    el('span', null, 'Token 消耗统计'),
                    el('span', null, [
                        el('button', {
                            class: 'agq-link',
                            id: 'agq-export-csv',
                            type: 'button',
                            style: { marginLeft: '0', marginRight: '6px' },
                            onClick: exportCsv
                        }, '导出 CSV'),
                        el('span', null, `更新 ${fmtTime(state.tokensAt)}`)
                    ])
                ])
            ]);
            const presets = [['today', '今天'], ['7d', '近7天'], ['30d', '近30天'], ['all', '全部'], ['custom', '自定义']];
            const bar = el('div', { class: 'agq-filters' }, presets.map(([id, label]) => el('button', {
                type: 'button',
                class: 'agq-pill' + (state.preset === id ? ' active' : ''),
                'data-preset': id,
                onClick: () => {
                    if (id === 'custom' && state.preset !== 'custom') {
                        const [s, e] = rangeForPreset();
                        state.startDate = s || dateStr(Date.now());
                        state.endDate = e || dateStr(Date.now());
                    }
                    state.preset = id;
                    renderWidget();
                }
            }, label)));
            if (state.preset === 'custom') {
                bar.appendChild(el('div', { class: 'agq-dates' }, [
                    el('input', { type: 'date', class: 'agq-date', value: state.startDate, onChange: e => { state.startDate = e.target.value; renderWidget(); } }),
                    el('span', { class: 'agq-muted' }, '至'),
                    el('input', { type: 'date', class: 'agq-date', value: state.endDate, onChange: e => { state.endDate = e.target.value; renderWidget(); } })
                ]));
            }
            sec.appendChild(bar);
            if (state.exportMsg) sec.appendChild(el('div', { class: 'agq-ok' }, state.exportMsg));

            if (state.tokenError) {
                sec.appendChild(el('div', { class: 'agq-err' }, state.tokenError));
                panel.appendChild(sec);
                return;
            }
            const agg = aggregate();
            const t = agg.total;
            const all = t.input + t.cacheRead + t.output;
            const card = (k, v, sub, wide) => el('div', { class: 'agq-card' + (wide ? ' wide' : '') }, [
                el('div', { class: 'agq-k' }, k), el('div', { class: 'agq-v' }, v), sub ? el('div', { class: 'agq-sub' }, sub) : null
            ]);
            sec.appendChild(el('div', { class: 'agq-grid', id: 'agq-token-grid' }, [
                card('总计（输入 + 缓存读取 + 输出）', fmtNum(all), `${fmtFull(all)} tokens · ${t.gens} 次生成`, true),
                card('输入', fmtNum(t.input), fmtFull(t.input)),
                card('输出', fmtNum(t.output), fmtFull(t.output)),
                card('缓存读取', fmtNum(t.cacheRead), fmtFull(t.cacheRead)),
                card('不含缓存（输入 + 输出）', fmtNum(t.input + t.output), fmtFull(t.input + t.output))
            ]));
            if (t.gens === 0) {
                sec.appendChild(el('div', { class: 'agq-muted', style: { marginTop: '6px' } }, state.loading && state.events.length === 0 ? '正在读取…' : '所选时段内没有记录。'));
            }
            if (agg.byModel.length > 0) {
                sec.appendChild(el('div', { class: 'agq-list' }, [el('div', { class: 'agq-title' }, '按模型')].concat(
                    agg.byModel.map(m => el('div', { class: 'agq-li' }, [el('span', null, m.name), el('span', null, `${fmtNum(m.total)} · ${m.gens}次`)])))));
            }
            if (agg.byConv.length > 0) {
                sec.appendChild(el('div', { class: 'agq-list' }, [el('div', { class: 'agq-title' }, '按对话（前 5）')].concat(
                    agg.byConv.map(c => el('div', { class: 'agq-li', title: c.name }, [el('span', null, c.name), el('span', null, `${fmtNum(c.total)} · ${c.gens}次`)])))));
            }
            sec.appendChild(el('div', { class: 'agq-sub', style: { marginTop: '8px' } }, '数据来自本机全部对话记录，按每次生成的时间筛选。'));
            panel.appendChild(sec);
        }

        function renderWidget() {
            if (!document.body) return;
            ensureStyles();
            let root = document.getElementById('ag-quota-root');
            if (!root) {
                root = el('div', { id: 'ag-quota-root', translate: 'no', class: 'notranslate' });
                document.body.appendChild(root);
            }
            const prevScroll = (document.getElementById('ag-quota-panel') || {}).scrollTop || 0;
            root.textContent = '';
            const badge = activeQuotaBadge();
            const ctxP = contextPct();
            const parts = [];
            if (ctxP !== null) parts.push(`上下文 ${ctxP}%`);
            parts.push(badge.pct === null ? '额度' : `${badge.label} ${badge.pct}%`);
            parts.push('Token');
            root.appendChild(el('button', {
                id: 'ag-quota-btn',
                type: 'button',
                title: badge.title + (ctxP !== null ? `\n当前上下文占用：${ctxP}%` : ''),
                onClick: () => {
                    state.panelOpen = !state.panelOpen;
                    renderWidget();
                    if (state.panelOpen) refresh(false);
                }
            }, [
                el('span', { id: 'ag-quota-dot', style: { background: colorForQuota(badge.pct) } }),
                el('span', null, parts.join(' · '))
            ]));
            if (!state.panelOpen) return;
            const panel = el('div', { id: 'ag-quota-panel' }, [
                el('div', { class: 'agq-hdr' }, [
                    el('span', null, '额度 · 上下文 · Token'),
                    el('span', null, [
                        el('button', {
                            class: 'agq-link',
                            id: 'agq-notify-toggle',
                            type: 'button',
                            title: '任务完成或等待确认时播放提示音并发送桌面通知',
                            onClick: toggleNotify
                        }, state.notifyEnabled ? '🔔提醒开' : '🔕提醒关'),
                        el('button', {
                            class: 'agq-link',
                            id: 'agq-test-chime',
                            type: 'button',
                            title: '试听完成提示音',
                            onClick: () => playChime('done')
                        }, '试听'),
                        el('button', { class: 'agq-link', type: 'button', id: 'agq-refresh', disabled: state.loading, onClick: () => refresh(true) }, state.loading ? '刷新中…' : '刷新'),
                        el('button', { class: 'agq-link', type: 'button', onClick: () => { state.panelOpen = false; renderWidget(); } }, '收起')
                    ])
                ])
            ]);
            renderContext(panel);
            renderQuota(panel);
            renderTokens(panel);
            root.appendChild(panel);
            panel.scrollTop = prevScroll;
        }

        const boot = () => {
            renderWidget();
            setTimeout(() => { refresh(false); pollRunStatus(); }, 1500);
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
        else boot();
        setInterval(() => {
            if (!document.getElementById('ag-quota-root')) renderWidget();
            if (state.panelOpen) refresh(false);
        }, 60000);
        setInterval(pollRunStatus, 4000);
        window.__agQuotaWidgetRefresh = refresh;
        window.__agQuotaWidgetBuildCsv = buildCsvContent;
    } catch (_e) {}
})();
/* --- AG QUOTA WIDGET END --- */
