/* global activeDocument */
import {
    ItemView,
    Menu,
    Notice,
    Plugin,
    TAbstractFile,
    TFile,
    WorkspaceLeaf,
    ViewStateResult,
} from 'obsidian';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as child_process from 'child_process';

import { disassemble, assemble } from 'es-hangul';
import { parseGhosttyConfig, GhosttyConfig, GhosttyKeybind } from './src/ghostty-config';
import { GhosttySettingTab, GhosttyTerminalSettings, DEFAULT_SETTINGS } from './src/settings';

import ptyHelperCode from './pty_helper.py';

const VIEW_TYPE_GHOSTTY = 'ghostty-terminal';

/** Returns the first path in the list that exists on the filesystem. Falls back to the last entry. */
function resolveFirstExisting(candidates: string[]): string {
    const filtered = candidates.filter(p => p.length > 0);
    for (const p of filtered) {
        try { if (fs.existsSync(p)) return p; } catch { /* skip */ }
    }
    return filtered[filtered.length - 1] ?? '/bin/sh';
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export default class GhosttyTerminalPlugin extends Plugin {
    settings: GhosttyTerminalSettings;
    ghosttyConfig: GhosttyConfig;

    async onload() {
        // 1. Load settings
        await this.loadSettings();

        // 2. Parse Ghostty config once at boot
        this.ghosttyConfig = parseGhosttyConfig(
            this.settings.ghosttyConfigPaths.length > 0 ? this.settings.ghosttyConfigPaths : undefined
        );

        // 4. Register view
        this.registerView(VIEW_TYPE_GHOSTTY, (leaf) => new GhosttyTerminalView(leaf, this));

        // 5. Ribbon icon
        this.addRibbonIcon('terminal', 'Open terminal', () => this.activateView());

        // 6. Commands
        this.addCommand({
            id: 'open',
            name: 'Open terminal',
            callback: () => this.activateView(),
        });

        this.addCommand({
            id: 'open-split',
            name: 'Open terminal in new split',
            callback: () => this.activateView(true, 'split'),
        });

        // 7. Context menu on file explorer
        this.registerEvent(
            this.app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => {
                const targetPath = file instanceof TFile
                    ? path.dirname(file.path)
                    : file.path; // TFolder

                menu.addItem((item) =>
                    item
                        .setTitle('Open terminal here')
                        .setIcon('terminal')
                        .onClick(() => this.activateViewAt(targetPath))
                );
            })
        );

        // 8. Settings tab
        this.addSettingTab(new GhosttySettingTab(this.app, this));
    }

    onunload() {
        // Kill all pty processes in active terminal views
        this.app.workspace.getLeavesOfType(VIEW_TYPE_GHOSTTY).forEach((leaf) => {
            const view = leaf.view as GhosttyTerminalView;
            view.killPty();
        });
    }

    async loadSettings() {
        const raw = await this.loadData() as Record<string, unknown> | null;
        const data = raw ?? {};

        // Migrate legacy single-string fields to arrays
        const legacyShell = data['defaultShell'] as string | undefined;
        const legacyConfig = data['ghosttyConfigPath'] as string | undefined;
        if (!data['shellPaths'] && legacyShell) {
            data['shellPaths'] = [legacyShell];
            delete data['defaultShell'];
        }
        if (!data['ghosttyConfigPaths'] && legacyConfig) {
            data['ghosttyConfigPaths'] = [legacyConfig];
            delete data['ghosttyConfigPath'];
        }

        this.settings = Object.assign({}, DEFAULT_SETTINGS, data) as GhosttyTerminalSettings;
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    private getNewLeaf(location: string): WorkspaceLeaf {
        switch (location) {
            case 'left':
                return this.app.workspace.getLeftLeaf(false)!;
            case 'tab':
                return this.app.workspace.getLeaf('tab');
            case 'split':
                return this.app.workspace.getLeaf('split');
            case 'window':
                return this.app.workspace.getLeaf('window');
            case 'right':
            default:
                return this.app.workspace.getRightLeaf(false)!;
        }
    }

    /** Open (or focus) a terminal. */
    async activateView(forceNew = false, locationOverride?: string) {
        const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_GHOSTTY);

        if (!forceNew && existing.length > 0) {
            void this.app.workspace.revealLeaf(existing[0]);
            return;
        }

        const location = locationOverride || this.settings.defaultLocation;
        const leaf = this.getNewLeaf(location);
        await leaf.setViewState({ type: VIEW_TYPE_GHOSTTY, active: true });
        void this.app.workspace.revealLeaf(leaf);
    }

    /** Open a terminal seeded with a specific vault-relative cwd. */
    async activateViewAt(vaultRelativePath: string) {
        const leaf = this.getNewLeaf(this.settings.defaultLocation);
        await leaf.setViewState({
            type: VIEW_TYPE_GHOSTTY,
            active: true,
            state: { cwd: vaultRelativePath },
        });
        void this.app.workspace.revealLeaf(leaf);
    }
}

// ─── View ─────────────────────────────────────────────────────────────────────

const CHAR_MEASURE_ID = 'ghostty-char-measure';

class GhosttyTerminalView extends ItemView {
    private terminal: Terminal | null = null;
    private fitAddon: FitAddon | null = null;
    private ptyProcess: child_process.ChildProcess | null = null;
    private resizePipe: import('stream').Writable | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private resizeFollowUpId: number | null = null;
    private isComposing = false;
    private charWidth = 9;
    private charHeight = 18;
    private termEl: HTMLElement | null = null;
    private ptyAlive = false;
    private lastKoreanSent = { data: '', time: 0 };
    private restartBtn: HTMLElement | null = null;
    private cwdOverride: string | null = null;

    constructor(leaf: WorkspaceLeaf, private plugin: GhosttyTerminalPlugin) {
        super(leaf);
    }

    getViewType(): string { return VIEW_TYPE_GHOSTTY; }
    getDisplayText(): string { return 'Ghostty'; }
    getIcon(): string { return 'terminal'; }

    /** Called by Obsidian when this view is re-opened with saved state */
    setState(state: Record<string, unknown>, result: ViewStateResult): Promise<void> {
        if (state && typeof state.cwd === 'string') {
            this.cwdOverride = state.cwd;
        }
        return super.setState(state, result);
    }

    async onOpen() {
        try {
            await Promise.resolve();
            const container = this.containerEl.children[1] as HTMLElement;
            if (!container) return;
            container.empty();
            container.addClass('ghostty-container');

            // Build a wrapper that fills the pane
            const wrapper = container.createDiv({ cls: 'ghostty-wrapper' });

            // Status bar for errors/restart
            wrapper.createDiv({ cls: 'ghostty-status-bar ghostty-hidden' });
            this.restartBtn = wrapper.createDiv({ cls: 'ghostty-restart-btn ghostty-hidden' });
            this.restartBtn.setText('Restart shell');
            this.restartBtn.onclick = () => this.spawnPty();

            this.termEl = wrapper.createDiv({ cls: 'ghostty-term' });

            // Measure char dimensions first so we pass correct cols/rows to PTY
            this.measureCharDimensions();

            this.initTerminal();

            // Defer spawnPty so that Obsidian's setState() runs first.
            window.setTimeout(() => { if (this.terminal) this.spawnPty(); }, 0);

            this.resizeObserver = new ResizeObserver(() => this.handleResize());
            this.resizeObserver.observe(this.termEl);
        } catch (err) {
            console.error('[GhosttyTerminal] Error during view onOpen:', err);
        }
    }

    // ── Terminal init ──────────────────────────────────────────────────────────

    private initTerminal() {
        const gc = this.plugin.ghosttyConfig;
        const s = this.plugin.settings;

        const fontFamily = s.fontFamilyOverride || gc.fontFamily || 'Menlo, Monaco, "Courier New", "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", monospace';
        const fontSize = s.fontSizeOverride > 0 ? s.fontSizeOverride : (gc.fontSize ?? 13);
        const scrollback = gc.scrollback ?? s.scrollbackLines;

        const theme: Record<string, string> = {
            background: gc.colors.background ?? '#1e1e2e',
            foreground: gc.colors.foreground ?? '#cdd6f4',
            cursor: gc.colors.cursor ?? '#f5e0dc',
            selectionBackground: gc.colors.selectionBackground ?? '#4e9cd6',
            selectionForeground: gc.colors.selectionForeground ?? '#ffffff',
            black: gc.colors.black ?? '#45475a',
            red: gc.colors.red ?? '#f38ba8',
            green: gc.colors.green ?? '#a6e3a1',
            yellow: gc.colors.yellow ?? '#f9e2af',
            blue: gc.colors.blue ?? '#89b4fa',
            magenta: gc.colors.magenta ?? '#f5c2e7',
            cyan: gc.colors.cyan ?? '#94e2d5',
            white: gc.colors.white ?? '#bac2de',
            brightBlack: gc.colors.brightBlack ?? '#585b70',
            brightRed: gc.colors.brightRed ?? '#f38ba8',
            brightGreen: gc.colors.brightGreen ?? '#a6e3a1',
            brightYellow: gc.colors.brightYellow ?? '#f9e2af',
            brightBlue: gc.colors.brightBlue ?? '#89b4fa',
            brightMagenta: gc.colors.brightMagenta ?? '#f5c2e7',
            brightCyan: gc.colors.brightCyan ?? '#94e2d5',
            brightWhite: gc.colors.brightWhite ?? '#a6adc8',
        };

        this.terminal = new Terminal({
            fontSize,
            fontFamily,
            theme,
            scrollback,
            cursorStyle: gc.cursorStyle ?? 'block',
            cursorBlink: gc.cursorBlink ?? false,
            lineHeight: 1,
            letterSpacing: 0,
            customGlyphs: true,
            ...( { unicodeVersion: '11' } as object ),
            ...( { ligatures: s.ligatures } as object ),
        });

        try {
            this.terminal.unicode.activeVersion = '11';
        } catch (e) {
            console.warn('[GhosttyTerminal] Failed to activate Unicode 11:', e);
        }

        this.fitAddon = new FitAddon();
        this.terminal.loadAddon(this.fitAddon);

        this.terminal.open(this.termEl!);

        // Asynchronously activate WebGL renderer to avoid startup blocking
        window.setTimeout(() => {
            if (!this.terminal) return;

            try {
                const webglAddon = new WebglAddon();
                webglAddon.onContextLoss(() => {
                    try {
                        webglAddon.dispose();
                    } catch {
                        /* ignore */
                    }
                });
                this.terminal.loadAddon(webglAddon);
            } catch (e) {
                console.warn('[GhosttyTerminal] WebGL addon initialization failed, fallback to Canvas renderer:', e);
            }
        }, 50);

        // Sync container background with theme to avoid a dark fringe around the terminal
        const container = this.containerEl.children[1] as HTMLElement;
        if (container) container.style.background = theme.background;

        // Build the full keybind list: Ghostty defaults + user config.
        // User config entries override defaults for the same key combo.
        const effectiveKeybinds = buildEffectiveKeybinds(this.plugin.ghosttyConfig.keybinds);

        // compositionstart: capture phase so isComposing is set before any child handler
        this.termEl!.addEventListener('compositionstart', () => {
            this.isComposing = true;
        }, true);
        // compositionend: bubble phase so xterm.js's textarea handler runs first,
        // then we reset isComposing and apply any deferred resize.
        this.termEl!.addEventListener('compositionend', () => {
            this.isComposing = false;
            window.setTimeout(() => {
                if (this.fitAddon) { this.fitAddon.fit(); this.sendResizeToPty(); }
            }, 0);
        });

        // Intercept keybinds in capture phase so Obsidian's global handlers
        // never see the key events meant for the terminal.
        this.termEl!.addEventListener('keydown', (e: KeyboardEvent) => {
            const match = findKeybind(e, effectiveKeybinds);
            if (!match) return;

            const action = match.action;

            if (action === 'copy_to_clipboard') {
                e.preventDefault();
                e.stopImmediatePropagation();
                const text = this.terminal?.getSelection() ?? '';
                if (text) navigator.clipboard.writeText(text).catch(() => {/* ignore */});

            } else if (action === 'paste_from_clipboard') {
                e.preventDefault();
                e.stopImmediatePropagation();
                navigator.clipboard.readText().then(text => {
                    if (this.ptyAlive && this.ptyProcess?.stdin && text) {
                        this.ptyProcess.stdin.write(text, 'utf8');
                    }
                }).catch(() => {/* ignore */});

            } else if (action.startsWith('text:')) {
                e.preventDefault();
                e.stopImmediatePropagation();
                const raw = action.slice(5);
                const text = unescapeGhosttyText(raw);
                if (this.ptyAlive && this.ptyProcess?.stdin) {
                    this.ptyProcess.stdin.write(text, 'utf8');
                }

            } else {
                // Action we can't implement (new_tab, new_window, etc.) —
                // block Obsidian from stealing the key but let ghostty-web handle it.
                e.stopPropagation();
            }
        }, { capture: true });

        // Try to rely on the FitAddon rather than calculating char dimensions manually
        this.fitAddon.fit();

        // Re-measure now that font is applied (canvas measurement is more accurate)
        this.measureCharDimensions();
    }

    // ── PTY spawn / recovery (Python-based, no native addons) ─────────────────

    private spawnPty() {
        // Kill previous process
        if (this.ptyProcess) {
            this.killPty();
        }

        const gc = this.plugin.ghosttyConfig;
        const s = this.plugin.settings;

        const shell = resolveFirstExisting(
            [
                ...s.shellPaths,
                ...(gc.shell ? [gc.shell] : []),
                process.env.SHELL ?? '',
                process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh',
            ]
        );

        // Resolve cwd
        const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string, getFullPath?: (p: string) => string };
        const vaultRoot = adapter.getBasePath?.() ?? os.homedir();
        const cwd = this.cwdOverride ? path.join(vaultRoot, this.cwdOverride) : vaultRoot;

        // Locate our bundled Python helper
        // manifest.dir is vault-relative (e.g. ".obsidian/plugins/ghostty-terminal")
        const pluginVaultDir: string | undefined = this.plugin.manifest.dir;
        const helperPath = pluginVaultDir
            ? adapter.getFullPath?.(`${pluginVaultDir}/pty_helper.py`) ??
            path.join(vaultRoot, pluginVaultDir, 'pty_helper.py')
            : path.join(__dirname, 'pty_helper.py');

        // Write the bundled python helper to the helper path if it is missing or different
        try {
            if (!fs.existsSync(helperPath) || fs.readFileSync(helperPath, 'utf8') !== ptyHelperCode) {
                fs.writeFileSync(helperPath, ptyHelperCode, { encoding: 'utf8', mode: 0o755 });
            }
        } catch (e: unknown) {
            const msg = `Failed to write pty_helper.py to ${helperPath} - ${e instanceof Error ? e.message : String(e)}`;
            this.terminal?.write(`\x1b[31m${msg}\x1b[0m\r\n`);
            this.restartBtn?.removeClass('ghostty-hidden');
            new Notice(`Ghostty: ${msg}`, 8000);
            return;
        }

        // Verify the helper exists
        if (!fs.existsSync(helperPath)) {
            const msg = `pty_helper.py not found at: ${helperPath}`;
            this.terminal?.write(`\x1b[31m${msg}\x1b[0m\r\n`);
            this.restartBtn?.removeClass('ghostty-hidden');
            new Notice(`Ghostty: ${msg}`, 8000);
            return;
        }

        // Use the WASM terminal's actual cols/rows as the source of truth.
        // terminalDimensions() recalculates independently and can disagree with
        // the terminal after fitAddon.fit(), causing an initial size mismatch.
        const cols = this.terminal?.cols ?? this.terminalDimensions().cols;
        const rows = this.terminal?.rows ?? this.terminalDimensions().rows;
        const python = process.platform === 'darwin' ? 'python3' : 'python3';

        try {
            this.ptyProcess = child_process.spawn(
                python,
                [helperPath, shell],
                {
                    cwd,
                    env: {
                        ...process.env as Record<string, string>,
                        LANG: process.env.LANG || 'en_US.UTF-8',
                        LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
                        LC_CTYPE: process.env.LC_CTYPE || 'en_US.UTF-8',
                        TERM: 'xterm-256color',
                        TERM_PROGRAM: 'obsidian-ghostty',
                        COLORTERM: 'truecolor',
                        COLUMNS: String(cols),
                        LINES: String(rows),
                    },
                    // stdio[3] is our resize control pipe (write-only from JS side)
                    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
                }
            );

            const stdioArr = this.ptyProcess.stdio as unknown as import('stream').Writable[];
            this.resizePipe = stdioArr[3];

            this.ptyAlive = true;

            // Immediately set the PTY window size via TIOCSWINSZ so zsh reads the
            // correct size from the start. Without this the PTY is 0×0 and zsh
            // falls back to the COLUMNS env var, which may still differ visually.
            this.sendResizeToPty();
            this.restartBtn?.addClass('ghostty-hidden');

            // PTY output → terminal display
            // No encoding set — receive raw Buffers so UTF-8 multi-byte
            // sequences are preserved and decoded correctly by the VT parser.
            this.ptyProcess.stdout?.on('data', (data: Buffer) => {
                this.terminal?.write(
                    new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
                    () => {
                        this.terminal?.scrollToBottom();
                    }
                );
            });

            // Terminal input → PTY stdin
            this.terminal?.onData((data: string) => {
                if (this.ptyAlive && this.ptyProcess?.stdin) {
                    if (/[가-힣ᄀ-ᇿ㄰-㆏]/.test(data)) {
                        const now = Date.now();
                        if (data === this.lastKoreanSent.data && now - this.lastKoreanSent.time < 30) {
                            return;
                        }
                        this.lastKoreanSent = { data, time: now };
                    }
                    this.ptyProcess.stdin.write(data, 'utf8');
                }
            });

            this.ptyProcess.on('close', (code: number | null) => {
                this.ptyAlive = false;
                this.terminal?.write(
                    `\r\n\x1b[31m[Process exited with code ${code ?? 0}]\x1b[0m\r\n`
                );
                this.restartBtn?.removeClass('ghostty-hidden');
            });

            this.ptyProcess.on('error', (err: Error) => {
                this.ptyAlive = false;
                this.terminal?.write(`\x1b[31m[PTY error: ${err.message}]\x1b[0m\r\n`);
                this.restartBtn?.removeClass('ghostty-hidden');
            });

            new Notice(`Ghostty ready — ${path.basename(shell)} @ ${path.basename(cwd)}`, 3000);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error('[GhosttyTerminal] Python PTY spawn failed:', e);
            this.terminal?.write(`\x1b[31mFailed to start shell: ${msg}\x1b[0m\r\n`);
            this.restartBtn?.removeClass('ghostty-hidden');
            new Notice(`Ghostty: failed to start shell — ${msg}`, 8000);
        }
    }

    // ── Resize (pixel-perfect) ─────────────────────────────────────────────────

    /**
     * Measures exact monospace character dimensions using a hidden canvas.
     * This mirrors what xterm.js Fit addon does, giving pixel-perfect cols/rows.
     */
    private measureCharDimensions() {
        // Reuse or create measurement element
        let measure = activeDocument.getElementById(CHAR_MEASURE_ID);
        if (!measure) {
            measure = activeDocument.createElement('canvas');
            measure.id = CHAR_MEASURE_ID;
            measure.className = 'ghostty-char-measure';
            activeDocument.body.appendChild(measure);
        }

        const canvas = measure as HTMLCanvasElement;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const gc = this.plugin.ghosttyConfig;
        const s = this.plugin.settings;
        const fontFamily = s.fontFamilyOverride || gc.fontFamily || 'Menlo, Monaco, "Courier New", monospace';
        const fontSize = s.fontSizeOverride > 0 ? s.fontSizeOverride : (gc.fontSize ?? 13);

        ctx.font = `${fontSize}px ${fontFamily}`;
        const measured = ctx.measureText('W');

        this.charWidth = Math.ceil(measured.width);
        const ascent = measured.actualBoundingBoxAscent ?? fontSize * 0.8;
        const descent = measured.actualBoundingBoxDescent ?? fontSize * 0.2;
        this.charHeight = Math.ceil(ascent + descent);
    }

    private terminalDimensions(): { cols: number; rows: number } {
        const el = this.termEl;
        if (!el) return { cols: 80, rows: 24 };

        const rect = el.getBoundingClientRect();
        const cols = Math.max(10, Math.floor(rect.width / this.charWidth));
        const rows = Math.max(5, Math.floor(rect.height / this.charHeight));
        return { cols, rows };
    }

    private handleResize() {
        if (!this.terminal || !this.fitAddon) return;
        if (this.isComposing) return;

        // ResizeObserver fires post-layout, so clientWidth/clientHeight are already
        // correct here. Call fit() immediately so SIGWINCH reaches the shell before
        // the user types the next command (avoids the 16ms RAF delay that caused
        // zsh to redraw with stale COLUMNS on immediate Ctrl+C after resize).
        this.fitAddon.fit();
        this.sendResizeToPty();

        // FitAddon has a 50ms internal _isResizing guard that blocks re-entrant
        // calls during rapid drag. Follow-up fires 60ms after the last resize event
        // (once the guard has expired) to apply the final dimensions if skipped.
        if (this.resizeFollowUpId !== null) clearTimeout(this.resizeFollowUpId);
        this.resizeFollowUpId = window.setTimeout(() => {
            this.resizeFollowUpId = null;
            if (!this.terminal || !this.fitAddon) return;
            this.fitAddon.fit();
            this.sendResizeToPty();
        }, 60);
    }

    private sendResizeToPty() {
        const { cols, rows } = this.terminal!;
        if (this.ptyAlive && this.resizePipe) {
            const frame = Buffer.alloc(4);
            frame.writeUInt16BE(rows, 0);
            frame.writeUInt16BE(cols, 2);
            this.resizePipe.write(frame);
        }
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    killPty() {
        const proc = this.ptyProcess;
        if (proc) {
            // Close all stdio pipes first — this triggers stdin-EOF in pty_helper.py
            // which causes it to self-terminate even if SIGTERM is missed.
            try { proc.stdin?.destroy(); } catch { /* ignore */ }
            try { proc.stdout?.destroy(); } catch { /* ignore */ }
            try { proc.stderr?.destroy(); } catch { /* ignore */ }
            try { this.resizePipe?.destroy(); } catch { /* ignore */ }

            // Send SIGTERM
            try { proc.kill('SIGTERM'); } catch { /* ignore */ }

            // Fallback: SIGKILL after a short delay in case SIGTERM is not handled
            const pid = proc.pid;
            if (pid) {
                window.setTimeout(() => {
                    try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
                }, 500);
            }

            this.ptyProcess = null;
        }
        this.resizePipe = null;
        this.ptyAlive = false;
    }

    onClose(): Promise<void> {
        this.resizeObserver?.disconnect();
        if (this.resizeFollowUpId !== null) clearTimeout(this.resizeFollowUpId);
        this.killPty();
        this.terminal?.dispose?.();
        this.fitAddon?.dispose?.();
        this.terminal = null;
        this.fitAddon = null;
        return Promise.resolve();
    }
}

// ─── Keybind helpers ──────────────────────────────────────────────────────────

// Ghostty's built-in defaults that we always enforce.
const GHOSTTY_BUILTIN_KEYBINDS: GhosttyKeybind[] = [
    { mods: new Set(['super']),          key: 'c',     action: 'copy_to_clipboard' },
    { mods: new Set(['super']),          key: 'v',     action: 'paste_from_clipboard' },
    { mods: new Set(['ctrl', 'shift']),  key: 'c',     action: 'copy_to_clipboard' },
    { mods: new Set(['ctrl', 'shift']),  key: 'v',     action: 'paste_from_clipboard' },
    // shift+enter / cmd+enter → kitty keyboard protocol newlines (used by Claude etc.)
    { mods: new Set(['shift']), key: 'enter', action: 'text:\x1b[13;2u' },
    { mods: new Set(['super']), key: 'enter', action: 'text:\x1b[13;9u' },
    // Home/End: send SS3 sequences matching xterm-256color terminfo (khome=\EOH, kend=\EOF)
    // so that oh-my-zsh / zsh ZLE recognizes them via ${terminfo[khome]}/${terminfo[kend]}
    { mods: new Set([]), key: 'home', action: 'text:\x1bOH' },
    { mods: new Set([]), key: 'end',  action: 'text:\x1bOF' },
];

/**
 * Merge built-in defaults with user config keybinds.
 * User entries win when they share the same key combo.
 */
function buildEffectiveKeybinds(userKeybinds: GhosttyKeybind[]): GhosttyKeybind[] {
    const result: GhosttyKeybind[] = [...GHOSTTY_BUILTIN_KEYBINDS];
    for (const kb of userKeybinds) {
        const idx = result.findIndex(r => r.key === kb.key && setsEqual(r.mods, kb.mods));
        if (idx !== -1) result[idx] = kb;
        else result.push(kb);
    }
    return result;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
}

/** Map DOM KeyboardEvent → Ghostty key name */
function domKeyToGhostty(domKey: string): string {
    const map: Record<string, string> = {
        'Enter':      'enter',
        'Tab':        'tab',
        'Backspace':  'backspace',
        'Escape':     'escape',
        'Delete':     'delete',
        'Insert':     'insert',
        'Home':       'home',
        'End':        'end',
        'PageUp':     'page_up',
        'PageDown':   'page_down',
        'ArrowUp':    'up',
        'ArrowDown':  'down',
        'ArrowLeft':  'left',
        'ArrowRight': 'right',
        ' ':          'space',
    };
    if (map[domKey]) return map[domKey];
    if (/^F\d+$/.test(domKey)) return domKey.toLowerCase();  // F1–F12
    if (domKey.length === 1) return domKey.toLowerCase();
    return domKey.toLowerCase();
}

function findKeybind(e: KeyboardEvent, keybinds: GhosttyKeybind[]): GhosttyKeybind | undefined {
    const eventMods = new Set<string>();
    if (e.metaKey)  eventMods.add('super');
    if (e.ctrlKey)  eventMods.add('ctrl');
    if (e.shiftKey) eventMods.add('shift');
    if (e.altKey)   eventMods.add('alt');

    const ghosttyKey = domKeyToGhostty(e.key);
    return keybinds.find(kb => kb.key === ghosttyKey && setsEqual(kb.mods, eventMods));
}

/** Unescape Ghostty text: action escape sequences like \e, \n, \r, \t */
function unescapeGhosttyText(s: string): string {
    return s
        .replace(/\\e/g, '\x1b')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\\\/g, '\\');
}

/**
 * When IBus commits a syllable, the coda consonant may have moved to become
 * the onset of the next syllable (e.g. "간" + next "나" → committed "가").
 * Uses es-hangul disassemble/assemble to detect and apply the adjustment.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function hangulAdjustCodaMove(pending: string, nextData: string): string {
    if (!pending || !nextData) return pending;
    const lastChar = pending[pending.length - 1];
    const nextChar = nextData[0];
    const lastJamo = disassemble(lastChar);
    const nextJamo = disassemble(nextChar);
    // Need at least 3 jamo (onset+nucleus+coda) and coda must match next onset
    if (lastJamo.length < 3 || !nextJamo) return pending;
    const coda = lastJamo[lastJamo.length - 1];
    if (coda === 'ㅇ') {
        // ㅇ coda is ambiguous: it's ng sound as coda, silent as onset.
        // If the next compositionupdate is a lone 'ㅇ' jamo (length 1), the user
        // typed ㅇ again to confirm the ng coda (e.g. 강아지 via ㄱ+ㅏ+ㅇ+ㅇ+ㅏ).
        // If it's a complete syllable with ㅇ onset (length > 1), the coda moved
        // to become the silent onset (e.g. 우 + 와 from 웅 + ㅘ).
        if (nextJamo.length <= 1) return pending;
        // else fall through — coda moved to onset of next syllable
    }
    if (coda !== nextJamo[0]) return pending;
    return pending.slice(0, -1) + assemble([...lastJamo.slice(0, -1)]);
}