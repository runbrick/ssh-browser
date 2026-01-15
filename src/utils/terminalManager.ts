import * as vscode from 'vscode';
import { SSHManager } from '../services/sshManager';
import { SSHConfig, TerminalSession } from '../types';

/**
 * SSH 终端管理器
 * 负责创建和管理 SSH 终端会话
 */
export class TerminalManager {
  private terminals: Map<string, TerminalSession> = new Map();
  private sshManager: SSHManager;

  constructor(sshManager: SSHManager, private context: vscode.ExtensionContext) {
    this.sshManager = sshManager;

    // 监听终端关闭事件
    vscode.window.onDidCloseTerminal((terminal) => {
      this.handleTerminalClose(terminal);
      this.saveState();
    });
  }

  /**
   * 保存终端状态以便恢复
   */
  private async saveState() {
    const state = Array.from(this.terminals.values()).map(s => ({
      connectionId: s.connectionId,
      name: s.terminal.name
    }));
    await this.context.workspaceState.update('activeTerminals', state);
  }

  /**
   * 恢复之前的终端会话
   */
  async restoreSessions(connections: SSHConfig[]) {
    const savedState = this.context.workspaceState.get<any[]>('activeTerminals', []);
    if (savedState.length === 0) return;

    for (const sessionState of savedState) {
      const config = connections.find(c => c.id === sessionState.connectionId);
      if (config) {
        // 尝试后台恢复（不强制显示，除非之前是显示的）
        this.openTerminal(config).catch(err => console.error(`Failed to restore terminal: ${err}`));
      }
    }
  }

  /**
   * 打开 SSH 终端
   */
  async openTerminal(config: SSHConfig): Promise<void> {
    try {
      // 确保已连接
      if (!this.sshManager.isConnected(config.id)) {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Connecting to ${config.name}...`,
            cancellable: false
          },
          async () => {
            await this.sshManager.connect(config);
          }
        );
      }

      const client = this.sshManager.getClient(config.id);
      if (!client) {
        throw new Error('Failed to get SSH client');
      }

      // 创建终端
      const terminal = vscode.window.createTerminal({
        name: `SSH: ${config.name}`,
        pty: new SSHPseudoTerminal(client, config)
      });

      const session: TerminalSession = {
        id: Date.now().toString(),
        connectionId: config.id,
        terminal,
        createdAt: new Date()
      };

      this.terminals.set(session.id, session);
      terminal.show();
      this.saveState();

    } catch (error) {
      vscode.window.showErrorMessage(`Failed to open terminal: ${error}`);
    }
  }

  /**
   * 处理终端关闭
   */
  private handleTerminalClose(terminal: vscode.Terminal): void {
    for (const [id, session] of this.terminals.entries()) {
      if (session.terminal === terminal) {
        this.terminals.delete(id);
        break;
      }
    }
  }

  /**
   * 关闭所有终端
   */
  closeAll(): void {
    for (const session of this.terminals.values()) {
      session.terminal.dispose();
    }
    this.terminals.clear();
  }

  /**
   * 清理资源
   */
  dispose(): void {
    this.closeAll();
  }
}

/**
 * SSH 伪终端实现
 */
class SSHPseudoTerminal implements vscode.Pseudoterminal {
  private writeEmitter = new vscode.EventEmitter<string>();
  onDidWrite: vscode.Event<string> = this.writeEmitter.event;

  private closeEmitter = new vscode.EventEmitter<number>();
  onDidClose?: vscode.Event<number> = this.closeEmitter.event;

  private stream: any;
  private client: any;
  private config: SSHConfig;
  private dimensions: vscode.TerminalDimensions | undefined;

  constructor(client: any, config: SSHConfig) {
    this.client = client;
    this.config = config;
  }

  /**
   * 打开终端
   */
  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    this.dimensions = initialDimensions;

    this.client.shell(
      {
        cols: initialDimensions?.columns || 80,
        rows: initialDimensions?.rows || 24,
        term: 'xterm-256color'
      },
      (err: Error, stream: any) => {
        if (err) {
          this.writeEmitter.fire(`\r\nFailed to start shell: ${err.message}\r\n`);
          this.closeEmitter.fire(1);
          return;
        }

        this.stream = stream;

        // 将服务器输出写入终端
        stream.on('data', (data: Buffer) => {
          this.writeEmitter.fire(data.toString());
        });

        stream.stderr.on('data', (data: Buffer) => {
          this.writeEmitter.fire(data.toString());
        });

        stream.on('close', () => {
          this.closeEmitter.fire(0);
        });

        // 发送欢迎消息
        this.writeEmitter.fire(`\r\nConnected to ${this.config.name} (${this.config.host})\r\n\r\n`);
      }
    );
  }

  /**
   * 关闭终端
   */
  close(): void {
    if (this.stream) {
      this.stream.close();
    }
  }

  /**
   * 处理输入
   */
  handleInput(data: string): void {
    if (this.stream) {
      this.stream.write(data);
    }
  }

  /**
   * 设置终端尺寸
   */
  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.dimensions = dimensions;
    if (this.stream) {
      this.stream.setWindow(dimensions.rows, dimensions.columns, 0, 0);
    }
  }
}
