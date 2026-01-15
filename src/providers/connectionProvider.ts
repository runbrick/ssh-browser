import * as vscode from 'vscode';
import { SSHConfig, SSHConnection, ConnectionStatus } from '../types';
import { SSHManager } from '../services/sshManager';
import * as path from 'path';

/**
 * SSH 分组树节点
 */
export class SSHGroupTreeItem extends vscode.TreeItem {
  constructor(
    public readonly name: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(name, collapsibleState);
    this.contextValue = 'sshGroup';
    this.iconPath = new vscode.ThemeIcon('folder-library');
  }
}

/**
 * SSH 连接树节点
 */
export class SSHConnectionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly connection: SSHConnection,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    private readonly sshManager: SSHManager
  ) {
    super(connection.name, collapsibleState);

    this.tooltip = `${connection.username}@${connection.host}:${connection.port}`;
    this.description = connection.proxyConfig ? `via ${connection.proxyConfig.host}` : `${connection.host}:${connection.port}`;

    const status = sshManager.getConnectionStatus(connection.id);

    // 设置默认命令（双击触发）
    this.command = {
      command: 'sshBrowser.openSession',
      title: 'Open SSH Session',
      arguments: [this]
    };

    switch (status) {
      case ConnectionStatus.Connected:
        this.iconPath = new vscode.ThemeIcon('vm-active', new vscode.ThemeColor('testing.iconPassed'));
        this.contextValue = 'sshConnectionActive';
        break;
      case ConnectionStatus.Connecting:
        this.iconPath = new vscode.ThemeIcon('sync~spin');
        this.contextValue = 'sshConnectionConnecting';
        break;
      case ConnectionStatus.Failed:
        this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
        this.contextValue = 'sshConnection';
        break;
      default:
        this.iconPath = new vscode.ThemeIcon('server');
        this.contextValue = 'sshConnection';
    }
  }
}

/**
 * SSH 连接提供者
 */
export class SSHConnectionProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.TreeDragAndDropController<vscode.TreeItem> {
  dropMimeTypes = ['application/vnd.code.tree.sshBrowser'];
  dragMimeTypes = ['application/vnd.code.tree.sshBrowser'];

  private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> =
    new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  private connections: SSHConnection[] = [];
  private groups: string[] = [];
  private context: vscode.ExtensionContext;
  private sshManager: SSHManager;

  constructor(context: vscode.ExtensionContext, sshManager: SSHManager) {
    this.context = context;
    this.sshManager = sshManager;
    this.loadData();

    // 监听连接状态变化
    this.sshManager.onDidChangeConnectionStatus(() => {
      this.refresh();
    });
  }

  // 实现拖拽
  public handleDrag(source: vscode.TreeItem[], dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): void {
    if (source[0] instanceof SSHConnectionTreeItem) {
      dataTransfer.set('application/vnd.code.tree.sshBrowser', new vscode.DataTransferItem(source[0].connection.id));
    }
  }

  // 实现放置
  public async handleDrop(target: vscode.TreeItem | undefined, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
    const transferItem = dataTransfer.get('application/vnd.code.tree.sshBrowser');
    if (!transferItem) return;

    const connectionId = transferItem.value;
    const connection = this.connections.find(c => c.id === connectionId);
    if (!connection) return;

    let targetGroup: string | undefined;
    if (target instanceof SSHGroupTreeItem) {
      targetGroup = target.name;
    } else if (target === undefined) {
      targetGroup = undefined; // 拖到空白区域表示取消分组
    } else if (target instanceof SSHConnectionTreeItem) {
      targetGroup = target.connection.group; // 拖到另一个连接上，则加入该连接所在的组
    }

    if (connection.group !== targetGroup) {
      connection.group = targetGroup;
      await this.saveData();
      this.refresh();
    }
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
    if (!element) {
      const items: vscode.TreeItem[] = [];
      [...this.groups].sort().forEach(group => {
        items.push(new SSHGroupTreeItem(group, vscode.TreeItemCollapsibleState.Collapsed));
      });
      const ungroupedConnections = this.connections.filter(conn => !conn.group || !this.groups.includes(conn.group));
      items.push(...ungroupedConnections.map(
        conn => new SSHConnectionTreeItem(conn, vscode.TreeItemCollapsibleState.None, this.sshManager)
      ));
      return Promise.resolve(items);
    }
    if (element instanceof SSHGroupTreeItem) {
      return Promise.resolve(
        this.connections
          .filter(conn => conn.group === element.name)
          .map(conn => new SSHConnectionTreeItem(conn, vscode.TreeItemCollapsibleState.None, this.sshManager))
      );
    }
    return Promise.resolve([]);
  }

  private async loadData(): Promise<void> {
    const storedConnections = this.context.workspaceState.get<SSHConnection[]>('sshConnections', []);
    this.connections = storedConnections.map(conn => ({
      ...conn,
      status: ConnectionStatus.Disconnected
    }));
    this.groups = this.context.workspaceState.get<string[]>('sshGroups', []);
    if (this.groups.length === 0) {
      const extractedGroups = new Set<string>();
      this.connections.forEach(c => { if (c.group) extractedGroups.add(c.group); });
      if (extractedGroups.size > 0) {
        this.groups = Array.from(extractedGroups);
        await this.saveData();
      }
    }
  }

  private async saveData(): Promise<void> {
    await this.context.workspaceState.update('sshConnections', this.connections);
    await this.context.workspaceState.update('sshGroups', this.groups);
  }

  async addGroup(): Promise<void> {
    const name = await vscode.window.showInputBox({ prompt: 'Enter group name', placeHolder: 'e.g. Production, Staging' });
    if (name && !this.groups.includes(name)) {
      this.groups.push(name);
      await this.saveData();
      this.refresh();
    }
  }

  async renameGroup(item: SSHGroupTreeItem): Promise<void> {
    const newName = await vscode.window.showInputBox({ prompt: 'Enter new name', value: item.name });
    if (newName && newName !== item.name) {
      const index = this.groups.indexOf(item.name);
      if (index !== -1) this.groups[index] = newName;
      this.connections.forEach(conn => { if (conn.group === item.name) conn.group = newName; });
      await this.saveData();
      this.refresh();
    }
  }

  async deleteGroup(item: SSHGroupTreeItem): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(`Delete group "${item.name}"?`, { modal: true }, 'Delete');
    if (confirmed === 'Delete') {
      this.groups = this.groups.filter(g => g !== item.name);
      this.connections.forEach(conn => { if (conn.group === item.name) delete conn.group; });
      await this.saveData();
      this.refresh();
    }
  }

  getAllConnections(): SSHConnection[] { return this.connections; }
  getConnection(connectionId: string): SSHConnection | undefined { return this.connections.find(c => c.id === connectionId); }

  async deleteConnection(item: SSHConnectionTreeItem): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(`Delete "${item.connection.name}"?`, { modal: true }, 'Delete');
    if (confirmed === 'Delete') {
      if (this.sshManager.isConnected(item.connection.id)) await this.sshManager.disconnect(item.connection.id);
      this.connections = this.connections.filter(c => c.id !== item.connection.id);
      await this.saveData();
      this.refresh();
    }
  }

  async updateConnection(config: SSHConfig): Promise<void> {
    const index = this.connections.findIndex(c => c.id === config.id);
    const connection: SSHConnection = { ...config, status: ConnectionStatus.Disconnected };
    if (index !== -1) this.connections[index] = connection;
    else this.connections.push(connection);
    if (config.group && !this.groups.includes(config.group)) this.groups.push(config.group);
    await this.saveData();
    this.refresh();
  }

  private async promptProxyConfig(): Promise<any | undefined> {
    const host = await vscode.window.showInputBox({ prompt: 'Jump Host address' });
    if (!host) return;
    const port = await vscode.window.showInputBox({ prompt: 'Jump Host port', value: '22' });
    if (!port) return;
    const username = await vscode.window.showInputBox({ prompt: 'Jump Host username' });
    if (!username) return;
    const authType = await vscode.window.showQuickPick([{ label: 'Password', value: 'password' }, { label: 'Private Key', value: 'privateKey' }], { placeHolder: 'Jump Host Auth' });
    if (!authType) return;
    let privateKeyPath: string | undefined;
    if (authType.value === 'privateKey') {
      const fileUri = await vscode.window.showOpenDialog({ canSelectFiles: true, openLabel: 'Select Jump Host Private Key' });
      if (!fileUri || fileUri.length === 0) return;
      privateKeyPath = fileUri[0].fsPath;
    }
    return { host, port: parseInt(port), username, authType: authType.value, privateKeyPath };
  }
}
