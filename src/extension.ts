import * as vscode from 'vscode';
import { SSHManager } from './services/sshManager';
import { SSHConnectionProvider, SSHConnectionTreeItem, SSHGroupTreeItem } from './providers/connectionProvider';
import { SSHLoginView } from './panels/loginView';
import { SSHFileSystemProvider } from './providers/sshFileSystemProvider';
import { SSHSessionPanel } from './panels/sshSessionPanel';
import { FileManagerPanel } from './panels/fileManagerPanel';
import { MonitoringPanel } from './panels/monitoringPanel';
import { DockerPanel } from './panels/dockerPanel';
import { ConnectionStatus, SSHConfig } from './types';
import { TerminalManager } from './utils/terminalManager';

/**
 * 插件激活时调用
 */
export async function activate(context: vscode.ExtensionContext) {
  console.log('SSH Browser extension is now active!');

  // 创建核心管理器
  const sshManager = new SSHManager(context);
  const connectionProvider = new SSHConnectionProvider(context, sshManager);
  const fileSystemProvider = new SSHFileSystemProvider(sshManager);
  const terminalManager = new TerminalManager(sshManager, context);

  // 注册文件系统提供者
  const fileSystemDisposable = vscode.workspace.registerFileSystemProvider('ssh', fileSystemProvider, {
    isCaseSensitive: true,
    isReadonly: false
  });

  // 注册树视图
  const treeView = vscode.window.createTreeView('sshBrowser', {
    treeDataProvider: connectionProvider,
    showCollapseAll: true,
    dragAndDropController: connectionProvider
  });

  // 注册分组管理命令
  const addGroupCommand = vscode.commands.registerCommand('sshBrowser.addGroup', () => connectionProvider.addGroup());
  const renameGroupCommand = vscode.commands.registerCommand('sshBrowser.renameGroup', (item: SSHGroupTreeItem) => connectionProvider.renameGroup(item));
  const deleteGroupCommand = vscode.commands.registerCommand('sshBrowser.deleteGroup', (item: SSHGroupTreeItem) => connectionProvider.deleteGroup(item));

  // 恢复终端会话
  try {
    const connections = connectionProvider.getAllConnections();
    await terminalManager.restoreSessions(connections);
  } catch (error) {
    console.error('Failed to restore terminal sessions:', error);
  }

  // 注册命令：添加新连接（使用 Webview）
  const addConnectionCommand = vscode.commands.registerCommand(
    'sshBrowser.addConnection',
    async () => {
      const config = await SSHLoginView.createOrShow(context);
      if (config) {
        await connectionProvider.updateConnection(config);
      }
    }
  );

  // 注册命令：连接到服务器
  const connectCommand = vscode.commands.registerCommand(
    'sshBrowser.connect',
    async (item: SSHConnectionTreeItem) => {
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Connecting to ${item.connection.name}...`,
            cancellable: false
          },
          async () => {
            await sshManager.connect(item.connection);
          }
        );

        connectionProvider.refresh();
      } catch (error) {
        vscode.window.showErrorMessage(`Connection failed: ${error}`);
      }
    }
  );

  // 注册命令：断开连接
  const disconnectCommand = vscode.commands.registerCommand(
    'sshBrowser.disconnect',
    async (item: SSHConnectionTreeItem) => {
      await sshManager.disconnect(item.connection.id, true);
      connectionProvider.refresh();
      vscode.window.showInformationMessage(`Disconnected from ${item.connection.name}`);
    }
  );

  // 注册命令：编辑连接（使用 Webview）
  const editConnectionCommand = vscode.commands.registerCommand(
    'sshBrowser.editConnection',
    async (item: SSHConnectionTreeItem) => {
      const updatedConfig = await SSHLoginView.createOrShow(context, item.connection);
      if (updatedConfig) {
        await connectionProvider.updateConnection(updatedConfig);
      }
    }
  );

  // 注册命令：删除连接
  const deleteConnectionCommand = vscode.commands.registerCommand(
    'sshBrowser.deleteConnection',
    async (item: SSHConnectionTreeItem) => {
      await connectionProvider.deleteConnection(item);
    }
  );

  // 注册命令：刷新
  const refreshCommand = vscode.commands.registerCommand(
    'sshBrowser.refresh',
    () => {
      connectionProvider.refresh();
    }
  );

  // 注册命令：打开文件管理器面板
  const openFileSystemCommand = vscode.commands.registerCommand(
    'sshBrowser.openFileSystem',
    async (item: SSHConnectionTreeItem) => {
      try {
        await FileManagerPanel.createOrShow(item.connection, sshManager, context, vscode.ViewColumn.Beside);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to open file manager: ${error}`);
      }
    }
  );

  // 追踪点击时间以模拟双击
  const clickTracker = new Map<string, number>();
  const DOUBLE_CLICK_DELAY = 500; // 毫秒

  // 注册命令：打开 SSH 会话面板
  const openSessionCommand = vscode.commands.registerCommand(
    'sshBrowser.openSession',
    async (item: SSHConnectionTreeItem | SSHConfig) => {
      const config = 'connection' in item ? item.connection : item;
      
      // 如果是 TreeItem 触发（即来自视图点击），则判断双击
      if ('connection' in item) {
        const now = Date.now();
        const lastClick = clickTracker.get(config.id) || 0;
        if (now - lastClick > DOUBLE_CLICK_DELAY) {
          // 第一次点击，仅记录时间
          clickTracker.set(config.id, now);
          return;
        }
        // 500ms 内的第二次点击，视为双击，继续执行
        clickTracker.delete(config.id);
      }

      try {
        await SSHSessionPanel.createOrShow(config, sshManager, context);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to open SSH session: ${error}`);
      }
    }
  );

  // 注册命令：打开服务器监控面板
  const openMonitoringCommand = vscode.commands.registerCommand(
    'sshBrowser.openMonitoring',
    async (item: SSHConnectionTreeItem) => {
      try {
        await MonitoringPanel.createOrShow(item.connection, sshManager, context, vscode.ViewColumn.Beside);
      } catch (error) {
        vscode.window.showErrorMessage(`打开监控面板失败: ${error}`);
      }
    }
  );

  // 注册命令：打开 Docker 容器管理面板
  const openDockerCommand = vscode.commands.registerCommand(
    'sshBrowser.openDocker',
    async (item: SSHConnectionTreeItem) => {
      try {
        await DockerPanel.createOrShow(item.connection, sshManager, context, vscode.ViewColumn.Beside);
      } catch (error) {
        vscode.window.showErrorMessage(`打开 Docker 面板失败: ${error}`);
      }
    }
  );

  // 将所有组件添加到订阅列表，确保正确清理
  context.subscriptions.push(
    treeView,
    fileSystemDisposable,
    addConnectionCommand,
    connectCommand,
    disconnectCommand,
    editConnectionCommand,
    deleteConnectionCommand,
    openFileSystemCommand,
    openSessionCommand,
    openMonitoringCommand,
    openDockerCommand,
    addGroupCommand,
    renameGroupCommand,
    deleteGroupCommand,
    refreshCommand,
    {
      dispose: () => {
        sshManager.dispose();
        terminalManager.dispose();
        fileSystemProvider.dispose();
        SSHSessionPanel.disposeAll();
        FileManagerPanel.disposeAll();
        MonitoringPanel.disposeAll();
        DockerPanel.disposeAll();
      }
    }
  );

  // 显示欢迎消息
  vscode.window.showInformationMessage('SSH Browser is ready! Click the SSH icon in the Activity Bar to get started.');
}

/**
 * 插件停用时调用
 */
export function deactivate() {
  console.log('SSH Browser extension is now deactivated');
}
