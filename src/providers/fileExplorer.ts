import * as vscode from 'vscode';
import { SSHManager } from '../services/sshManager';
import { SSHConfig, RemoteFile } from '../types';
import * as path from 'path';
import { SFTPWrapper } from 'ssh2';

/**
 * 远程文件浏览器
 * 负责浏览和管理远程文件系统
 */
export class FileExplorer {
  private sshManager: SSHManager;
  private sftpClients: Map<string, SFTPWrapper> = new Map();

  constructor(sshManager: SSHManager) {
    this.sshManager = sshManager;
  }

  /**
   * 浏览远程文件
   */
  async browseFiles(config: SSHConfig): Promise<void> {
    try {
      // 确保 SSH 已连接
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

      // 创建 SFTP 客户端
      const sftp = await this.getSFTPWrapper(config);

      // 从用户主目录开始
      const homeDir = await this.getHomeDirectory(config);
      await this.showDirectoryPicker(config, sftp, homeDir);

    } catch (error) {
      vscode.window.showErrorMessage(`Failed to browse files: ${error}`);
    }
  }

  /**
   * 获取 SFTP 客户端
   */
  private async getSFTPWrapper(config: SSHConfig): Promise<SFTPWrapper> {
    let sftp = this.sftpClients.get(config.id);

    if (!sftp) {
      const client = this.sshManager.getClient(config.id);
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

      this.sftpClients.set(config.id, sftp);
    }

    return sftp;
  }

  /**
   * 获取用户主目录
   */
  private async getHomeDirectory(config: SSHConfig): Promise<string> {
    try {
      const result = await this.sshManager.execCommand(config.id, 'pwd');
      return result.trim();
    } catch {
      return '/';
    }
  }

  /**
   * 显示目录选择器
   */
  private async showDirectoryPicker(
    config: SSHConfig,
    sftp: SFTPWrapper,
    currentPath: string
  ): Promise<void> {
    try {
      const items = await this.listDirectory(sftp, currentPath);

      const quickPickItems: vscode.QuickPickItem[] = [
        {
          label: '$(folder) ..',
          description: 'Go to parent directory',
          detail: path.dirname(currentPath)
        },
        {
          label: '$(folder-opened) Current Directory',
          description: currentPath,
          detail: 'Operations on current directory'
        },
        ...items.map(item => ({
          label: item.isDirectory ? `$(folder) ${item.name}` : `$(file) ${item.name}`,
          description: item.isDirectory ? '' : this.formatFileSize(item.size),
          detail: item.permissions
        }))
      ];

      const selected = await vscode.window.showQuickPick(quickPickItems, {
        placeHolder: `Browse: ${currentPath}`,
        ignoreFocusOut: true
      });

      if (!selected) {
        return;
      }

      // 处理选择
      if (selected.label.includes('..')) {
        const parentPath = path.dirname(currentPath);
        await this.showDirectoryPicker(config, sftp, parentPath);
      } else if (selected.label.includes('Current Directory')) {
        await this.showDirectoryActions(config, sftp, currentPath);
      } else {
        const fileName = selected.label.replace(/^\$\([^)]+\)\s+/, '');
        const item = items.find(i => i.name === fileName);

        if (item) {
          if (item.isDirectory) {
            await this.showDirectoryPicker(config, sftp, item.path);
          } else {
            await this.showFileActions(config, sftp, item);
          }
        }
      }

    } catch (error) {
      vscode.window.showErrorMessage(`Failed to list directory: ${error}`);
    }
  }

  /**
   * 列出目录内容
   */
  private async listDirectory(sftp: SFTPWrapper, remotePath: string): Promise<RemoteFile[]> {
    try {
      return new Promise((resolve, reject) => {
        sftp.readdir(remotePath, (err: Error | undefined, list: any[]) => {
          if (err) {
            reject(err);
            return;
          }

          const files: RemoteFile[] = list
            .filter(item => !item.filename.startsWith('.'))
            .map(item => ({
              name: item.filename,
              path: path.posix.join(remotePath, item.filename),
              isDirectory: (item.attrs.mode & 0o40000) !== 0,
              size: item.attrs.size,
              modifiedTime: new Date(item.attrs.mtime * 1000),
              permissions: this.formatPermissions(item.attrs.mode),
              owner: item.attrs.uid?.toString() || '',
              group: item.attrs.gid?.toString() || ''
            }));

          resolve(files);
        });
      });
    } catch (error) {
      throw new Error(`Failed to list directory: ${error}`);
    }
  }

  /**
   * 显示目录操作
   */
  private async showDirectoryActions(
    config: SSHConfig,
    sftp: SFTPWrapper,
    dirPath: string
  ): Promise<void> {
    const action = await vscode.window.showQuickPick(
      [
        { label: '$(folder-opened) Browse', value: 'browse' },
        { label: '$(file-add) Create File', value: 'createFile' },
        { label: '$(new-folder) Create Directory', value: 'createDir' },
        { label: '$(arrow-up) Upload File', value: 'upload' },
        { label: '$(arrow-left) Back', value: 'back' }
      ],
      {
        placeHolder: `Actions for: ${dirPath}`,
        ignoreFocusOut: true
      }
    );

    if (!action) {
      return;
    }

    switch (action.value) {
      case 'browse':
        await this.showDirectoryPicker(config, sftp, dirPath);
        break;
      case 'createFile':
        await this.createFile(config, sftp, dirPath);
        break;
      case 'createDir':
        await this.createDirectory(config, sftp, dirPath);
        break;
      case 'upload':
        await this.uploadFile(config, sftp, dirPath);
        break;
      case 'back':
        await this.showDirectoryPicker(config, sftp, dirPath);
        break;
    }
  }

  /**
   * 显示文件操作
   */
  private async showFileActions(
    config: SSHConfig,
    sftp: SFTPWrapper,
    file: RemoteFile
  ): Promise<void> {
    const action = await vscode.window.showQuickPick(
      [
        { label: '$(arrow-down) Download', value: 'download' },
        { label: '$(edit) Edit', value: 'edit' },
        { label: '$(trash) Delete', value: 'delete' },
        { label: '$(arrow-left) Back', value: 'back' }
      ],
      {
        placeHolder: `Actions for: ${file.name}`,
        ignoreFocusOut: true
      }
    );

    if (!action) {
      return;
    }

    const dirPath = path.dirname(file.path);

    switch (action.value) {
      case 'download':
        await this.downloadFile(config, sftp, file);
        await this.showDirectoryPicker(config, sftp, dirPath);
        break;
      case 'edit':
        await this.editFile(config, sftp, file);
        await this.showDirectoryPicker(config, sftp, dirPath);
        break;
      case 'delete':
        await this.deleteFile(config, sftp, file);
        await this.showDirectoryPicker(config, sftp, dirPath);
        break;
      case 'back':
        await this.showDirectoryPicker(config, sftp, dirPath);
        break;
    }
  }

  /**
   * 下载文件
   */
  private async downloadFile(config: SSHConfig, sftp: SFTPWrapper, file: RemoteFile): Promise<void> {
    const saveUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(file.name),
      saveLabel: 'Download'
    });

    if (saveUri) {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Downloading ${file.name}...`,
          cancellable: false
        },
        async () => {
          await new Promise<void>((resolve, reject) => {
            const readStream = sftp.createReadStream(file.path);
            const writeStream = require('fs').createWriteStream(saveUri.fsPath);

            readStream.pipe(writeStream);
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
            readStream.on('error', reject);
          });
        }
      );

      vscode.window.showInformationMessage(`Downloaded ${file.name}`);
    }
  }

  /**
   * 上传文件
   */
  private async uploadFile(config: SSHConfig, sftp: SFTPWrapper, dirPath: string): Promise<void> {
    const fileUri = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Upload'
    });

    if (fileUri && fileUri.length > 0) {
      const localPath = fileUri[0].fsPath;
      const fileName = path.basename(localPath);
      const remotePath = path.posix.join(dirPath, fileName);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Uploading ${fileName}...`,
          cancellable: false
        },
        async () => {
          await new Promise<void>((resolve, reject) => {
            const readStream = require('fs').createReadStream(localPath);
            const writeStream = sftp.createWriteStream(remotePath);

            readStream.pipe(writeStream);
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
            readStream.on('error', reject);
          });
        }
      );

      vscode.window.showInformationMessage(`Uploaded ${fileName}`);
    }
  }

  /**
   * 编辑文件
   */
  private async editFile(config: SSHConfig, sftp: SFTPWrapper, file: RemoteFile): Promise<void> {
    vscode.window.showInformationMessage('File editing feature coming soon!');
  }

  /**
   * 创建文件
   */
  private async createFile(config: SSHConfig, sftp: SFTPWrapper, dirPath: string): Promise<void> {
    const fileName = await vscode.window.showInputBox({
      prompt: 'Enter file name',
      placeHolder: 'newfile.txt'
    });

    if (fileName) {
      const remotePath = path.posix.join(dirPath, fileName);

      await new Promise<void>((resolve, reject) => {
        const writeStream = sftp.createWriteStream(remotePath);
        writeStream.end('');
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });

      vscode.window.showInformationMessage(`Created ${fileName}`);
    }
  }

  /**
   * 创建目录
   */
  private async createDirectory(config: SSHConfig, sftp: SFTPWrapper, dirPath: string): Promise<void> {
    const dirName = await vscode.window.showInputBox({
      prompt: 'Enter directory name',
      placeHolder: 'newdir'
    });

    if (dirName) {
      const remotePath = path.posix.join(dirPath, dirName);

      await new Promise<void>((resolve, reject) => {
        sftp.mkdir(remotePath, (err: Error | null | undefined) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      vscode.window.showInformationMessage(`Created directory ${dirName}`);
    }
  }

  /**
   * 删除文件
   */
  private async deleteFile(config: SSHConfig, sftp: SFTPWrapper, file: RemoteFile): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
      `Are you sure you want to delete "${file.name}"?`,
      { modal: true },
      'Delete'
    );

    if (confirmed === 'Delete') {
      await new Promise<void>((resolve, reject) => {
        sftp.unlink(file.path, (err: Error | null | undefined) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      vscode.window.showInformationMessage(`Deleted ${file.name}`);
    }
  }

  /**
   * 格式化文件大小
   */
  private formatFileSize(bytes: number): string {
    if (bytes === 0) {
      return '0 B';
    }

    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * 格式化权限
   */
  private formatPermissions(mode: number): string {
    const perms: string[] = [];

    // 文件类型
    if ((mode & 0o40000) !== 0) {
      perms.push('d');
    } else {
      perms.push('-');
    }

    // 所有者权限
    perms.push((mode & 0o400) ? 'r' : '-');
    perms.push((mode & 0o200) ? 'w' : '-');
    perms.push((mode & 0o100) ? 'x' : '-');

    // 组权限
    perms.push((mode & 0o040) ? 'r' : '-');
    perms.push((mode & 0o020) ? 'w' : '-');
    perms.push((mode & 0o010) ? 'x' : '-');

    // 其他用户权限
    perms.push((mode & 0o004) ? 'r' : '-');
    perms.push((mode & 0o002) ? 'w' : '-');
    perms.push((mode & 0o001) ? 'x' : '-');

    return perms.join('');
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
