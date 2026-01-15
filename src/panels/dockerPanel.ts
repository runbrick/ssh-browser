import * as vscode from 'vscode';
import { SSHManager } from '../services/sshManager';
import { SSHConfig, DockerContainerInfo } from '../types';
import { DockerManager } from '../services/dockerManager';

/**
 * Docker 容器管理面板
 * 使用 Webview 实现实时 Docker 容器监控和管理界面
 */
export class DockerPanel {
    private static panels: Map<string, DockerPanel> = new Map();

    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private dockerManager: DockerManager;
    private refreshInterval: NodeJS.Timeout | null = null;
    private isMonitoring: boolean = false;
    private refreshRate: number = 10000; // 默认 10 秒刷新间隔
    private isDisposed: boolean = false;

    private constructor(
        panel: vscode.WebviewPanel,
        private config: SSHConfig,
        private sshManager: SSHManager,
        private context: vscode.ExtensionContext
    ) {
        this.panel = panel;
        this.dockerManager = new DockerManager(sshManager);

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

        // 自动开始监控
        this.startMonitoring();
    }

    /**
     * 创建或显示 Docker 面板
     */
    public static async createOrShow(
        config: SSHConfig,
        sshManager: SSHManager,
        context: vscode.ExtensionContext,
        viewColumn: vscode.ViewColumn = vscode.ViewColumn.Beside
    ): Promise<void> {
        const sessionKey = config.id;

        // 如果已经有面板，直接显示
        const existingPanel = DockerPanel.panels.get(sessionKey);
        if (existingPanel) {
            existingPanel.panel.reveal(viewColumn);
            return;
        }

        // 确保已连接
        if (!sshManager.isConnected(config.id)) {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `连接到 ${config.name}...`,
                    cancellable: false
                },
                async () => {
                    await sshManager.connect(config);
                }
            );
        }

        // 创建新面板
        const panel = vscode.window.createWebviewPanel(
            'dockerManagement',
            `Docker: ${config.name}`,
            viewColumn,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: []
            }
        );

        const dockerPanel = new DockerPanel(panel, config, sshManager, context);
        DockerPanel.panels.set(sessionKey, dockerPanel);
    }

    /**
     * Handle messages from webview
     */
    private async handleMessage(message: any) {
        switch (message.type) {
            case 'refresh':
                await this.refreshContainers();
                break;

            case 'toggleMonitoring':
                if (this.isMonitoring) {
                    this.stopMonitoring();
                } else {
                    this.startMonitoring();
                }
                break;

            case 'changeRefreshRate':
                this.changeRefreshRate(message.rate);
                break;

            case 'startContainer':
                await this.startContainer(message.containerId, message.containerName);
                break;

            case 'stopContainer':
                await this.stopContainer(message.containerId, message.containerName);
                break;

            case 'restartContainer':
                await this.restartContainer(message.containerId, message.containerName);
                break;
        }
    }

    /**
     * Start a container
     */
    private async startContainer(containerId: string, containerName?: string) {
        const shortId = containerId.substring(0, 12);
        const displayName = containerName || shortId;

        const confirmed = await vscode.window.showWarningMessage(
            `Start container "${displayName}"?`,
            { modal: true },
            'Start'
        );

        if (confirmed !== 'Start') {
            return;
        }

        try {
            const success = await this.dockerManager.startContainer(this.config.id, containerId);
            if (success) {
                vscode.window.showInformationMessage(`Container ${displayName} started successfully`);
                // Refresh container list after short delay
                setTimeout(() => this.refreshContainers(), 1000);
            } else {
                vscode.window.showErrorMessage(`Failed to start container ${displayName}`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to start container: ${error}`);
        }
    }

    /**
     * Stop a container
     */
    private async stopContainer(containerId: string, containerName?: string) {
        const shortId = containerId.substring(0, 12);
        const displayName = containerName || shortId;

        const confirmed = await vscode.window.showWarningMessage(
            `Stop container "${displayName}"?`,
            { modal: true },
            'Stop'
        );

        if (confirmed !== 'Stop') {
            return;
        }

        try {
            const success = await this.dockerManager.stopContainer(this.config.id, containerId);
            if (success) {
                vscode.window.showInformationMessage(`Container ${displayName} stopped successfully`);
                // Refresh container list after short delay
                setTimeout(() => this.refreshContainers(), 1000);
            } else {
                vscode.window.showErrorMessage(`Failed to stop container ${displayName}`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to stop container: ${error}`);
        }
    }

    /**
     * Restart a container
     */
    private async restartContainer(containerId: string, containerName?: string) {
        const shortId = containerId.substring(0, 12);
        const displayName = containerName || shortId;

        const confirmed = await vscode.window.showWarningMessage(
            `Restart container "${displayName}"?`,
            { modal: true },
            'Restart'
        );

        if (confirmed !== 'Restart') {
            return;
        }

        try {
            const success = await this.dockerManager.restartContainer(this.config.id, containerId);
            if (success) {
                vscode.window.showInformationMessage(`Container ${displayName} restarted successfully`);
                // Refresh container list after short delay
                setTimeout(() => this.refreshContainers(), 2000);
            } else {
                vscode.window.showErrorMessage(`Failed to restart container ${displayName}`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to restart container: ${error}`);
        }
    }

    /**
     * 开始监控
     */
    private startMonitoring() {
        if (this.isMonitoring) {
            return;
        }

        this.isMonitoring = true;
        this.sendToWebview({
            type: 'monitoringStateChanged',
            isMonitoring: true
        });

        // 立即刷新一次
        this.refreshContainers();

        // 设置定时刷新
        this.refreshInterval = setInterval(() => {
            this.refreshContainers();
        }, this.refreshRate);
    }

    /**
     * 停止监控
     */
    private stopMonitoring() {
        if (!this.isMonitoring) {
            return;
        }

        this.isMonitoring = false;
        this.sendToWebview({
            type: 'monitoringStateChanged',
            isMonitoring: false
        });

        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
    }

    /**
     * 更改刷新频率
     */
    private changeRefreshRate(rate: number) {
        this.refreshRate = rate;

        // 如果正在监控，重启定时器
        if (this.isMonitoring) {
            this.stopMonitoring();
            this.startMonitoring();
        }

        this.sendToWebview({
            type: 'refreshRateChanged',
            rate: rate
        });
    }

    /**
     * 刷新容器列表
     */
    private async refreshContainers() {
        try {
            // 检查连接状态
            if (!this.sshManager.isConnected(this.config.id)) {
                this.sendToWebview({
                    type: 'error',
                    message: 'SSH 连接已断开'
                });
                this.stopMonitoring();
                return;
            }

            // 获取容器列表
            const containers = await this.dockerManager.listContainers(this.config.id);

            // 发送到前端
            this.sendToWebview({
                type: 'containers',
                data: containers,
                timestamp: new Date()
            });
        } catch (error) {
            console.error('刷新 Docker 容器列表失败:', error);
            this.sendToWebview({
                type: 'error',
                message: `获取容器列表失败: ${error}`
            });
        }
    }

    /**
     * 发送消息到 webview
     */
    private sendToWebview(message: any) {
        if (this.isDisposed) {
            return;
        }
        this.panel.webview.postMessage(message);
    }

    /**
     * 生成 HTML 内容
     */
    private getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Docker Containers</title>
    <style>
        :root {
            --toolbar-height: 36px;
            --card-border-radius: 4px;
            --font-size-small: 11px;
            --font-size-normal: 13px;
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
            font-size: var(--vscode-font-size, 13px);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 0;
            margin: 0;
            overflow: hidden;
        }

        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            height: var(--toolbar-height);
            padding: 0 16px;
            background-color: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            user-select: none;
            position: sticky;
            top: 0;
            z-index: 100;
        }

        .header-left {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .header h1 {
            font-size: var(--font-size-small);
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-foreground);
            margin: 0;
        }

        .header-subtitle {
            font-size: var(--font-size-small);
            color: var(--vscode-badge-foreground);
            background-color: var(--vscode-badge-background);
            padding: 1px 6px;
            border-radius: 10px;
        }

        .controls {
            display: flex;
            gap: 4px;
            align-items: center;
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

        select {
            height: 24px;
            padding: 0 20px 0 8px;
            border: 1px solid var(--vscode-dropdown-border, transparent);
            background-color: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border-radius: 2px;
            font-size: 11px;
            font-family: inherit;
            cursor: pointer;
            outline: none;
            appearance: none;
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'%3E%3Cpath fill='%23cccccc' d='M8 11L3 6h10l-5 5z'/%3E%3C/svg%3E");
            background-repeat: no-repeat;
            background-position: right 2px center;
            margin-right: 8px;
        }

        .status-indicator {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-size: var(--font-size-small);
            font-weight: 500;
            color: var(--vscode-descriptionForeground);
            margin-right: 12px;
        }

        .status-indicator.active {
            color: var(--vscode-testing-iconPassedColor, #10b981);
        }

        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background-color: currentColor;
        }

        .content-area {
            padding: 24px;
            height: calc(100vh - var(--toolbar-height));
            overflow-y: auto;
            background-color: var(--vscode-sideBar-background, var(--vscode-editor-background));
        }

        .container-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 20px;
        }

        .container-card {
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: var(--card-border-radius);
            padding: 20px;
            display: flex;
            flex-direction: column;
            gap: 12px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
            transition: border-color 0.2s;
        }
        
        .container-card:hover {
            border-color: var(--vscode-focusBorder);
        }

        .container-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 8px;
        }

        .container-name {
            font-weight: 600;
            font-size: 14px;
            color: var(--vscode-foreground);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .container-status {
            font-size: 10px;
            padding: 2px 8px;
            border-radius: 12px;
            font-weight: 600;
            text-transform: uppercase;
        }

        .container-status.running {
            background-color: rgba(16, 185, 129, 0.15);
            color: var(--vscode-testing-iconPassedColor, #10b981);
        }

        .container-status.exited {
            background-color: rgba(239, 68, 68, 0.15);
            color: var(--vscode-testing-iconFailedColor, #ef4444);
        }

        .container-status.paused {
            background-color: rgba(245, 158, 11, 0.15);
            color: var(--vscode-testing-iconQueuedColor, #f59e0b);
        }

        .detail-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            padding: 4px 0;
            border-bottom: 1px solid var(--vscode-panel-border);
            opacity: 0.9;
        }
        
        .detail-row:last-of-type {
            border-bottom: none;
        }

        .detail-row .value {
            font-weight: 600;
            color: var(--vscode-foreground);
        }

        .progress-bar {
            width: 100%;
            height: 4px;
            background-color: var(--vscode-widget-border, rgba(128, 128, 128, 0.1));
            border-radius: 2px;
            overflow: hidden;
            margin-top: 4px;
        }

        .progress-fill {
            height: 100%;
            background-color: var(--vscode-progressBar-background, #0e70c0);
            transition: width 0.5s ease;
        }

        .progress-fill.warning { background-color: var(--vscode-testing-iconQueuedColor, #f59e0b); }
        .progress-fill.danger { background-color: var(--vscode-testing-iconFailedColor, #ef4444); }

        .container-actions {
            display: flex;
            gap: 8px;
            margin-top: 16px;
            padding-top: 16px;
            border-top: 1px solid var(--vscode-panel-border);
        }

        .action-btn {
            flex: 1;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            height: 28px;
            padding: 0 8px;
            border: 1px solid transparent;
            border-radius: 4px;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            cursor: pointer;
            font-size: 12px;
            transition: all 0.1s;
        }

        .action-btn:hover:not(:disabled) {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }

        .action-btn:disabled {
            opacity: 0.4;
            cursor: not-allowed;
        }

        .action-btn.primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .action-btn.primary:hover:not(:disabled) {
            background-color: var(--vscode-button-hoverBackground);
        }

        .action-btn.danger {
            background-color: var(--vscode-testing-iconFailedColor, #ef4444);
            color: white;
        }

        .action-btn.danger:hover:not(:disabled) {
            opacity: 0.9;
        }

        .error-message {
            background-color: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            padding: 12px 16px;
            color: var(--vscode-inputValidation-errorForeground);
            font-size: 13px;
            margin-bottom: 24px;
            border-radius: 4px;
        }

        .last-update {
            text-align: right;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-top: 40px;
            padding: 20px 0;
            border-top: 1px solid var(--vscode-panel-border);
            font-style: italic;
        }

        .empty-state {
            grid-column: 1 / -1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 100px 20px;
            color: var(--vscode-descriptionForeground);
            text-align: center;
        }

        .empty-state-icon {
            font-size: 48px;
            margin-bottom: 20px;
            opacity: 0.3;
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="header-left">
            <h1>Docker Containers</h1>
            <span class="header-subtitle" id="hostname">-</span>
        </div>
        <div class="controls">
            <span id="statusIndicator" class="status-indicator active">
                <span class="status-dot"></span>
                Running
            </span>
            <div style="width: 1px; height: 16px; background: var(--vscode-widget-border); opacity: 0.5; margin: 0 4px;"></div>
            <select id="refreshRateSelect" title="Refresh Interval">
                <option value="5000">5s</option>
                <option value="10000" selected>10s</option>
                <option value="30000">30s</option>
                <option value="60000">1m</option>
            </select>
            <button class="icon-btn" id="toggleBtn" title="Pause Monitoring">
                <span class="icon">⏸</span>
            </button>
            <button class="icon-btn" id="refreshBtn" title="Refresh Now">
                <span class="icon">↻</span>
            </button>
        </div>
    </div>

    <div class="content-area">
        <div id="errorContainer"></div>
        <div id="containerGrid" class="container-grid">
            <div class="empty-state">
                <div class="empty-state-icon">🐳</div>
                <div class="empty-state-title">Loading containers...</div>
            </div>
        </div>

        <div class="last-update" id="lastUpdate">Waiting for data...</div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let isMonitoring = true;

        // Format bytes
        function formatBytes(bytes) {
            if (!bytes || bytes === 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
        }

        // Get status class
        function getStatusClass(status) {
            const statusLower = status.toLowerCase();
            if (statusLower.includes('up')) return 'running';
            if (statusLower.includes('exited')) return 'exited';
            if (statusLower.includes('paused')) return 'paused';
            return '';
        }

        // Update container list
        function updateContainers(containers) {
            const grid = document.getElementById('containerGrid');

            if (!containers || containers.length === 0) {
                grid.innerHTML = \`
                    <div class="empty-state">
                        <div class="empty-state-icon">🐳</div>
                        <div class="empty-state-title">No containers found</div>
                    </div>
                \`;
                return;
            }

            let html = '';
            containers.forEach(container => {
                const statusClass = getStatusClass(container.status);
                const isRunning = container.status.toLowerCase().includes('up');
                const isStopped = container.status.toLowerCase().includes('exited') ||
                                 container.status.toLowerCase().includes('created');

                html += \`
                    <div class="container-card">
                        <div class="container-header">
                            <span class="container-name" title="\${container.name}">\${container.name}</span>
                            <span class="container-status \${statusClass}">\${container.status.split(' ')[0]}</span>
                        </div>

                        <div class="detail-row">
                            <span class="label">Image</span>
                            <span class="value" title="\${container.image}">\${container.image.length > 25 ? container.image.substring(0, 25) + '...' : container.image}</span>
                        </div>

                        <div style="margin-top: 4px;">
                            <div class="detail-row">
                                <span class="label">CPU</span>
                                <span class="value">\${container.cpuPercent.toFixed(1)}%</span>
                            </div>
                            <div class="progress-bar">
                                <div class="progress-fill \${container.cpuPercent >= 90 ? 'danger' : container.cpuPercent >= 70 ? 'warning' : ''}" style="width: \${Math.min(container.cpuPercent, 100)}%"></div>
                            </div>
                        </div>

                        <div>
                            <div class="detail-row">
                                <span class="label">Memory</span>
                                <span class="value">\${formatBytes(container.memUsage)}</span>
                            </div>
                            <div class="progress-bar">
                                <div class="progress-fill \${container.memPercent >= 90 ? 'danger' : container.memPercent >= 70 ? 'warning' : ''}" style="width: \${container.memPercent}%"></div>
                            </div>
                        </div>

                        <div class="detail-row">
                            <span class="label">Network I/O</span>
                            <span class="value">↓\${formatBytes(container.netInput)} ↑\${formatBytes(container.netOutput)}</span>
                        </div>

                        <div class="container-actions">
                            <button class="action-btn \${isStopped ? 'primary' : ''}"
                                    onclick="startContainer('\${container.id}', '\${container.name}')"
                                    \${isRunning ? 'disabled' : ''}
                                    title="Start container">
                                <span class="icon">▶</span>
                            </button>
                            <button class="action-btn"
                                    onclick="restartContainer('\${container.id}', '\${container.name}')"
                                    \${!isRunning ? 'disabled' : ''}
                                    title="Restart container">
                                <span class="icon">↻</span>
                            </button>
                            <button class="action-btn \${isRunning ? 'danger' : ''}"
                                    onclick="stopContainer('\${container.id}', '\${container.name}')"
                                    \${isStopped ? 'disabled' : ''}
                                    title="Stop container">
                                <span class="icon">⏹</span>
                            </button>
                        </div>
                    </div>
                \`;
            });

            grid.innerHTML = html;
        }

        function showError(message) {
            document.getElementById('errorContainer').innerHTML =
                '<div class="error-message">' + message + '</div>';
        }

        function updateMonitoringStatus() {
            const indicator = document.getElementById('statusIndicator');
            const toggleBtn = document.getElementById('toggleBtn');

            if (isMonitoring) {
                indicator.className = 'status-indicator active';
                indicator.innerHTML = '<span class="status-dot"></span>Running';
                toggleBtn.title = 'Pause Monitoring';
                toggleBtn.innerHTML = '<span class="icon">⏸</span>';
            } else {
                indicator.className = 'status-indicator paused';
                indicator.innerHTML = '<span class="status-dot"></span>Paused';
                toggleBtn.title = 'Resume Monitoring';
                toggleBtn.innerHTML = '<span class="icon">▶</span>';
            }
        }

        function startContainer(containerId, containerName) {
            vscode.postMessage({
                type: 'startContainer',
                containerId: containerId,
                containerName: containerName
            });
        }

        function stopContainer(containerId, containerName) {
            vscode.postMessage({
                type: 'stopContainer',
                containerId: containerId,
                containerName: containerName
            });
        }

        function restartContainer(containerId, containerName) {
            vscode.postMessage({
                type: 'restartContainer',
                containerId: containerId,
                containerName: containerName
            });
        }

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'containers':
                    updateContainers(message.data);
                    const now = new Date(message.timestamp);
                    document.getElementById('lastUpdate').textContent =
                        'Last updated: ' + now.toLocaleTimeString();
                    document.getElementById('errorContainer').innerHTML = '';
                    break;

                case 'monitoringStateChanged':
                    isMonitoring = message.isMonitoring;
                    updateMonitoringStatus();
                    break;

                case 'refreshRateChanged':
                    document.getElementById('refreshRateSelect').value = message.rate;
                    break;

                case 'error':
                    showError(message.message);
                    break;
            }
        });

        document.getElementById('toggleBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'toggleMonitoring' });
        });

        document.getElementById('refreshBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'refresh' });
        });

        document.getElementById('refreshRateSelect').addEventListener('change', (e) => {
            vscode.postMessage({
                type: 'changeRefreshRate',
                rate: parseInt(e.target.value, 10)
            });
        });
    </script>
</body>
</html>`;
    }

    /**
     * 清理资源
     */
    public dispose() {
        if (this.isDisposed) {
            return;
        }
        this.isDisposed = true;

        const sessionKey = this.config.id;
        DockerPanel.panels.delete(sessionKey);

        this.stopMonitoring();
        this.panel.dispose();

        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }

    /**
     * 关闭所有面板
     */
    public static disposeAll() {
        for (const panel of DockerPanel.panels.values()) {
            panel.dispose();
        }
        DockerPanel.panels.clear();
    }
}
