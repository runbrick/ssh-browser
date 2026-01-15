import * as vscode from 'vscode';
import { SSHManager } from '../services/sshManager';
import { SSHConfig, SystemMetrics } from '../types';
import { SystemMetricsCollector } from '../services/systemMetricsCollector';

/**
 * 服务器监控面板
 * 使用 Webview 实现实时系统监控界面
 */
export class MonitoringPanel {
    private static panels: Map<string, MonitoringPanel> = new Map();

    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private metricsCollector: SystemMetricsCollector;
    private refreshInterval: NodeJS.Timeout | null = null;
    private isMonitoring: boolean = false;
    private refreshRate: number = 10000; // 默认 10 秒刷新间隔

    private constructor(
        panel: vscode.WebviewPanel,
        private config: SSHConfig,
        private sshManager: SSHManager,
        private context: vscode.ExtensionContext
    ) {
        this.panel = panel;
        this.metricsCollector = new SystemMetricsCollector(sshManager);

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
     * 创建或显示监控面板
     */
    public static async createOrShow(
        config: SSHConfig,
        sshManager: SSHManager,
        context: vscode.ExtensionContext,
        viewColumn: vscode.ViewColumn = vscode.ViewColumn.Beside
    ): Promise<void> {
        const sessionKey = config.id;

        // 如果已经有面板，直接显示
        const existingPanel = MonitoringPanel.panels.get(sessionKey);
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
            'serverMonitoring',
            `监控: ${config.name}`,
            viewColumn,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: []
            }
        );

        const monitoringPanel = new MonitoringPanel(panel, config, sshManager, context);
        MonitoringPanel.panels.set(sessionKey, monitoringPanel);
    }

    /**
     * 处理来自 webview 的消息
     */
    private async handleMessage(message: any) {
        switch (message.type) {
            case 'refresh':
                await this.refreshMetrics();
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
        this.refreshMetrics();

        // 设置定时刷新
        this.refreshInterval = setInterval(() => {
            this.refreshMetrics();
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
     * 刷新监控指标
     */
    private async refreshMetrics() {
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

            // 采集指标
            const metrics = await this.metricsCollector.collect(this.config.id);

            // 发送到前端
            this.sendToWebview({
                type: 'metrics',
                data: metrics
            });
        } catch (error) {
            console.error('刷新监控指标失败:', error);
            this.sendToWebview({
                type: 'error',
                message: `采集指标失败: ${error}`
            });
        }
    }

    /**
     * 发送消息到 webview
     */
    private sendToWebview(message: any) {
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
    <title>Server Monitoring</title>
    <style>
        :root {
            --toolbar-height: 36px;
            --card-border-radius: 4px;
            --font-size-small: 11px;
            --font-size-normal: 13px;
            --font-size-large: 24px;
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
            color: var(--vscode-descriptionForeground);
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
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

        .icon-btn:active {
            background-color: var(--vscode-toolbar-activeBackground);
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

        .status-indicator.active .status-dot {
            box-shadow: 0 0 8px currentColor;
            animation: pulse 2s infinite;
        }

        @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.4; }
            100% { opacity: 1; }
        }

        .content-area {
            padding: 24px;
            height: calc(100vh - var(--toolbar-height));
            overflow-y: auto;
            background-color: var(--vscode-sideBar-background, var(--vscode-editor-background));
        }

        .section-title {
            font-size: var(--font-size-small);
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            color: var(--vscode-descriptionForeground);
            margin: 32px 0 16px 0;
            display: flex;
            align-items: center;
            gap: 12px;
        }
        
        .section-title:first-child {
            margin-top: 0;
        }

        .section-title::after {
            content: '';
            flex: 1;
            height: 1px;
            background-color: var(--vscode-panel-border);
            opacity: 0.3;
        }

        .metrics-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
        }

        .metric-card {
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: var(--card-border-radius);
            padding: 20px;
            display: flex;
            flex-direction: column;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }

        .metric-card:hover {
            border-color: var(--vscode-focusBorder);
        }

        .metric-card.wide {
            grid-column: span 2;
        }

        @media (max-width: 1000px) {
            .metric-card.wide {
                grid-column: span 1;
            }
        }

        .metric-card h3 {
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin: 0 0 20px 0;
            color: var(--vscode-foreground);
            display: flex;
            align-items: center;
            gap: 10px;
            opacity: 0.9;
        }

        .metric-value {
            font-size: var(--font-size-large);
            font-weight: 300;
            margin-bottom: 6px;
            color: var(--vscode-foreground);
        }

        .metric-value.small {
            font-size: 18px;
        }

        .metric-label {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 16px;
        }

        .progress-bar {
            width: 100%;
            height: 6px;
            background-color: var(--vscode-widget-border, rgba(128, 128, 128, 0.1));
            border-radius: 3px;
            overflow: hidden;
            margin-bottom: 16px;
        }

        .progress-fill {
            height: 100%;
            background-color: var(--vscode-progressBar-background, #0e70c0);
            transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .progress-fill.warning { background-color: var(--vscode-testing-iconQueuedColor, #f59e0b); }
        .progress-fill.danger { background-color: var(--vscode-testing-iconFailedColor, #ef4444); }
        .progress-fill.success { background-color: var(--vscode-testing-iconPassedColor, #10b981); }

        .detail-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            padding: 6px 0;
            border-bottom: 1px solid var(--vscode-panel-border);
            opacity: 0.8;
        }
        
        .detail-row:last-child {
            border-bottom: none;
        }

        .detail-row .value {
            font-weight: 600;
            color: var(--vscode-foreground);
        }

        .disk-list, .network-list {
            display: flex;
            flex-direction: column;
            gap: 16px;
        }

        .disk-item, .network-item {
            padding: 12px;
            background-color: var(--vscode-sideBar-background);
            border-radius: 4px;
            border: 1px solid var(--vscode-panel-border);
        }

        .disk-header, .network-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }

        .disk-name, .network-name {
            font-weight: 600;
            font-size: 12px;
            color: var(--vscode-foreground);
        }

        .system-info-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
        }

        .system-info-item {
            display: flex;
            flex-direction: column;
            gap: 6px;
            padding: 12px;
            background-color: var(--vscode-sideBar-background);
            border-radius: 4px;
            border: 1px solid var(--vscode-panel-border);
        }

        .system-info-label {
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            color: var(--vscode-descriptionForeground);
        }

        .system-info-value {
            font-size: 13px;
            color: var(--vscode-foreground);
            word-break: break-all;
        }

        .error-message {
            background-color: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            padding: 12px 16px;
            color: var(--vscode-inputValidation-errorForeground);
            font-size: 13px;
            margin-bottom: 24px;
            border-radius: 4px;
            display: flex;
            align-items: center;
            gap: 10px;
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
    </style>
</head>
<body>
    <div class="header">
        <div class="header-left">
            <h1>System Monitoring</h1>
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

        <!-- System Overview -->
        <div class="section-title">Overview</div>
        <div class="metrics-grid">
            <!-- CPU Card -->
            <div class="metric-card">
                <h3><span class="icon">⚡</span> CPU</h3>
                <div class="metric-value" id="cpuUsage">0%</div>
                <div class="metric-label" id="cpuModel">-</div>
                <div class="progress-bar">
                    <div class="progress-fill" id="cpuProgress" style="width: 0%"></div>
                </div>
                <div class="detail-row">
                    <span class="label">Cores</span>
                    <span class="value" id="cpuCores">-</span>
                </div>
            </div>

            <!-- Memory Card -->
            <div class="metric-card">
                <h3><span class="icon">📊</span> Memory</h3>
                <div class="metric-value" id="memUsage">0%</div>
                <div class="metric-label"><span id="memUsedLabel">-</span> / <span id="memTotalLabel">-</span></div>
                <div class="progress-bar">
                    <div class="progress-fill" id="memProgress" style="width: 0%"></div>
                </div>
                <div class="detail-row">
                    <span class="label">Available</span>
                    <span class="value" id="memAvailable">-</span>
                </div>
                <div class="detail-row">
                    <span class="label">Cached</span>
                    <span class="value" id="memCached">-</span>
                </div>
            </div>

            <!-- Swap Card -->
            <div class="metric-card">
                <h3><span class="icon">💾</span> Swap</h3>
                <div class="metric-value small" id="swapUsage">0%</div>
                <div class="metric-label"><span id="swapUsedLabel">-</span> / <span id="swapTotalLabel">-</span></div>
                <div class="progress-bar">
                    <div class="progress-fill" id="swapProgress" style="width: 0%"></div>
                </div>
                <div class="detail-row">
                    <span class="label">Free</span>
                    <span class="value" id="swapFree">-</span>
                </div>
            </div>

            <!-- Load Card -->
            <div class="metric-card">
                <h3><span class="icon">📈</span> Load Average</h3>
                <div class="detail-row" style="margin-top: auto;">
                    <span class="label">1 min</span>
                    <span class="value" id="load1">-</span>
                </div>
                <div class="detail-row">
                    <span class="label">5 min</span>
                    <span class="value" id="load5">-</span>
                </div>
                <div class="detail-row">
                    <span class="label">15 min</span>
                    <span class="value" id="load15">-</span>
                </div>
                <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));">
                    <div class="detail-row">
                        <span class="label">Processes</span>
                        <span class="value" id="processCount">-</span>
                    </div>
                    <div class="detail-row">
                        <span class="label">Users</span>
                        <span class="value" id="userCount">-</span>
                    </div>
                </div>
            </div>
        </div>

        <!-- Disk Storage -->
        <div class="section-title">Storage</div>
        <div class="metrics-grid">
            <div class="metric-card wide">
                <h3><span class="icon">💿</span> Disk Usage</h3>
                <div class="disk-list" id="diskList">
                    <div style="color: var(--vscode-descriptionForeground); font-size: 12px;">Loading...</div>
                </div>
            </div>
        </div>

        <!-- Network -->
        <div class="section-title">Network</div>
        <div class="metrics-grid">
            <div class="metric-card wide">
                <h3><span class="icon">🌐</span> Network Interfaces</h3>
                <div class="network-list" id="networkList">
                    <div style="color: var(--vscode-descriptionForeground); font-size: 12px;">Loading...</div>
                </div>
            </div>
        </div>

        <!-- System Info -->
        <div class="section-title">System Info</div>
        <div class="metrics-grid">
            <div class="metric-card wide">
                <h3><span class="icon">🖥️</span> Details</h3>
                <div class="system-info-grid" id="systemInfo">
                    <div class="system-info-item">
                        <span class="system-info-label">Uptime</span>
                        <span class="system-info-value" id="uptime">-</span>
                    </div>
                    <div class="system-info-item">
                        <span class="system-info-label">OS</span>
                        <span class="system-info-value" id="osInfo">-</span>
                    </div>
                    <div class="system-info-item">
                        <span class="system-info-label">Kernel</span>
                        <span class="system-info-value" id="kernelInfo">-</span>
                    </div>
                    <div class="system-info-item">
                        <span class="system-info-label">Hostname</span>
                        <span class="system-info-value" id="hostnameInfo">-</span>
                    </div>
                </div>
            </div>
        </div>

        <div class="last-update" id="lastUpdate">Waiting for data...</div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let isMonitoring = true;

        function formatBytes(bytes) {
            if (!bytes || bytes === 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
        }

        function formatUptime(seconds) {
            if (!seconds) return '-';
            const days = Math.floor(seconds / 86400);
            const hours = Math.floor((seconds % 86400) / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            
            let result = '';
            if (days > 0) result += days + 'd ';
            if (hours > 0 || days > 0) result += hours + 'h ';
            result += minutes + 'm';
            return result;
        }

        function updateProgressColor(element, percent) {
            element.classList.remove('warning', 'danger', 'success');
            if (percent >= 90) {
                element.classList.add('danger');
            } else if (percent >= 70) {
                element.classList.add('warning');
            } else if (percent <= 30) {
                element.classList.add('success');
            }
        }

        function updateMetrics(metrics) {
            if (metrics.system && metrics.system.hostname) {
                document.getElementById('hostname').textContent = metrics.system.hostname;
                document.getElementById('hostnameInfo').textContent = metrics.system.hostname;
            }

            // CPU
            const cpuUsage = Math.round(metrics.cpu.usage);
            document.getElementById('cpuUsage').textContent = cpuUsage + '%';
            document.getElementById('cpuCores').textContent = metrics.cpu.cores + ' Cores';
            if (metrics.cpu.model) {
                document.getElementById('cpuModel').textContent = metrics.cpu.model;
            }
            const cpuProgress = document.getElementById('cpuProgress');
            cpuProgress.style.width = cpuUsage + '%';
            updateProgressColor(cpuProgress, cpuUsage);

            // Memory
            const memUsage = Math.round(metrics.memory.usagePercent);
            document.getElementById('memUsage').textContent = memUsage + '%';
            document.getElementById('memUsedLabel').textContent = formatBytes(metrics.memory.used);
            document.getElementById('memTotalLabel').textContent = formatBytes(metrics.memory.total);
            document.getElementById('memAvailable').textContent = formatBytes(metrics.memory.available);
            
            const cached = (metrics.memory.cached || 0) + (metrics.memory.buffers || 0);
            document.getElementById('memCached').textContent = formatBytes(cached);
            
            const memProgress = document.getElementById('memProgress');
            memProgress.style.width = memUsage + '%';
            updateProgressColor(memProgress, memUsage);

            // Swap
            if (metrics.swap) {
                const swapUsage = Math.round(metrics.swap.usagePercent || 0);
                document.getElementById('swapUsage').textContent = swapUsage + '%';
                document.getElementById('swapUsedLabel').textContent = formatBytes(metrics.swap.used);
                document.getElementById('swapTotalLabel').textContent = formatBytes(metrics.swap.total);
                document.getElementById('swapFree').textContent = formatBytes(metrics.swap.free);
                const swapProgress = document.getElementById('swapProgress');
                swapProgress.style.width = swapUsage + '%';
                updateProgressColor(swapProgress, swapUsage);
            }

            // Load
            document.getElementById('load1').textContent = metrics.load.load1.toFixed(2);
            document.getElementById('load5').textContent = metrics.load.load5.toFixed(2);
            document.getElementById('load15').textContent = metrics.load.load15.toFixed(2);

            // Processes
            if (metrics.system) {
                document.getElementById('processCount').textContent = metrics.system.processCount || '-';
                document.getElementById('userCount').textContent = metrics.system.userCount || '-';
                document.getElementById('uptime').textContent = formatUptime(metrics.system.uptime);
                document.getElementById('osInfo').textContent = metrics.system.os || '-';
                document.getElementById('kernelInfo').textContent = metrics.system.kernel || '-';
            }

            // Disks
            if (metrics.disks && metrics.disks.length > 0) {
                let diskHtml = '';
                metrics.disks.forEach(disk => {
                    diskHtml += \`
                        <div class="disk-item">
                            <div class="disk-header">
                                <span class="disk-name">\${disk.mountPoint}</span>
                                <span class="disk-usage">\${disk.usagePercent}% Used</span>
                            </div>
                            <div class="progress-bar">
                                <div class="progress-fill \${disk.usagePercent >= 90 ? 'danger' : disk.usagePercent >= 70 ? 'warning' : ''}" style="width: \${disk.usagePercent}%"></div>
                            </div>
                            <div class="detail-row">
                                <span class="value">\${disk.filesystem}</span>
                                <span class="value">\${formatBytes(disk.used)} / \${formatBytes(disk.total)}</span>
                            </div>
                        </div>
                    \`;
                });
                document.getElementById('diskList').innerHTML = diskHtml;
            } else {
                document.getElementById('diskList').innerHTML = '<div style="color: var(--vscode-descriptionForeground); font-size: 12px;">No disk data available</div>';
            }

            // Network
            if (metrics.network && metrics.network.length > 0) {
                let netHtml = '';
                metrics.network.forEach(net => {
                    netHtml += \`
                        <div class="network-item">
                            <div class="network-header">
                                <span class="network-name">\${net.interface}</span>
                            </div>
                            <div class="detail-row">
                                <span class="label">↓ RX</span>
                                <span class="value">\${formatBytes(net.rxBytes)}</span>
                            </div>
                            <div class="detail-row">
                                <span class="label">↑ TX</span>
                                <span class="value">\${formatBytes(net.txBytes)}</span>
                            </div>
                            <div class="detail-row">
                                <span class="label">Packets</span>
                                <span class="value">RX: \${net.rxPackets.toLocaleString()} / TX: \${net.txPackets.toLocaleString()}</span>
                            </div>
                        </div>
                    \`;
                });
                document.getElementById('networkList').innerHTML = netHtml;
            } else {
                document.getElementById('networkList').innerHTML = '<div style="color: var(--vscode-descriptionForeground); font-size: 12px;">No network data available</div>';
            }

            const now = new Date(metrics.timestamp);
            document.getElementById('lastUpdate').textContent =
                'Last updated: ' + now.toLocaleTimeString();
            document.getElementById('errorContainer').innerHTML = '';
        }

        function showError(message) {
            document.getElementById('errorContainer').innerHTML =
                '<div class="error-message">' + message + '</div>';
        }

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'metrics':
                    updateMetrics(message.data);
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
        const sessionKey = this.config.id;
        MonitoringPanel.panels.delete(sessionKey);

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
        for (const panel of MonitoringPanel.panels.values()) {
            panel.dispose();
        }
        MonitoringPanel.panels.clear();
    }
}
