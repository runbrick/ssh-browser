import * as vscode from 'vscode';
import { SSHManager } from '../services/sshManager';
import { SSHConfig } from '../types';
import { Client } from 'ssh2';
import { FileManagerPanel } from './fileManagerPanel';
import { MonitoringPanel } from './monitoringPanel';
import { DockerPanel } from './dockerPanel';

/**
 * SSH 会话面板
 * 使用 Webview 实现独立的 SSH 终端界面
 */
export class SSHSessionPanel {
  private static sessions: Map<string, SSHSessionPanel> = new Map();
  private static currentPathChangeEmitter = new vscode.EventEmitter<{ connectionId: string, path: string }>();
  public static readonly onCurrentPathChange = SSHSessionPanel.currentPathChangeEmitter.event;

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private stream: any;
  private client: Client;
  private currentPath: string = '/';
  private commandHistory: string[] = [];
  private syncEnabled: boolean = false;

  private constructor(
    panel: vscode.WebviewPanel,
    private config: SSHConfig,
    private sshManager: SSHManager,
    private context: vscode.ExtensionContext
  ) {
    this.panel = panel;
    this.client = sshManager.getClient(config.id)!;

    // 设置 webview 内容
    this.panel.webview.html = this.getHtmlContent();

    // 监听 webview 消息
    this.panel.webview.onDidReceiveMessage(
      message => this.handleMessage(message),
      null,
      this.disposables
    );

    // 清理资源
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // 初始化 SSH Shell
    this.initializeShell();
  }

  /**
   * 创建或显示会话面板
   */
  public static async createOrShow(
    config: SSHConfig,
    sshManager: SSHManager,
    context: vscode.ExtensionContext
  ): Promise<void> {
    const sessionKey = `${config.id}`;

    // 如果已经有会话，直接显示
    const existingSession = SSHSessionPanel.sessions.get(sessionKey);
    if (existingSession) {
      existingSession.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    // 确保已连接
    if (!sshManager.isConnected(config.id)) {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Connecting to ${config.name}...`,
          cancellable: false
        },
        async () => {
          await sshManager.connect(config);
        }
      );
    }

    // 创建新面板
    const panel = vscode.window.createWebviewPanel(
      'sshSession',
      `SSH: ${config.name}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: []
      }
    );

    const session = new SSHSessionPanel(panel, config, sshManager, context);
    SSHSessionPanel.sessions.set(sessionKey, session);
  }

  /**
   * 初始化 SSH Shell
   */
  private async initializeShell() {
    this.client.shell(
      {
        cols: 80,
        rows: 24,
        term: 'xterm-256color'
      },
      (err: Error | undefined, stream: any) => {
        if (err) {
          this.sendToWebview({
            type: 'output',
            data: `\r\nFailed to start shell: ${err.message}\r\n`
          });
          return;
        }

        this.stream = stream;

        // 将服务器输出发送到 webview
        stream.on('data', (data: Buffer) => {
          this.sendToWebview({
            type: 'output',
            data: data.toString()
          });
        });

        stream.stderr.on('data', (data: Buffer) => {
          this.sendToWebview({
            type: 'output',
            data: data.toString()
          });
        });

        stream.on('close', () => {
          this.sendToWebview({
            type: 'output',
            data: '\r\n[Connection closed]\r\n'
          });
        });

        // 发送欢迎消息
        this.sendToWebview({
          type: 'output',
          data: `\r\n\x1b[1;32m=== Connected to ${this.config.name} (${this.config.host}) ===\x1b[0m\r\n\r\n`
        });

        // 通知 webview 已准备好
        this.sendToWebview({
          type: 'ready'
        });

        // 发送配置
        const config = vscode.workspace.getConfiguration('sshBrowser.terminal');
        this.sendToWebview({
          type: 'config',
          enablePrediction: config.get<boolean>('enablePrediction', true)
        });
      }
    );
  }

  /**
   * 处理来自 webview 的消息
   */
  private async handleMessage(message: any) {
    switch (message.type) {
      case 'input':
        if (this.stream) {
          this.stream.write(message.data);
        }
        break;

      case 'resize':
        if (this.stream) {
          this.stream.setWindow(message.rows, message.cols, 0, 0);
        }
        break;

      case 'pathChange':
        // 更新当前路径并通知文件管理器（如果同步已启用）
        this.handlePathChange(message.path);
        break;

      case 'manualSync':
        // 手动同步当前路径到文件管理器
        await this.syncCurrentPath();
        break;

      case 'toggleSync':
        // 切换同步状态
        this.toggleSyncWithFileManager();
        break;

      case 'openFileManager':
        await FileManagerPanel.createOrShow(this.config, this.sshManager, this.context);
        break;

      case 'openMonitoring':
        await MonitoringPanel.createOrShow(this.config, this.sshManager, this.context);
        break;

      case 'openDocker':
        await DockerPanel.createOrShow(this.config, this.sshManager, this.context);
        break;

      case 'commandExecuted':
        // 保存命令到历史记录
        const command = message.command?.trim();
        if (command && command.length > 0) {
          // 避免重复的连续命令
          if (this.commandHistory.length === 0 || this.commandHistory[this.commandHistory.length - 1] !== command) {
            this.commandHistory.push(command);
            // 限制历史记录数量
            if (this.commandHistory.length > 1000) {
              this.commandHistory.shift();
            }
          }
        }
        break;

      case 'getPredictions':
        // 获取命令预测
        const input = message.input || '';
        const predictions = await this.getPredictions(input);
        this.sendToWebview({
          type: 'predictions',
          predictions: predictions
        });
        break;
    }
  }

  /**
   * 手动同步当前路径到文件管理器
   */
  private async syncCurrentPath(): Promise<void> {
    try {
      // 执行 pwd 命令获取当前路径
      const result = await this.sshManager.execCommand(this.config.id, 'pwd');
      const path = result.trim();
      
      if (path && path.startsWith('/')) {
        this.currentPath = path;
        SSHSessionPanel.currentPathChangeEmitter.fire({
          connectionId: this.config.id,
          path: path
        });
        vscode.window.showInformationMessage(`Synced to: ${path}`);
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to sync path: ${error}`);
    }
  }

  /**
   * 切换与文件管理器的同步状态
   */
  private toggleSyncWithFileManager(): void {
    this.syncEnabled = !this.syncEnabled;
    
    // 通知 webview 更新按钮状态
    this.sendToWebview({
      type: 'syncStateChanged',
      enabled: this.syncEnabled
    });

    if (this.syncEnabled) {
      vscode.window.showInformationMessage('Directory sync enabled - Terminal and File Manager will stay in sync');
      // 立即同步一次
      this.syncCurrentPath();
    } else {
      vscode.window.showInformationMessage('Directory sync disabled');
    }
  }

  /**
   * 处理从终端检测到的路径变化
   */
  private handlePathChange(path: string): void {
    if (path && path !== this.currentPath) {
      this.currentPath = path;
      if (this.syncEnabled) {
        SSHSessionPanel.currentPathChangeEmitter.fire({
          connectionId: this.config.id,
          path: path
        });
      }
    }
  }

  /**
   * 获取命令预测建议
   */
  private async getPredictions(input: string): Promise<string[]> {
    if (!input || input.length === 0) {
      return [];
    }

    const inputLower = input.toLowerCase();
    const matches: string[] = [];

    // 检测是否在输入文件路径
    const pathPattern = /(?:^|\s)(cat|less|tail|head|vim|nano|cd|ls|rm|cp|mv|chmod|chown|mkdir)\s+(.*)$/;
    const pathMatch = input.match(pathPattern);

    if (pathMatch && pathMatch[2]) {
      // 正在输入文件路径，获取文件/目录建议
      const command = pathMatch[1];
      const partialPath = pathMatch[2];
      const fileSuggestions = await this.getFileSuggestions(partialPath);

      // 将文件建议添加到匹配列表
      fileSuggestions.forEach(file => {
        matches.push(`${command} ${file}`);
      });

      if (matches.length > 0) {
        return matches.slice(0, 5);
      }
    }

    // 从历史记录中查找匹配项（从最新到最旧）
    for (let i = this.commandHistory.length - 1; i >= 0; i--) {
      const cmd = this.commandHistory[i];
      if (cmd.toLowerCase().startsWith(inputLower) && cmd !== input) {
        if (!matches.includes(cmd)) {
          matches.push(cmd);
        }
        if (matches.length >= 5) {
          break;
        }
      }
    }

    // 添加常用命令建议
    const commonCommands = [
      'ls -la', 'cd ', 'pwd', 'cat ', 'grep ', 'find ', 'mkdir ', 'rm ',
      'cp ', 'mv ', 'chmod ', 'chown ', 'ps aux', 'top', 'htop',
      'df -h', 'du -sh', 'free -h', 'uptime', 'whoami', 'which ',
      'vim ', 'nano ', 'less ', 'tail -f ', 'head ', 'wget ', 'curl ',
      'tar -xzf ', 'tar -czf ', 'unzip ', 'git status', 'git log',
      'docker ps', 'docker images', 'systemctl status ', 'journalctl -f'
    ];

    for (const cmd of commonCommands) {
      if (cmd.toLowerCase().startsWith(inputLower) && !matches.includes(cmd)) {
        matches.push(cmd);
        if (matches.length >= 5) {
          break;
        }
      }
    }

    return matches;
  }

  /**
   * 获取文件/目录建议
   */
  private async getFileSuggestions(partialPath: string): Promise<string[]> {
    try {
      // 解析路径
      let dirPath = '.';
      let prefix = partialPath;

      const lastSlash = partialPath.lastIndexOf('/');
      if (lastSlash >= 0) {
        dirPath = partialPath.substring(0, lastSlash + 1) || '/';
        prefix = partialPath.substring(lastSlash + 1);
      }

      // 执行 ls 命令获取目录内容
      const lsCommand = `ls -1ap ${dirPath} 2>/dev/null || echo ""`;
      const result = await this.sshManager.execCommand(this.config.id, lsCommand);

      if (!result || result.trim() === '') {
        return [];
      }

      // 解析文件列表
      const files = result.split('\n')
        .map((f: string) => f.trim())
        .filter((f: string) => f.length > 0)
        .filter((f: string) => f.toLowerCase().startsWith(prefix.toLowerCase()))
        .slice(0, 5);

      // 构建完整路径
      return files.map((f: string) => {
        if (lastSlash >= 0) {
          return dirPath + f;
        }
        return f;
      });
    } catch (error) {
      return [];
    }
  }

  /**
   * 发送消息到 webview
   */
  private sendToWebview(message: any) {
    this.panel.webview.postMessage(message);
  }

  /**
   * 获取终端主题配置
   */
  private getTerminalTheme(): any {
    const config = vscode.workspace.getConfiguration('sshBrowser.terminal');
    const themeName = config.get<string>('theme', 'default');

    const themes: { [key: string]: any } = {
      default: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#ffffff',
        cursorAccent: '#000000',
        selectionBackground: '#3a3d41',
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#e5e5e5'
      },
      dark: {
        background: '#000000',
        foreground: '#ffffff',
        cursor: '#ffffff',
        selectionBackground: '#555555'
      },
      light: {
        background: '#ffffff',
        foreground: '#000000',
        cursor: '#000000',
        selectionBackground: '#add6ff'
      },
      solarizedDark: {
        background: '#002b36',
        foreground: '#839496',
        cursor: '#839496',
        black: '#073642',
        red: '#dc322f',
        green: '#859900',
        yellow: '#b58900',
        blue: '#268bd2',
        magenta: '#d33682',
        cyan: '#2aa198',
        white: '#eee8d5'
      },
      solarizedLight: {
        background: '#fdf6e3',
        foreground: '#657b83',
        cursor: '#657b83',
        black: '#073642',
        red: '#dc322f',
        green: '#859900',
        yellow: '#b58900',
        blue: '#268bd2',
        magenta: '#d33682',
        cyan: '#2aa198',
        white: '#eee8d5'
      }
    };

    return themes[themeName] || themes.default;
  }

  /**
   * 生成 HTML 内容
   */
  private getHtmlContent(): string {
    const config = vscode.workspace.getConfiguration('sshBrowser.terminal');
    const rightClickBehavior = config.get<string>('rightClickBehavior', 'contextMenu');
    const theme = this.getTerminalTheme();

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SSH Session</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
    <style>
        :root {
            --toolbar-height: 38px;
            --font-size-small: 11px;
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            background-color: var(--vscode-terminal-background, #1e1e1e);
            color: var(--vscode-terminal-foreground, #cccccc);
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
            font-size: var(--vscode-font-size, 13px);
            overflow: hidden;
            padding: 0;
        }

        #toolbar {
            display: flex;
            align-items: center;
            height: var(--toolbar-height);
            padding: 0 16px;
            background-color: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            gap: 4px;
            user-select: none;
            z-index: 100;
        }

        .toolbar-group {
            display: flex;
            align-items: center;
            gap: 2px;
        }

        .toolbar-separator {
            width: 1px;
            height: 18px;
            background-color: var(--vscode-panel-border);
            margin: 0 8px;
        }

        .icon-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 28px;
            height: 28px;
            border: none;
            border-radius: 4px;
            background-color: transparent;
            color: var(--vscode-icon-foreground);
            cursor: pointer;
            transition: background-color 0.1s;
        }

        .icon-btn:hover {
            background-color: var(--vscode-toolbar-hoverBackground);
        }

        .icon-btn:focus-visible {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
        }

        .icon-btn.sync-active {
            color: var(--vscode-testing-iconPassedColor, #10b981);
            background-color: var(--vscode-toolbar-activeBackground);
        }

        .icon-btn svg {
            width: 16px;
            height: 16px;
            fill: currentColor;
        }

        #status {
            margin-left: auto;
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: var(--font-size-small);
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
        }

        #status .indicator {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background-color: var(--vscode-descriptionForeground);
            transition: all 0.3s;
        }

        #status.connected .indicator {
            background-color: var(--vscode-testing-iconPassedColor, #10b981);
            box-shadow: 0 0 6px var(--vscode-testing-iconPassedColor);
        }

        #terminal-container {
            position: absolute;
            top: var(--toolbar-height);
            left: 0;
            right: 0;
            bottom: 0;
            background-color: var(--vscode-terminal-background, #1e1e1e);
        }

        .xterm {
            height: 100%;
            padding: 8px;
        }

        /* Prediction box styles (VSCode Suggest Widget style) */
        #prediction-box {
            position: absolute;
            background-color: var(--vscode-editorSuggestWidget-background);
            border: 1px solid var(--vscode-editorSuggestWidget-border);
            box-shadow: 0 4px 12px rgba(0,0,0,0.4);
            z-index: 1000;
            max-height: 240px;
            overflow-y: auto;
            min-width: 260px;
            display: none;
            border-radius: 4px;
            padding: 4px;
        }

        .prediction-item {
            padding: 4px 12px;
            cursor: pointer;
            color: var(--vscode-editorSuggestWidget-foreground);
            font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
            font-size: 13px;
            border-radius: 3px;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .prediction-item:hover,
        .prediction-item.selected {
            background-color: var(--vscode-editorSuggestWidget-selectedBackground);
            color: var(--vscode-editorSuggestWidget-selectedForeground);
        }

        .prediction-item .match {
            color: var(--vscode-editorSuggestWidget-highlightForeground);
            font-weight: bold;
        }
        
        .prediction-item::before {
            content: '>';
            opacity: 0.5;
            font-size: 11px;
        }

        ::-webkit-scrollbar {
            width: 10px;
            height: 10px;
        }

        ::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background);
            border-radius: 5px;
        }

        ::-webkit-scrollbar-thumb:hover {
            background: var(--vscode-scrollbarSlider-hoverBackground);
        }
    </style>
</head>
<body>
    <div id="toolbar">
        <div class="toolbar-group">
            <button class="icon-btn" id="clearBtn" title="Clear Terminal">
                <svg viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4L4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L10.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg>
            </button>
        </div>
        <div class="toolbar-separator"></div>
        <div class="toolbar-group">
            <button class="icon-btn" id="copyBtn" title="Copy Selection">
                <svg viewBox="0 0 16 16"><path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z"/><path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z"/></svg>
            </button>
            <button class="icon-btn" id="pasteBtn" title="Paste">
                <svg viewBox="0 0 16 16"><path d="M5 4.5V4a2 2 0 0 1 2-2h1V1H7a3 3 0 0 0-3 3v.5H3a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-1h-1v1a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h2z"/><path d="M10 1.5H9a2 2 0 0 0-2 2V12a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z"/><path d="M12.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3z"/></svg>
            </button>
        </div>
        <div class="toolbar-separator"></div>
        <div class="toolbar-group">
            <button class="icon-btn" id="syncBtn" title="Sync with File Manager">
                <svg viewBox="0 0 16 16"><path fill-rule="evenodd" d="M1 11.5a.5.5 0 0 0 .5.5h11.793l-3.147 3.146a.5.5 0 0 0 .708.708l4-4a.5.5 0 0 0 0-.708l-4-4a.5.5 0 0 0-.708.708L13.293 11H1.5a.5.5 0 0 0-.5.5zm14-7a.5.5 0 0 1-.5.5H2.707l3.147 3.146a.5.5 0 1 1-.708.708l-4-4a.5.5 0 0 1 0-.708l4-4a.5.5 0 1 1 .708.708L2.707 4H14.5a.5.5 0 0 1 .5.5z"/></svg>
            </button>
            <button class="icon-btn" id="fileManagerBtn" title="Open File Manager">
                <svg viewBox="0 0 16 16"><path d="M9.828 3h3.982a2 2 0 0 1 1.992 2.181l-.637 7A2 2 0 0 1 13.174 14H2.825a2 2 0 0 1-1.991-1.819l-.637-7a1.99 1.99 0 0 1 .342-1.31L.5 3a2 2 0 0 1 2-2h3.672a2 2 0 0 1 1.414.586l.828.828A2 2 0 0 0 9.828 3zm-8.322.12C1.72 3.042 1.95 3 2.19 3h5.396l-.707-.707A1 1 0 0 0 6.172 2H2.5a1 1 0 0 0-1 .981l.006.139z"/></svg>
            </button>
            <button class="icon-btn" id="monitoringBtn" title="Open Server Monitoring">
                <svg viewBox="0 0 16 16"><path d="M0 0h16v16H0V0zm1 1v14h14V1H1zm11 11H4v-1h8v1zm0-3H4V8h8v1zm0-3H4V5h8v1z"/></svg>
            </button>
            <button class="icon-btn" id="dockerBtn" title="Open Docker Management">
                <svg viewBox="0 0 16 16"><path d="M6.845 7.225h1.354V8.41H6.845V7.225zm1.596 0h1.354V8.41H8.441V7.225zm1.596 0h1.354V8.41H10.037V7.225zm1.596 0H12.99V8.41h-1.355V7.225zm-4.792-1.43h1.354V6.98H6.845V5.795zm1.596 0h1.354V6.98H8.441V5.795zm1.596 0h1.354V6.98H10.037V5.795zm1.596 0H12.99V6.98h-1.355V5.795zm-3.195-1.432h1.354V5.55H8.441V4.363zm1.596 0h1.354V5.55H10.037V4.363z"/><path d="M0 12.507a.5.5 0 0 0 .5.5c4.181 0 5.428-2.525 5.515-3.12h8.735a.5.5 0 0 0 .454-.292c.224-.486.44-1.246.216-2.022-.24-.834-.82-1.41-1.355-1.688a.5.5 0 0 0-.663.2c-.105.187-.245.367-.42.522-.44.385-1.12.593-1.874.593H5.706a5.552 5.552 0 0 0-4.444 2.227.502.502 0 0 0-.083.432c.164.607.391 1.631-.179 2.651a.501.501 0 0 0 .001.498z"/></svg>
            </button>
        </div>
        <div id="status">
            <span class="indicator"></span>
            <span>Connecting...</span>
        </div>
    </div>
    <div id="terminal-container"></div>
    <div id="prediction-box"></div>

    <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/xterm-addon-web-links@0.9.0/lib/xterm-addon-web-links.js"></script>
    <script>
        const vscode = acquireVsCodeApi();
        const rightClickBehavior = '${rightClickBehavior}';

        // 创建终端
        const term = new Terminal({
            cursorBlink: true,
            fontSize: 14,
            fontFamily: 'Consolas, "Courier New", monospace',
            rightClickSelectsWord: rightClickBehavior === 'contextMenu',
            theme: ${JSON.stringify(theme)}
        });

        // 添加插件
        const fitAddon = new FitAddon.FitAddon();
        const webLinksAddon = new WebLinksAddon.WebLinksAddon();

        term.loadAddon(fitAddon);
        term.loadAddon(webLinksAddon);

        // 打开终端
        term.open(document.getElementById('terminal-container'));
        fitAddon.fit();

        // 右键行为处理
        if (rightClickBehavior === 'paste') {
            term.element.addEventListener('contextmenu', async (e) => {
                e.preventDefault();
                try {
                    const text = await navigator.clipboard.readText();
                    vscode.postMessage({
                        type: 'input',
                        data: text
                    });
                } catch (err) {
                    console.error('Failed to read clipboard:', err);
                }
            });
        }

        // 监听窗口大小变化
        let resizeTimeout;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                fitAddon.fit();
                vscode.postMessage({
                    type: 'resize',
                    rows: term.rows,
                    cols: term.cols
                });
            }, 100);
        });

        // 工具栏按钮
        document.getElementById('clearBtn').addEventListener('click', () => {
            // 直接清空前端终端显示
            term.clear();
        });

        document.getElementById('copyBtn').addEventListener('click', () => {
            const selection = term.getSelection();
            if (selection) {
                navigator.clipboard.writeText(selection);
            }
        });

        document.getElementById('pasteBtn').addEventListener('click', async () => {
            try {
                const text = await navigator.clipboard.readText();
                vscode.postMessage({
                    type: 'input',
                    data: text
                });
            } catch (err) {
                console.error('Failed to paste:', err);
            }
        });

        document.getElementById('syncBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'toggleSync' });
        });

        document.getElementById('fileManagerBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'openFileManager' });
        });

        document.getElementById('monitoringBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'openMonitoring' });
        });

        document.getElementById('dockerBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'openDocker' });
        });

        // Update sync button state
        function updateSyncButton(enabled) {
            const btn = document.getElementById('syncBtn');
            if (enabled) {
                btn.classList.add('sync-active');
                btn.title = 'Directory sync is ON - Click to disable';
            } else {
                btn.classList.remove('sync-active');
                btn.title = 'Sync with File Manager - Click to enable';
            }
        }

        // 接收来自扩展的消息
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'output':
                    term.write(message.data);
                    // 检测 cd 命令和路径变化
                    detectPathChange(message.data);
                    break;
                case 'ready':
                    const statusEl = document.getElementById('status');
                    statusEl.innerHTML = '<span class="indicator"></span><span>Connected</span>';
                    statusEl.classList.add('connected');
                    // 发送初始尺寸
                    vscode.postMessage({
                        type: 'resize',
                        rows: term.rows,
                        cols: term.cols
                    });
                    break;
                case 'predictions':
                    // 显示预测结果
                    showPredictions(message.predictions);
                    break;
                case 'config':
                    // 更新配置
                    if (message.enablePrediction !== undefined) {
                        predictionEnabled = message.enablePrediction;
                        if (!predictionEnabled) {
                            hidePredictions();
                        }
                    }
                    break;
                case 'syncStateChanged':
                    // 更新同步按钮状态
                    updateSyncButton(message.enabled);
                    break;
            }
        });

        // 路径检测
        let currentPath = '';
        let pendingCdCommand = false;

        function detectPathChange(data) {
            // 去除 ANSI 转义序列
            const cleanData = data
                .replace(/\\x1b\\[[0-9;]*[a-zA-Z]/g, '')  // ESC[...X
                .replace(/\\x1b\\][^\\x07]*\\x07/g, '')    // OSC sequences
                .replace(/[\\x00-\\x1f]/g, ' ');            // Control characters

            // 多种提示符模式来提取路径
            const patterns = [
                // user@host:path$ 或 user@host:path# (最常见的 bash 格式)
                /([\\w.-]+@[\\w.-]+):([^$#\\s]+)\\s*[$#>]\\s*$/,
                // [user@host path]$ (一些 zsh 主题)
                /\\[([^\\]]+)\\s+([^\\]]+)\\]\\s*[$#>]\\s*$/,
                // user:path$ (简化格式)
                /([\\w.-]+):([^$#\\s]+)\\s*[$#>]\\s*$/,
                // 纯路径提示符 path$ 或 path#
                /([~\\/][^$#\\s]*)\\s*[$#>]\\s*$/
            ];

            // 按行分析
            const lines = cleanData.split(/[\\r\\n]+/);
            
            for (const line of lines) {
                const trimmedLine = line.trim();
                if (!trimmedLine) continue;

                for (const pattern of patterns) {
                    const match = trimmedLine.match(pattern);
                    if (match) {
                        // 根据模式提取路径
                        let path = match[2] || match[1];
                        path = path.trim();

                        // 验证是否是有效路径
                        if (path && (path.startsWith('/') || path.startsWith('~'))) {
                            if (path !== currentPath) {
                                console.log('[Path Detection] Detected path:', path);
                                currentPath = path;
                                vscode.postMessage({
                                    type: 'pathChange',
                                    path: path
                                });
                            }
                            return;
                        }
                    }
                }
            }
        }

        // 命令预测功能
        let predictionEnabled = true; // 默认启用，会从配置更新
        let currentLine = '';
        let predictions = [];
        let selectedPredictionIndex = -1;
        const predictionBox = document.getElementById('prediction-box');

        term.onData(data => {
            // 始终转发数据到 SSH 后端（让远程 shell 处理 Tab 补全等功能）
            vscode.postMessage({
                type: 'input',
                data: data
            });

            // 检测是否按下 Enter
            if (data === '\\r') {
                if (currentLine.trim()) {
                    vscode.postMessage({
                        type: 'commandExecuted',
                        command: currentLine.trim()
                    });
                }
                currentLine = '';
                hidePredictions();
            }
            // 检测退格键
            else if (data === '\\x7f') {
                currentLine = currentLine.slice(0, -1);
                // 不请求预测，让远程 shell 的 Tab 补全工作
            }
            // Tab 键 - 直接转发到远程 shell，不做客户端处理
            else if (data === '\\t') {
                // Tab 已经转发到 SSH，让远程 shell 处理补全
                // 清空本地记录的当前行（因为 shell 会修改它）
                currentLine = '';
                hidePredictions();
            }
            // 普通字符输入
            else if (data.length === 1 && data.charCodeAt(0) >= 32) {
                currentLine += data;
            }
            // Ctrl+C
            else if (data === '\\x03') {
                currentLine = '';
                hidePredictions();
            }
        });

        let predictionTimeout;
        function requestPredictions() {
            clearTimeout(predictionTimeout);
            if (!predictionEnabled) {
                hidePredictions();
                return;
            }
            if (currentLine.length > 0) {
                predictionTimeout = setTimeout(() => {
                    vscode.postMessage({
                        type: 'getPredictions',
                        input: currentLine
                    });
                }, 150); // 150ms 防抖
            } else {
                hidePredictions();
            }
        }

        function showPredictions(items) {
            predictions = items || [];
            selectedPredictionIndex = -1;

            if (predictions.length === 0) {
                hidePredictions();
                return;
            }

            predictionBox.innerHTML = '';
            predictions.forEach((item, index) => {
                const div = document.createElement('div');
                div.className = 'prediction-item';

                // 高亮匹配的部分
                const matchLen = currentLine.length;
                const matchPart = item.substring(0, matchLen);
                const restPart = item.substring(matchLen);
                div.innerHTML = \`<span class="match">\${matchPart}</span>\${restPart}\`;

                div.addEventListener('click', () => {
                    selectPrediction(index);
                });

                predictionBox.appendChild(div);
            });

            // 定位预测框在光标处
            predictionBox.style.display = 'block';

            // 获取光标位置
            const buffer = term.buffer.active;
            const cursorY = buffer.cursorY;
            const cursorX = buffer.cursorX;

            // 计算像素位置（考虑字体大小和行高）
            const charWidth = 9;  // Consolas 14px 的大约宽度
            const charHeight = 17; // 行高
            const containerPadding = 8;
            const toolbarHeight = 41;

            const left = containerPadding + (cursorX * charWidth);
            const top = toolbarHeight + containerPadding + ((cursorY + 1) * charHeight);

            predictionBox.style.left = left + 'px';
            predictionBox.style.top = top + 'px';
        }

        function hidePredictions() {
            predictionBox.style.display = 'none';
            predictions = [];
            selectedPredictionIndex = -1;
        }

        function selectPrediction(index) {
            if (index >= 0 && index < predictions.length) {
                const selected = predictions[index];
                // 删除当前输入
                const deleteCount = currentLine.length;
                for (let i = 0; i < deleteCount; i++) {
                    term.write('\\x08 \\x08');
                }
                // 写入选中的预测
                term.write(selected);
                currentLine = selected;
                hidePredictions();
            }
        }

        // 快捷键支持
        term.attachCustomKeyEventHandler(event => {
            // Ctrl+C 复制选中文本
            if (event.ctrlKey && event.key === 'c' && term.hasSelection()) {
                event.preventDefault();
                const selection = term.getSelection();
                navigator.clipboard.writeText(selection);
                return false;
            }
            // Ctrl+V 粘贴
            if (event.ctrlKey && event.key === 'v') {
                event.preventDefault();
                navigator.clipboard.readText().then(text => {
                    vscode.postMessage({
                        type: 'input',
                        data: text
                    });
                });
                return false;
            }
            // 上下箭头选择预测项
            if (event.key === 'ArrowDown' && predictions.length > 0) {
                event.preventDefault();
                selectedPredictionIndex = Math.min(selectedPredictionIndex + 1, predictions.length - 1);
                updatePredictionSelection();
                return false;
            }
            if (event.key === 'ArrowUp' && predictions.length > 0) {
                event.preventDefault();
                selectedPredictionIndex = Math.max(selectedPredictionIndex - 1, 0);
                updatePredictionSelection();
                return false;
            }
            // Escape 关闭预测
            if (event.key === 'Escape') {
                hidePredictions();
                return true;
            }
            return true;
        });

        function updatePredictionSelection() {
            const items = predictionBox.querySelectorAll('.prediction-item');
            items.forEach((item, index) => {
                if (index === selectedPredictionIndex) {
                    item.classList.add('selected');
                    item.scrollIntoView({ block: 'nearest' });
                } else {
                    item.classList.remove('selected');
                }
            });
        }

        // 初始化时调整大小
        setTimeout(() => {
            fitAddon.fit();
        }, 100);
    </script>
</body>
</html>`;
  }

  /**
   * 清理资源
   */
  public async dispose() {
    const sessionKey = `${this.config.id}`;
    SSHSessionPanel.sessions.delete(sessionKey);

    if (this.stream) {
      this.stream.close();
    }

    // 关闭 Webview 面板
    if (this.panel) {
      // this.panel.dispose(); // 注意：dispose() 内部通常会触发 onDidDispose，避免递归
    }

    // 断开 SSH 连接
    try {
      await this.sshManager.disconnect(this.config.id, true);
    } catch (error) {
      console.error(`Failed to disconnect ${this.config.id} on panel dispose:`, error);
    }

    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  /**
   * 关闭所有会话
   */
  public static disposeAll() {
    for (const session of SSHSessionPanel.sessions.values()) {
      session.dispose();
    }
    SSHSessionPanel.sessions.clear();
  }
}
