#!/usr/bin/env node
/**
 * Antigravity 2.0 Quota & Token Widget Installer / Uninstaller
 *
 * Usage:
 *   node install.js                        # Install widget
 *   node install.js --uninstall            # Remove widget (preserves other patches)
 *   node install.js --install-dir <path>   # Specify Antigravity install directory
 *   node install.js --no-kill              # Do not terminate running Antigravity processes
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const child_process = require('child_process');
const { patchAsarArchive, readAsarLayout } = require('./src/asar_patcher');

const MAIN_START = '/* --- AG TOKEN STATS MAIN START --- */';
const MAIN_END = '/* --- AG TOKEN STATS MAIN END --- */';
const WIDGET_START = '/* --- AG QUOTA WIDGET START --- */';
const WIDGET_END = '/* --- AG QUOTA WIDGET END --- */';

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripBlock(content, startMark, endMark) {
    const re = new RegExp('(?:\\r?\\n;)?\\r?\\n?' + escapeRegExp(startMark) + '[\\s\\S]*?' + escapeRegExp(endMark), 'g');
    return content.replace(re, '');
}

function parseArgs(argv) {
    let uninstall = false;
    let noKill = false;
    let installDir = null;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--uninstall' || a === '--remove') uninstall = true;
        else if (a === '--no-kill') noKill = true;
        else if (a === '--install-dir' && argv[i + 1]) installDir = argv[++i];
        else if (a.startsWith('--install-dir=')) installDir = a.slice('--install-dir='.length);
    }
    return { uninstall, noKill, installDir };
}

function findResourcesDir(manualDir) {
    const candidates = [];
    if (manualDir) {
        const p = path.resolve(manualDir);
        candidates.push(p, path.join(p, 'resources'), path.join(p, 'Contents', 'Resources'));
    } else if (process.platform === 'win32') {
        if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'antigravity', 'resources'));
        if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'Antigravity', 'resources'));
        candidates.push('C:\\Program Files\\Antigravity\\resources');
    } else if (process.platform === 'darwin') {
        candidates.push('/Applications/Antigravity.app/Contents/Resources');
        candidates.push(path.join(os.homedir(), 'Applications', 'Antigravity.app', 'Contents', 'Resources'));
    } else {
        candidates.push('/opt/antigravity/resources', '/usr/lib/antigravity/resources', '/usr/share/antigravity/resources');
    }
    for (const dir of candidates) {
        if (fs.existsSync(path.join(dir, 'app.asar'))) return dir;
    }
    return null;
}

function closeAntigravityIfWindows() {
    if (process.platform !== 'win32') return;
    try {
        const out = child_process.execSync('tasklist /fi "imagename eq Antigravity.exe" /nh', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        if (out.toLowerCase().includes('antigravity.exe')) {
            console.log('[进程] 检测到 Antigravity.exe 正在运行，正在关闭以解除 app.asar 锁定...');
            try { child_process.execSync('taskkill /im Antigravity.exe /f >nul 2>nul'); } catch (_e) {}
            const end = Date.now() + 3000;
            while (Date.now() < end) {}
        }
    } catch (_e) {}
}

function main() {
    const { uninstall, noKill, installDir } = parseArgs(process.argv.slice(2));
    const resourcesDir = findResourcesDir(installDir);
    if (!resourcesDir) {
        console.error('[错误] 未找到 Antigravity 安装目录下的 resources/app.asar，请使用 --install-dir 手动指定。');
        process.exit(1);
    }

    if (!noKill) closeAntigravityIfWindows();

    const asarPath = path.join(resourcesDir, 'app.asar');
    const mainSnippet = fs.readFileSync(path.join(__dirname, 'src', 'token_stats_main.js'), 'utf8');
    const widgetSnippet = fs.readFileSync(path.join(__dirname, 'src', 'widget_preload.js'), 'utf8');

    const buildDir = fs.mkdtempSync(path.join(resourcesDir, '.ag-quota-widget-'));
    try {
        const sourceCopy = path.join(buildDir, 'source.asar');
        const candidatePath = path.join(buildDir, 'candidate.asar');
        fs.copyFileSync(asarPath, sourceCopy);

        const modifierMap = new Map([
            ['dist/main.js', content => {
                const cleaned = stripBlock(content, MAIN_START, MAIN_END);
                return uninstall ? cleaned : `${cleaned}\n${mainSnippet}`;
            }],
            ['dist/preload.js', content => {
                const cleaned = stripBlock(content, WIDGET_START, WIDGET_END);
                return uninstall ? cleaned : `${cleaned}\n;\n${widgetSnippet}`;
            }]
        ]);

        console.log(uninstall ? '[卸载] 正在移除额度与 Token 统计悬浮插件...' : '[安装] 正在注入额度与 Token 统计悬浮插件...');
        const modified = patchAsarArchive(sourceCopy, candidatePath, modifierMap);
        if (!modified.has('dist/main.js') || !modified.has('dist/preload.js')) {
            throw new Error('未在 app.asar 中找到 dist/main.js 或 dist/preload.js');
        }

        // Syntax check modified files
        for (const [relPath, buf] of modified.entries()) {
            const checkPath = path.join(buildDir, path.basename(relPath));
            fs.writeFileSync(checkPath, buf);
            child_process.execFileSync(process.execPath, ['--check', checkPath], { stdio: 'pipe' });
        }

        // Validate candidate ASAR readable
        readAsarLayout(candidatePath);

        // Replace app.asar atomically
        fs.renameSync(candidatePath, asarPath);
        console.log(uninstall ? '[√] 卸载完成！请重新启动 Antigravity。' : '[√] 安装完成！请重新启动 Antigravity 查看右下角「额度 & Token」按钮。');
    } catch (err) {
        console.error(`[错误] 操作失败（未修改原始 app.asar）: ${err.message}`);
        process.exit(1);
    } finally {
        try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch (_e) {}
    }
}

if (require.main === module) {
    main();
}
