import * as vscode from 'vscode';
import { Client, ConnectConfig, ClientChannel } from 'ssh2';
import * as fs from 'fs';
import { SSHConfig, SSHConnection, ConnectionStatus, SSHProxyConfig } from '../types';

/**
 * SSH 连接管理器
 * 负责管理所有 SSH 连接的生命周期
 */
export class SSHManager {
  private connections: Map<string, Client> = new Map();
  private connectionConfigs: Map<string, SSHConfig> = new Map();
  private connectionStates: Map<string, ConnectionStatus> = new Map();
  private context: vscode.ExtensionContext;
  private secretStorage: vscode.SecretStorage;
  private reconnecting: Set<string> = new Set();

  private _onDidChangeConnectionStatus = new vscode.EventEmitter<{ connectionId: string, status: ConnectionStatus }>();
  public readonly onDidChangeConnectionStatus = this._onDidChangeConnectionStatus.event;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.secretStorage = context.secrets;
  }

  /**
   * 连接到 SSH 服务器
   */
  async connect(config: SSHConfig): Promise<Client> {
    this.connectionConfigs.set(config.id, config);
    return new Promise(async (resolve, reject) => {
      // 如果已经存在连接，先断开
      if (this.connections.has(config.id)) {
        await this.disconnect(config.id, true);
      }

      this.connectionStates.set(config.id, ConnectionStatus.Connecting);
      this._onDidChangeConnectionStatus.fire({ connectionId: config.id, status: ConnectionStatus.Connecting });

      try {
        let client: Client;

        if (config.proxyConfig) {
          // 通过跳板机连接
          client = await this.connectViaProxy(config);
        } else {
          // 直接连接
          client = await this.connectDirectly(config);
        }

        this.connections.set(config.id, client);
        this.connectionStates.set(config.id, ConnectionStatus.Connected);
        this.reconnecting.delete(config.id);
        this._onDidChangeConnectionStatus.fire({ connectionId: config.id, status: ConnectionStatus.Connected });
        vscode.window.showInformationMessage(`Connected to ${config.name}`);
        resolve(client);

      } catch (error: any) {
        this.connectionStates.set(config.id, ConnectionStatus.Failed);
        this._onDidChangeConnectionStatus.fire({ connectionId: config.id, status: ConnectionStatus.Failed });
        vscode.window.showErrorMessage(`SSH connection failed: ${error.message}`);
        reject(error);
      }
    });
  }

  /**
   * 直接连接到服务器
   */
  private async connectDirectly(config: SSHConfig | SSHProxyConfig, isProxy: boolean = false): Promise<Client> {
    return new Promise(async (resolve, reject) => {
      const client = new Client();
      let connectConfig: ConnectConfig;
      try {
        connectConfig = await this.prepareConnectConfig(config, isProxy);
      } catch (err) {
        return reject(err);
      }

      client.on('ready', () => resolve(client));
      client.on('error', (err) => reject(err));
      client.on('close', () => {
        if (!isProxy) {
          const connectionId = (config as SSHConfig).id;
          const wasConnected = this.connections.get(connectionId) === client;
          if (wasConnected) {
            this.connections.delete(connectionId);
            this.connectionStates.set(connectionId, ConnectionStatus.Disconnected);
            this._onDidChangeConnectionStatus.fire({ connectionId, status: ConnectionStatus.Disconnected });
            
            // 尝试自动重连
            this.attemptReconnect(connectionId);
          }
        }
      });

      client.connect(connectConfig);
    });
  }

  /**
   * 尝试重连
   */
  private async attemptReconnect(connectionId: string) {
    if (this.reconnecting.has(connectionId)) return;
    
    const config = this.connectionConfigs.get(connectionId);
    if (!config) return;

    this.reconnecting.add(connectionId);
    console.log(`Attempting to reconnect to ${config.name}...`);

    // 指数退避重连策略
    let retryCount = 0;
    const maxRetries = 5;
    
    const retry = async () => {
      if (retryCount >= maxRetries) {
        this.reconnecting.delete(connectionId);
        vscode.window.showErrorMessage(`Failed to reconnect to ${config.name} after ${maxRetries} attempts.`);
        return;
      }

      retryCount++;
      const delay = Math.pow(2, retryCount) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));

      try {
        await this.connect(config);
        this.reconnecting.delete(connectionId);
        vscode.window.showInformationMessage(`Successfully reconnected to ${config.name}`);
      } catch (error) {
        console.error(`Reconnect attempt ${retryCount} failed:`, error);
        retry();
      }
    };

    retry();
  }

  /**
   * 通过跳板机连接
   */
  private async connectViaProxy(config: SSHConfig): Promise<Client> {
    if (!config.proxyConfig) throw new Error('No proxy configuration');

    // 1. 连接到跳板机
    const proxyClient = await this.connectDirectly(config.proxyConfig, true);

    // 2. 建立隧道
    return new Promise((resolve, reject) => {
      proxyClient.forwardOut(
        '127.0.0.1', 0, // Source
        config.host, config.port, // Destination
        async (err, stream) => {
          if (err) {
            proxyClient.end();
            return reject(new Error(`Jump host forwarding failed: ${err.message}`));
          }

          // 3. 通过隧道连接到目标
          const targetClient = new Client();
          let targetConfig: ConnectConfig;
          try {
            targetConfig = await this.prepareConnectConfig(config);
          } catch (err) {
            proxyClient.end();
            return reject(err);
          }
          
          targetClient.on('ready', () => {
            // 当目标连接就绪时，保持代理连接直到目标连接关闭
            targetClient.on('close', () => {
              proxyClient.end();
              const connectionId = config.id;
              const wasConnected = this.connections.get(connectionId) === targetClient;
              if (wasConnected) {
                this.connections.delete(connectionId);
                this.connectionStates.set(connectionId, ConnectionStatus.Disconnected);
                this._onDidChangeConnectionStatus.fire({ connectionId, status: ConnectionStatus.Disconnected });
                this.attemptReconnect(connectionId);
              }
            });
            resolve(targetClient);
          });

          targetClient.on('error', (err) => {
            proxyClient.end();
            reject(err);
          });

          // 使用 stream 作为底层传输
          targetClient.connect({
            ...targetConfig,
            sock: stream
          });
        }
      );
    });
  }

  /**
   * 准备连接配置
   */
  private async prepareConnectConfig(config: SSHConfig | SSHProxyConfig, isProxy: boolean = false): Promise<ConnectConfig> {
    const connectConfig: ConnectConfig = {
      host: config.host,
      port: config.port,
      username: config.username,
      readyTimeout: 30000,
      keepaliveInterval: 10000, // 添加心跳检测
      keepaliveCountMax: 3
    };

    const id = isProxy ? `proxy_${config.host}` : (config as SSHConfig).id;

    if (config.authType === 'password') {
      let password = await this.getPassword(id);
      if (!password) {
        password = await vscode.window.showInputBox({
          prompt: `Enter password for ${config.username}@${config.host}${isProxy ? ' (Jump Host)' : ''}`,
          password: true,
          ignoreFocusOut: true
        });

        if (!password) throw new Error('Password required');
        await this.savePassword(id, password);
      }
      connectConfig.password = password;
    } else if (config.authType === 'privateKey' && config.privateKeyPath) {
      try {
        connectConfig.privateKey = fs.readFileSync(config.privateKeyPath);
        
        // 尝试获取私钥密码
        const passphrase = await this.getPassword(`${id}_passphrase`);
        if (passphrase) {
          connectConfig.passphrase = passphrase;
        }
      } catch (error) {
        throw new Error(`Failed to read private key: ${error}`);
      }
    }

    return connectConfig;
  }

  /**
   * 断开 SSH 连接
   */
  async disconnect(connectionId: string, intentional: boolean = false): Promise<void> {
    if (intentional) {
      this.reconnecting.delete(connectionId);
    }
    const client = this.connections.get(connectionId);
    if (client) {
      if (intentional) {
        this.connections.delete(connectionId); // 先删除，防止 close 事件触发重连
      }
      client.end();
      this.connectionStates.set(connectionId, ConnectionStatus.Disconnected);
      this._onDidChangeConnectionStatus.fire({ connectionId, status: ConnectionStatus.Disconnected });
    }
  }

  /**
   * 获取连接客户端
   */
  getClient(connectionId: string): Client | undefined {
    return this.connections.get(connectionId);
  }

  /**
   * 获取连接状态
   */
  getConnectionStatus(connectionId: string): ConnectionStatus {
    return this.connectionStates.get(connectionId) || ConnectionStatus.Disconnected;
  }

  /**
   * 检查连接是否活跃
   */
  isConnected(connectionId: string): boolean {
    return this.connectionStates.get(connectionId) === ConnectionStatus.Connected;
  }

  /**
   * 断开所有连接
   */
  async disconnectAll(): Promise<void> {
    const promises = Array.from(this.connections.keys()).map(id => this.disconnect(id, true));
    await Promise.all(promises);
  }

  /**
   * 保存密码到安全存储
   */
  private async savePassword(key: string, password: string): Promise<void> {
    await this.secretStorage.store(`ssh_password_${key}`, password);
  }

  /**
   * 从安全存储获取密码
   */
  private async getPassword(key: string): Promise<string | undefined> {
    return await this.secretStorage.get(`ssh_password_${key}`);
  }

  /**
   * 删除保存的密码
   */
  private async deletePassword(key: string): Promise<void> {
    await this.secretStorage.delete(`ssh_password_${key}`);
  }

  /**
   * 执行 SSH 命令
   */
  async execCommand(connectionId: string, command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const client = this.getClient(connectionId);
      if (!client) {
        reject(new Error('Not connected'));
        return;
      }

      client.exec(command, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          reject(err);
          return;
        }

        let output = '';
        let errorOutput = '';

        stream.on('data', (data: Buffer) => {
          output += data.toString();
        });

        stream.stderr.on('data', (data: Buffer) => {
          errorOutput += data.toString();
        });

        stream.on('close', (code: number) => {
          if (code !== 0) {
            reject(new Error(errorOutput || `Command failed with code ${code}`));
          } else {
            resolve(output);
          }
        });
      });
    });
  }

  /**
   * 清理资源
   */
  dispose(): void {
    this.disconnectAll();
  }
}
