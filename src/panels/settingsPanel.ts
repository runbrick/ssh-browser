import * as vscode from 'vscode';

/**
 * 设置面板
 * 提供可视化的设置界面
 */
export class SettingsPanel {
  private static currentPanel: SettingsPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private context: vscode.ExtensionContext
  ) {
    this.panel = panel;

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
  }

  /**
   * 创建或显示设置面板
   */
  public static createOrShow(context: vscode.ExtensionContext): void {
    // 如果已经有面板，直接显示
    if (SettingsPanel.currentPanel) {
      SettingsPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    // 创建新面板
    const panel = vscode.window.createWebviewPanel(
      'sshBrowserSettings',
      'SSH Browser Settings',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: []
      }
    );

    SettingsPanel.currentPanel = new SettingsPanel(panel, context);
  }

  /**
   * 处理来自 webview 的消息
   */
  private async handleMessage(message: any) {
    switch (message.type) {
      case 'getSetting':
        // 获取配置值
        const config = vscode.workspace.getConfiguration(message.section);
        const value = config.get(message.key, message.default);
        this.sendToWebview({
          type: 'settingValue',
          key: message.fullKey,
          value: value
        });
        break;

      case 'setSetting':
        // 更新配置值
        try {
          const cfg = vscode.workspace.getConfiguration(message.section);
          await cfg.update(message.key, message.value, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage('Settings saved successfully');
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to save settings: ${error}`);
        }
        break;

      case 'resetSettings':
        // 重置所有设置为默认值
        try {
          const terminalConfig = vscode.workspace.getConfiguration('sshBrowser.terminal');
          const fileManagerConfig = vscode.workspace.getConfiguration('sshBrowser.fileManager');

          await terminalConfig.update('rightClickBehavior', undefined, vscode.ConfigurationTarget.Global);
          await terminalConfig.update('theme', undefined, vscode.ConfigurationTarget.Global);
          await fileManagerConfig.update('syncWithTerminal', undefined, vscode.ConfigurationTarget.Global);

          vscode.window.showInformationMessage('Settings reset to defaults');

          // 重新加载设置到界面
          this.sendToWebview({ type: 'reloadSettings' });
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to reset settings: ${error}`);
        }
        break;
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
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SSH Browser Settings</title>
    <style>
        :root {
            --input-height: 28px;
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
            font-size: var(--vscode-font-size, 13px);
            font-weight: var(--vscode-font-weight, 400);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            line-height: 1.4;
            padding: 0;
        }

        .container {
            max-width: 800px;
            margin: 0 auto;
            padding: 20px 40px;
        }

        .header {
            margin-bottom: 30px;
        }

        h1 {
            font-size: 28px;
            font-weight: 500;
            margin-bottom: 8px;
            color: var(--vscode-settings-headerForeground, var(--vscode-foreground));
        }

        .settings-group {
            margin-bottom: 30px;
        }

        .settings-group-title {
            font-size: 14px;
            font-weight: 600;
            color: var(--vscode-settings-headerForeground, var(--vscode-foreground));
            margin-bottom: 12px;
            line-height: 1.4;
        }

        .setting-row {
            padding: 12px 0;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }

        .setting-row + .setting-row {
            border-top: 1px solid var(--vscode-settings-rowHoverBackground, rgba(128, 128, 128, 0.1));
        }

        .setting-header {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }

        .setting-title {
            font-size: 13px;
            font-weight: 500;
            color: var(--vscode-settings-headerForeground, var(--vscode-foreground));
        }

        .setting-description {
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
            line-height: 1.5;
        }

        .setting-control {
            margin-top: 4px;
        }

        select {
            height: var(--input-height);
            padding: 2px 24px 2px 8px;
            background-color: var(--vscode-settings-dropdownBackground, var(--vscode-dropdown-background));
            color: var(--vscode-settings-dropdownForeground, var(--vscode-dropdown-foreground));
            border: 1px solid var(--vscode-settings-dropdownBorder, var(--vscode-dropdown-border, transparent));
            border-radius: 2px;
            font-family: inherit;
            font-size: inherit;
            cursor: pointer;
            outline: none;
            min-width: 250px;
        }

        select:focus {
            border-color: var(--vscode-focusBorder);
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
        }

        /* Standard VS Code Checkbox Style */
        .checkbox-wrapper {
            display: flex;
            align-items: center;
            gap: 8px;
            cursor: pointer;
            user-select: none;
        }

        .checkbox-wrapper input[type="checkbox"] {
            appearance: none;
            width: 18px;
            height: 18px;
            border: 1px solid var(--vscode-settings-checkboxBorder, var(--vscode-checkbox-border, #6b6b6b));
            border-radius: 3px;
            background-color: var(--vscode-settings-checkboxBackground, var(--vscode-checkbox-background, transparent));
            cursor: pointer;
            position: relative;
            margin: 0;
        }

        .checkbox-wrapper input[type="checkbox"]:checked {
            background-color: var(--vscode-settings-checkboxBackground, var(--vscode-checkbox-background, #007acc));
            border-color: var(--vscode-settings-checkboxBorder, var(--vscode-checkbox-border, #007acc));
        }

        .checkbox-wrapper input[type="checkbox"]:checked::after {
            content: '';
            position: absolute;
            left: 5px;
            top: 2px;
            width: 4px;
            height: 9px;
            border: solid var(--vscode-settings-checkboxForeground, var(--vscode-checkbox-foreground, #fff));
            border-width: 0 2px 2px 0;
            transform: rotate(45deg);
        }

        .checkbox-wrapper input[type="checkbox"]:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: 1px;
        }

        .checkbox-wrapper .checkbox-label {
            font-size: 13px;
            color: var(--vscode-foreground);
        }

        .theme-preview {
            display: flex;
            gap: 8px;
            margin-top: 8px;
            flex-wrap: wrap;
        }

        .theme-sample {
            width: 60px;
            height: 40px;
            border-radius: 4px;
            font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
            font-size: 10px;
            border: 2px solid transparent;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            text-align: center;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }

        .theme-sample:hover {
            border-color: var(--vscode-focusBorder);
        }

        .theme-sample.selected {
            border-color: var(--vscode-focusBorder);
            outline: 2px solid var(--vscode-focusBorder);
            outline-offset: 2px;
        }

        .button-group {
            display: flex;
            gap: 8px;
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid var(--vscode-settings-headerBorder, rgba(128, 128, 128, 0.2));
        }

        button {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            height: var(--input-height);
            padding: 0 16px;
            border: none;
            border-radius: 2px;
            font-size: inherit;
            font-family: inherit;
            font-weight: 500;
            cursor: pointer;
            outline: none;
        }

        button:focus-visible {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: 2px;
        }

        button.primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        button.primary:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        button.secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        button.secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Settings</h1>
        </div>

        <!-- SSH Terminal Settings -->
        <div class="settings-group">
            <div class="settings-group-title">Terminal</div>

            <div class="setting-row">
                <div class="setting-header">
                    <span class="setting-title">Right Click Behavior</span>
                    <span class="setting-description">Choose the action when right-clicking in the terminal.</span>
                </div>
                <div class="setting-control">
                    <select id="rightClickBehavior">
                        <option value="contextMenu">Show Context Menu</option>
                        <option value="paste">Paste from Clipboard</option>
                    </select>
                </div>
            </div>

            <div class="setting-row">
                <div class="setting-header">
                    <span class="setting-title">Terminal Theme</span>
                    <span class="setting-description">Select a color scheme for the SSH terminal.</span>
                </div>
                <div class="setting-control">
                    <select id="theme">
                        <option value="default">Default</option>
                        <option value="dark">Dark</option>
                        <option value="light">Light</option>
                        <option value="solarizedDark">Solarized Dark</option>
                        <option value="solarizedLight">Solarized Light</option>
                    </select>
                </div>
                <div class="theme-preview">
                    <div class="theme-sample" data-theme="default" style="background: #1e1e1e; color: #d4d4d4;" title="Default">abc</div>
                    <div class="theme-sample" data-theme="dark" style="background: #000000; color: #ffffff;" title="Dark">abc</div>
                    <div class="theme-sample" data-theme="light" style="background: #ffffff; color: #333333;" title="Light">abc</div>
                    <div class="theme-sample" data-theme="solarizedDark" style="background: #002b36; color: #839496;" title="Solarized Dark">abc</div>
                    <div class="theme-sample" data-theme="solarizedLight" style="background: #fdf6e3; color: #657b83;" title="Solarized Light">abc</div>
                </div>
            </div>
        </div>

        <!-- File Manager Settings -->
        <div class="settings-group">
            <div class="settings-group-title">File Manager</div>

            <div class="setting-row">
                <div class="setting-header">
                    <span class="setting-title">Sync with Terminal</span>
                    <span class="setting-description">Automatically navigate to match the terminal's current directory.</span>
                </div>
                <div class="setting-control">
                    <label class="checkbox-wrapper">
                        <input type="checkbox" id="syncWithTerminal">
                        <span class="checkbox-label">Enable directory synchronization</span>
                    </label>
                </div>
            </div>
        </div>

        <!-- Action Buttons -->
        <div class="button-group">
            <button class="primary" id="saveBtn">Save Settings</button>
            <button class="secondary" id="resetBtn">Reset Defaults</button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        // 设置项配置
        const settings = {
            rightClickBehavior: { section: 'sshBrowser.terminal', key: 'rightClickBehavior', default: 'contextMenu' },
            theme: { section: 'sshBrowser.terminal', key: 'theme', default: 'default' },
            syncWithTerminal: { section: 'sshBrowser.fileManager', key: 'syncWithTerminal', default: false }
        };

        // 加载设置
        function loadSettings() {
            Object.entries(settings).forEach(([id, config]) => {
                vscode.postMessage({
                    type: 'getSetting',
                    section: config.section,
                    key: config.key,
                    default: config.default,
                    fullKey: id
                });
            });
        }

        // 保存设置
        document.getElementById('saveBtn').addEventListener('click', () => {
            Object.entries(settings).forEach(([id, config]) => {
                const element = document.getElementById(id);
                let value;

                if (element.type === 'checkbox') {
                    value = element.checked;
                } else {
                    value = element.value;
                }

                vscode.postMessage({
                    type: 'setSetting',
                    section: config.section,
                    key: config.key,
                    value: value
                });
            });
        });

        // 重置设置
        document.getElementById('resetBtn').addEventListener('click', () => {
            if (confirm('Are you sure you want to reset all settings to defaults?')) {
                vscode.postMessage({
                    type: 'resetSettings'
                });
            }
        });

        // 主题选择联动
        const themeSelect = document.getElementById('theme');
        const themeSamples = document.querySelectorAll('.theme-sample');

        function updateThemePreview(themeValue) {
            themeSamples.forEach(sample => {
                if (sample.dataset.theme === themeValue) {
                    sample.classList.add('selected');
                } else {
                    sample.classList.remove('selected');
                }
            });
        }

        themeSelect.addEventListener('change', (e) => {
            updateThemePreview(e.target.value);
        });

        themeSamples.forEach(sample => {
            sample.addEventListener('click', () => {
                const themeValue = sample.dataset.theme;
                themeSelect.value = themeValue;
                updateThemePreview(themeValue);
            });
        });

        // 接收来自扩展的消息
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'settingValue':
                    const element = document.getElementById(message.key);
                    if (element) {
                        if (element.type === 'checkbox') {
                            element.checked = message.value;
                        } else {
                            element.value = message.value;
                            // 如果是主题设置，更新预览
                            if (message.key === 'theme') {
                                updateThemePreview(message.value);
                            }
                        }
                    }
                    break;
                case 'reloadSettings':
                    loadSettings();
                    break;
            }
        });

        // 初始化时加载设置
        loadSettings();
    </script>
</body>
</html>`;
  }

  /**
   * 清理资源
   */
  public dispose() {
    SettingsPanel.currentPanel = undefined;

    this.panel.dispose();

    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}
