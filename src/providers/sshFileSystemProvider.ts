import * as vscode from 'vscode';
import { SSHManager } from '../services/sshManager';
import { SSHConfig } from '../types';
import { SFTPWrapper } from 'ssh2';
import * as path from 'path';

/**
 * SSH 文件系统提供者
 * 实现 VSCode FileSystemProvider 接口,使远程文件可以像本地文件一样访问
 */
export class SSHFileSystemProvider implements vscode.FileSystemProvider {
  private sftpClients: Map<string, SFTPWrapper> = new Map();
  private sshManager: SSHManager;

  // 文件变化事件
  private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

  constructor(sshManager: SSHManager) {
    this.sshManager = sshManager;
  }

  /**
   * 监听文件变化
   */
  watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
    // 实现文件监听 (可选)
    return new vscode.Disposable(() => { });
  }

  /**
   * 获取文件统计信息
   */
  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { connectionId, remotePath } = this.parseUri(uri);
    const sftp = await this.getSFTP(connectionId);

    return new Promise((resolve, reject) => {
      sftp.stat(remotePath, (err: Error | null | undefined, stats: any) => {
        if (err) {
          reject(vscode.FileSystemError.FileNotFound(uri));
          return;
        }

        const isDirectory = (stats.mode & 0o40000) !== 0;
        const fileStat: vscode.FileStat = {
          type: isDirectory ? vscode.FileType.Directory : vscode.FileType.File,
          ctime: stats.mtime * 1000,
          mtime: stats.mtime * 1000,
          size: stats.size
        };

        resolve(fileStat);
      });
    });
  }

  /**
   * 读取目录
   */
  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const { connectionId, remotePath } = this.parseUri(uri);
    const sftp = await this.getSFTP(connectionId);

    return new Promise((resolve, reject) => {
      sftp.readdir(remotePath, (err: Error | undefined, list: any[]) => {
        if (err) {
          reject(vscode.FileSystemError.FileNotFound(uri));
          return;
        }

        const entries: [string, vscode.FileType][] = list.map(item => {
          const isDirectory = (item.attrs.mode & 0o40000) !== 0;
          const type = isDirectory ? vscode.FileType.Directory : vscode.FileType.File;
          return [item.filename, type];
        });

        resolve(entries);
      });
    });
  }

  /**
   * 创建目录
   */
  async createDirectory(uri: vscode.Uri): Promise<void> {
    const { connectionId, remotePath } = this.parseUri(uri);
    const sftp = await this.getSFTP(connectionId);

    return new Promise((resolve, reject) => {
      sftp.mkdir(remotePath, (err: Error | null | undefined) => {
        if (err) {
          reject(vscode.FileSystemError.FileExists(uri));
          return;
        }
        resolve();
        this._emitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
      });
    });
  }

  /**
   * 读取文件
   */
  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { connectionId, remotePath } = this.parseUri(uri);
    const sftp = await this.getSFTP(connectionId);

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const readStream = sftp.createReadStream(remotePath);

      readStream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      readStream.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve(new Uint8Array(buffer));
      });

      readStream.on('error', (err: Error) => {
        reject(vscode.FileSystemError.FileNotFound(uri));
      });
    });
  }

  /**
   * 写入文件
   */
  async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }): Promise<void> {
    const { connectionId, remotePath } = this.parseUri(uri);
    const sftp = await this.getSFTP(connectionId);

    // 检查文件是否存在
    try {
      await this.stat(uri);
      if (!options.overwrite) {
        throw vscode.FileSystemError.FileExists(uri);
      }
    } catch {
      if (!options.create) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
    }

    return new Promise((resolve, reject) => {
      const buffer = Buffer.from(content);
      sftp.writeFile(remotePath, buffer, (err: Error | null | undefined) => {
        if (err) {
          reject(vscode.FileSystemError.Unavailable(uri));
          return;
        }
        this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
        resolve();
      });
    });
  }

  /**
   * 删除文件或目录
   */
  async delete(uri: vscode.Uri, options: { recursive: boolean; }): Promise<void> {
    const { connectionId, remotePath } = this.parseUri(uri);
    const sftp = await this.getSFTP(connectionId);

    const stat = await this.stat(uri);

    if (stat.type === vscode.FileType.Directory) {
      if (options.recursive) {
        // 递归删除目录
        await this.deleteDirectory(sftp, remotePath);
      } else {
        // 删除空目录
        await new Promise<void>((resolve, reject) => {
          sftp.rmdir(remotePath, (err: Error | null | undefined) => {
            if (err) {
              reject(vscode.FileSystemError.NoPermissions(uri));
            } else {
              resolve();
            }
          });
        });
      }
    } else {
      // 删除文件
      await new Promise<void>((resolve, reject) => {
        sftp.unlink(remotePath, (err: Error | null | undefined) => {
          if (err) {
            reject(vscode.FileSystemError.NoPermissions(uri));
          } else {
            resolve();
          }
        });
      });
    }

    this._emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  /**
   * 重命名文件或目录
   */
  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean; }): Promise<void> {
    const { connectionId, remotePath: oldPath } = this.parseUri(oldUri);
    const { remotePath: newPath } = this.parseUri(newUri);
    const sftp = await this.getSFTP(connectionId);

    // 检查新路径是否存在
    try {
      await this.stat(newUri);
      if (!options.overwrite) {
        throw vscode.FileSystemError.FileExists(newUri);
      }
    } catch {
      // 文件不存在，可以继续
    }

    return new Promise((resolve, reject) => {
      sftp.rename(oldPath, newPath, (err: Error | null | undefined) => {
        if (err) {
          reject(vscode.FileSystemError.NoPermissions(oldUri));
          return;
        }
        resolve();
        this._emitter.fire([
          { type: vscode.FileChangeType.Deleted, uri: oldUri },
          { type: vscode.FileChangeType.Created, uri: newUri }
        ]);
      });
    });
  }

  /**
   * 递归删除目录
   */
  private async deleteDirectory(sftp: SFTPWrapper, remotePath: string): Promise<void> {
    // 读取目录内容
    const entries = await new Promise<any[]>((resolve, reject) => {
      sftp.readdir(remotePath, (err: Error | undefined, list: any[]) => {
        if (err) {
          reject(err);
        } else {
          resolve(list);
        }
      });
    });

    // 递归删除所有内容
    for (const entry of entries) {
      const entryPath = path.posix.join(remotePath, entry.filename);
      const isDirectory = (entry.attrs.mode & 0o40000) !== 0;

      if (isDirectory) {
        await this.deleteDirectory(sftp, entryPath);
      } else {
        await new Promise<void>((resolve, reject) => {
          sftp.unlink(entryPath, (err: Error | null | undefined) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }
    }

    // 删除空目录
    await new Promise<void>((resolve, reject) => {
      sftp.rmdir(remotePath, (err: Error | null | undefined) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * 获取 SFTP 客户端
   */
  private async getSFTP(connectionId: string): Promise<SFTPWrapper> {
    let sftp = this.sftpClients.get(connectionId);

    if (!sftp) {
      const client = this.sshManager.getClient(connectionId);
      if (!client) {
        throw new Error('SSH client not available');
      }

      sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
        client.sftp((err: Error | undefined, sftpStream: SFTPWrapper) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(sftpStream);
        });
      });

      this.sftpClients.set(connectionId, sftp);
    }

    return sftp;
  }

  /**
   * 解析 URI
   * 格式: ssh://connectionId/path/to/file
   */
  private parseUri(uri: vscode.Uri): { connectionId: string; remotePath: string } {
    const connectionId = uri.authority;
    const remotePath = uri.path || '/';
    return { connectionId, remotePath };
  }

  /**
   * 创建 URI
   */
  public static createUri(connectionId: string, remotePath: string): vscode.Uri {
    return vscode.Uri.parse(`ssh://${connectionId}${remotePath}`);
  }

  /**
   * 清理资源
   */
  dispose(): void {
    for (const sftp of this.sftpClients.values()) {
      sftp.end();
    }
    this.sftpClients.clear();
  }
}
