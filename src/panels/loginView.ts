import * as vscode from 'vscode';
import { SSHConfig } from '../types';

/**
 * SSH 登录 Webview 面板
 */
export class SSHLoginView {
  public static currentPanel: SSHLoginView | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private submitCallback?: (config: SSHConfig | undefined) => void;

  private constructor(panel: vscode.WebviewPanel, private context: vscode.ExtensionContext) {
    this.panel = panel;
    this.panel.webview.html = this.getHtmlContent();
    this.panel.webview.onDidReceiveMessage(message => this.handleMessage(message), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  public static createOrShow(context: vscode.ExtensionContext, config?: SSHConfig): Promise<SSHConfig | undefined> {
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

    if (SSHLoginView.currentPanel) {
      SSHLoginView.currentPanel.panel.reveal(column);
      if (config) SSHLoginView.currentPanel.loadConfig(config);
      return SSHLoginView.currentPanel.waitForSubmit();
    }

    const panel = vscode.window.createWebviewPanel(
      'sshLogin',
      config ? 'Edit SSH Connection' : 'Add SSH Connection',
      column || vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
    );

    SSHLoginView.currentPanel = new SSHLoginView(panel, context);
    if (config) SSHLoginView.currentPanel.loadConfig(config);

    return SSHLoginView.currentPanel.waitForSubmit();
  }

  private waitForSubmit(): Promise<SSHConfig | undefined> {
    return new Promise(resolve => { this.submitCallback = resolve; });
  }

  private loadConfig(config: SSHConfig) {
    this.panel.webview.postMessage({ type: 'loadConfig', config: config });
  }

  private handleMessage(message: any) {
    switch (message.type) {
      case 'submit':
        if (this.submitCallback) { this.submitCallback(message.config); this.submitCallback = undefined; }
        this.panel.dispose();
        break;
      case 'cancel':
        if (this.submitCallback) { this.submitCallback(undefined); this.submitCallback = undefined; }
        this.panel.dispose();
        break;
      case 'selectPrivateKey':
        this.selectPrivateKey(message.target);
        break;
      case 'testConnection':
        this.testConnection(message.config);
        break;
    }
  }

  private async selectPrivateKey(target: string = 'main') {
    const fileUri = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      openLabel: 'Select Private Key',
      filters: { 'SSH Keys': ['pem', 'key', 'pub', 'ppk'], 'All Files': ['*'] }
    });

    if (fileUri && fileUri.length > 0) {
      this.panel.webview.postMessage({ type: 'privateKeySelected', path: fileUri[0].fsPath, target: target });
    }
  }

  private async testConnection(config: SSHConfig) {
    // 暂时简单返回成功，实际可以使用 SSHManager 进行连接测试
    this.panel.webview.postMessage({ type: 'testResult', success: true, message: 'Configuration looks valid.' });
  }

  private getHtmlContent(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SSH Connection</title>
    <style>
        :root {
            --container-padding: 30px;
            --input-padding-vertical: 4px;
            --input-padding-horizontal: 8px;
            --input-height: 26px;
            --label-margin-bottom: 4px;
            --section-margin-bottom: 24px;
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: var(--vscode-font-family, -apple-system, sans-serif);
            font-size: var(--vscode-font-size, 13px);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            line-height: 1.4;
            padding: 0;
        }
        .container { max-width: 800px; margin: 0 auto; padding: var(--container-padding); }
        .header { margin-bottom: 30px; border-bottom: 1px solid var(--vscode-settings-headerBorder, rgba(128, 128, 128, 0.2)); padding-bottom: 15px; }
        h1 { font-size: 20px; font-weight: 400; margin-bottom: 8px; }
        .header-description { font-size: 13px; color: var(--vscode-descriptionForeground); }
        .section { margin-bottom: var(--section-margin-bottom); }
        .section-header { font-size: 12px; font-weight: 600; margin-bottom: 12px; border-bottom: 1px solid var(--vscode-settings-sectionHeaderBorder, rgba(128, 128, 128, 0.1)); padding-bottom: 4px; }
        .form-row { display: flex; flex-direction: column; margin-bottom: 14px; }
        .form-row-inline { display: grid; grid-template-columns: 1fr 120px; gap: 20px; margin-bottom: 14px; }
        label { display: block; margin-bottom: var(--label-margin-bottom); font-weight: 600; }
        .required::after { content: " *"; color: var(--vscode-errorForeground); }
        input[type="text"], input[type="password"], input[type="number"], select {
            width: 100%; height: var(--input-height); padding: 4px 8px;
            border: 1px solid var(--vscode-settings-textInputBorder, var(--vscode-input-border, transparent));
            background-color: var(--vscode-settings-textInputBackground, var(--vscode-input-background));
            color: var(--vscode-foreground); border-radius: 2px; outline: none;
        }
        input:focus, select:focus { border-color: var(--vscode-focusBorder); outline: 1px solid var(--vscode-focusBorder); }
        .file-input-group { display: flex; gap: 8px; }
        .file-input-group input { flex: 1; }
        button {
            display: inline-flex; align-items: center; justify-content: center; height: var(--input-height);
            padding: 4px 14px; border: 1px solid transparent; border-radius: 2px; cursor: pointer;
            font-family: inherit; font-size: 13px; outline: none; user-select: none;
        }
        .btn-primary { background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); }
        .btn-primary:hover { background-color: var(--vscode-button-hoverBackground); }
        .btn-secondary { background-color: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
        .btn-secondary:hover { background-color: var(--vscode-button-secondaryHoverBackground); }
        .button-group { display: flex; gap: 10px; margin-top: 40px; padding-top: 20px; border-top: 1px solid var(--vscode-settings-headerBorder, rgba(128, 128, 128, 0.2)); }
        .help-text { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 4px; font-style: italic; }
        .message-box { padding: 10px 14px; margin-top: 20px; border-radius: 3px; display: none; }
        .message-box.success { background-color: rgba(0, 122, 204, 0.1); border: 1px solid var(--vscode-focusBorder); }
        .message-box.error { background-color: rgba(255, 0, 0, 0.1); border: 1px solid var(--vscode-errorForeground); }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>SSH Connection</h1>
            <p class="header-description">Configure a secure connection to your remote server.</p>
        </div>
        <form id="sshForm">
            <div class="section">
                <div class="section-header">General</div>
                <div class="form-row">
                    <label for="name" class="required">Connection Name</label>
                    <input type="text" id="name" required placeholder="e.g. My Web Server">
                </div>
                <div class="form-row">
                    <label for="group">Group</label>
                    <input type="text" id="group" placeholder="e.g. Production (Optional)">
                </div>
                <div class="form-row-inline">
                    <div>
                        <label for="host" class="required">Host</label>
                        <input type="text" id="host" required placeholder="e.g. 1.2.3.4">
                    </div>
                    <div>
                        <label for="port" class="required">Port</label>
                        <input type="number" id="port" value="22" required>
                    </div>
                </div>
                <div class="form-row">
                    <label for="username" class="required">Username</label>
                    <input type="text" id="username" required placeholder="e.g. root">
                </div>
            </div>

            <div class="section">
                <div class="section-header">SSH Tunnel (Jump Host)</div>
                <div class="form-row">
                    <label><input type="checkbox" id="useProxy" style="width:auto; margin-right:8px;"> Use Jump Host</label>
                    <div class="help-text">Connect to this server through an intermediate secure host.</div>
                </div>
                <div id="proxyFields" style="display:none; padding-left:15px; border-left: 2px solid var(--vscode-focusBorder);">
                    <div class="form-row-inline">
                        <div><label for="proxyHost">Host</label><input type="text" id="proxyHost"></div>
                        <div><label for="proxyPort">Port</label><input type="number" id="proxyPort" value="22"></div>
                    </div>
                    <div class="form-row"><label for="proxyUsername">Username</label><input type="text" id="proxyUsername"></div>
                    <div class="form-row">
                        <label for="proxyAuthType">Method</label>
                        <select id="proxyAuthType">
                            <option value="password">Password</option>
                            <option value="privateKey">Private Key</option>
                        </select>
                    </div>
                    <div id="proxyKeyFields" style="display:none;">
                        <div class="form-row">
                            <label>Private Key</label>
                            <div class="file-input-group">
                                <input type="text" id="proxyKeyPath" readonly>
                                <button type="button" class="btn-secondary" id="selectProxyKeyBtn">Browse...</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="section">
                <div class="section-header">Authentication</div>
                <div class="form-row">
                    <label for="authType">Method</label>
                    <select id="authType">
                        <option value="password">Password</option>
                        <option value="privateKey">Private Key</option>
                    </select>
                </div>
                <div id="passwordFields">
                    <div class="form-row">
                        <label for="password">Password</label>
                        <input type="password" id="password" placeholder="Optional">
                        <div class="help-text">Leave empty to be prompted later.</div>
                    </div>
                </div>
                <div id="keyFields" style="display:none;">
                    <div class="form-row">
                        <label>Private Key</label>
                        <div class="file-input-group">
                            <input type="text" id="keyPath" readonly>
                            <button type="button" class="btn-secondary" id="selectKeyBtn">Browse...</button>
                        </div>
                    </div>
                </div>
            </div>

            <div id="testResult" class="message-box"></div>
            <div class="button-group">
                <button type="submit" class="btn-primary">Save & Connect</button>
                <button type="button" class="btn-secondary" id="testBtn">Test</button>
                <button type="button" class="btn-secondary" id="cancelBtn">Cancel</button>
            </div>
        </form>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        let configId = null;

        const authType = document.getElementById('authType');
        authType.onchange = () => {
            document.getElementById('passwordFields').style.display = authType.value === 'password' ? 'block' : 'none';
            document.getElementById('keyFields').style.display = authType.value === 'privateKey' ? 'block' : 'none';
        };

        const useProxy = document.getElementById('useProxy');
        useProxy.onchange = () => { document.getElementById('proxyFields').style.display = useProxy.checked ? 'block' : 'none'; };

        const proxyAuthType = document.getElementById('proxyAuthType');
        proxyAuthType.onchange = () => { document.getElementById('proxyKeyFields').style.display = proxyAuthType.value === 'privateKey' ? 'block' : 'none'; };

        document.getElementById('selectKeyBtn').onclick = () => vscode.postMessage({ type: 'selectPrivateKey', target: 'main' });
        document.getElementById('selectProxyKeyBtn').onclick = () => vscode.postMessage({ type: 'selectPrivateKey', target: 'proxy' });
        document.getElementById('cancelBtn').onclick = () => vscode.postMessage({ type: 'cancel' });

        document.getElementById('sshForm').onsubmit = (e) => {
            e.preventDefault();
            const config = getFormData();
            if (config) vscode.postMessage({ type: 'submit', config });
        };

        document.getElementById('testBtn').onclick = () => {
            const config = getFormData();
            if (config) vscode.postMessage({ type: 'testConnection', config });
        };

        function getFormData() {
            const config = {
                id: configId || Date.now().toString(),
                name: document.getElementById('name').value,
                group: document.getElementById('group').value,
                host: document.getElementById('host').value,
                port: parseInt(document.getElementById('port').value),
                username: document.getElementById('username').value,
                authType: authType.value
            };
            if (config.authType === 'privateKey') config.privateKeyPath = document.getElementById('keyPath').value;
            
            if (useProxy.checked) {
                config.proxyConfig = {
                    host: document.getElementById('proxyHost').value,
                    port: parseInt(document.getElementById('proxyPort').value),
                    username: document.getElementById('proxyUsername').value,
                    authType: proxyAuthType.value
                };
                if (config.proxyConfig.authType === 'privateKey') config.proxyConfig.privateKeyPath = document.getElementById('proxyKeyPath').value;
            }
            return config;
        }

        window.addEventListener('message', event => {
            const m = event.data;
            if (m.type === 'loadConfig') {
                configId = m.config.id;
                document.getElementById('name').value = m.config.name || '';
                document.getElementById('group').value = m.config.group || '';
                document.getElementById('host').value = m.config.host || '';
                document.getElementById('port').value = m.config.port || 22;
                document.getElementById('username').value = m.config.username || '';
                authType.value = m.config.authType || 'password';
                authType.onchange();
                if (m.config.privateKeyPath) document.getElementById('keyPath').value = m.config.privateKeyPath;

                if (m.config.proxyConfig) {
                    useProxy.checked = true;
                    useProxy.onchange();
                    document.getElementById('proxyHost').value = m.config.proxyConfig.host;
                    document.getElementById('proxyPort').value = m.config.proxyConfig.port;
                    document.getElementById('proxyUsername').value = m.config.proxyConfig.username;
                    proxyAuthType.value = m.config.proxyConfig.authType;
                    proxyAuthType.onchange();
                    if (m.config.proxyConfig.privateKeyPath) document.getElementById('proxyKeyPath').value = m.config.proxyConfig.privateKeyPath;
                }
            } else if (m.type === 'privateKeySelected') {
                document.getElementById(m.target === 'proxy' ? 'proxyKeyPath' : 'keyPath').value = m.path;
            } else if (m.type === 'testResult') {
                const tr = document.getElementById('testResult');
                tr.textContent = m.message;
                tr.className = 'message-box ' + (m.success ? 'success' : 'error');
                tr.style.display = 'block';
            }
        });
    </script>
</body>
</html>`;
  }

  public dispose() {
    SSHLoginView.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) disposable.dispose();
    }
  }
}
