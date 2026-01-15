import * as vscode from 'vscode';
import { SSHManager } from '../services/sshManager';
import { SSHConfig } from '../types';
import { SFTPWrapper } from 'ssh2';
import * as path from 'path';
import { SSHFileSystemProvider } from '../providers/sshFileSystemProvider';
import { SSHSessionPanel } from './sshSessionPanel';

/**
 * 文件管理面板
 * 使用 Webview 实现可视化的文件管理器
 */
export class FileManagerPanel {
  private static panels: Map<string, FileManagerPanel> = new Map();

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private sftp: SFTPWrapper | null = null;
  private currentPath: string = '/';
  private homeDirectory: string = '/';

  private constructor(
    panel: vscode.WebviewPanel,
    private config: SSHConfig,
    private sshManager: SSHManager,
    private context: vscode.ExtensionContext
  ) {
    this.panel = panel;

    // 设置 webview 内容
    this.updateContent();

    // 监听 webview 消息
    this.panel.webview.onDidReceiveMessage(
      message => this.handleMessage(message),
      null,
      this.disposables
    );

    // 清理资源
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // 监听 SSH 会话路径变化
    this.disposables.push(
      SSHSessionPanel.onCurrentPathChange(event => {
        if (event.connectionId === this.config.id) {
          // 将 ~ 展开为实际路径
          let actualPath = event.path;
          if (actualPath.startsWith('~')) {
            // 只替换开头的 ~
            if (actualPath === '~') {
              actualPath = this.homeDirectory;
            } else if (actualPath.startsWith('~/')) {
              actualPath = this.homeDirectory + actualPath.substring(1);
            }
          }
          this.loadDirectory(actualPath).catch((error) => {
            // 记录错误以便调试
            console.error(`Failed to load directory ${actualPath}:`, error);
            vscode.window.showWarningMessage(`Could not navigate to ${event.path}`);
          });
        }
      })
    );

    // 初始化 SFTP
    this.initializeSFTP();
  }

  /**
   * 创建或显示文件管理面板
   */
  public static async createOrShow(
    config: SSHConfig,
    sshManager: SSHManager,
    context: vscode.ExtensionContext,
    viewColumn: vscode.ViewColumn = vscode.ViewColumn.Beside
  ): Promise<void> {
    const sessionKey = config.id;

    // 如果已经有面板，直接显示
    const existingPanel = FileManagerPanel.panels.get(sessionKey);
    if (existingPanel) {
      existingPanel.panel.reveal(viewColumn);
      return;
    }

    // 确保已连接
    if (!sshManager.isConnected(config.id)) {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Connecting to ${config.name}...`,
          cancellable: false
        },
        async () => {
          await sshManager.connect(config);
        }
      );
    }

    // 创建新面板
    const panel = vscode.window.createWebviewPanel(
      'fileManager',
      `Files: ${config.name}`,
      viewColumn,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: []
      }
    );

    const fileManager = new FileManagerPanel(panel, config, sshManager, context);
    FileManagerPanel.panels.set(sessionKey, fileManager);
  }

  /**
   * 初始化 SFTP
   */
  private async initializeSFTP() {
    try {
      const client = this.sshManager.getClient(this.config.id);
      if (!client) {
        throw new Error('SSH client not available');
      }

      this.sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
        client.sftp((err: Error | undefined, sftpStream: SFTPWrapper) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(sftpStream);
        });
      });

      // 获取用户主目录
      const homeDir = await this.sshManager.execCommand(this.config.id, 'pwd');
      this.homeDirectory = homeDir.trim() || '/';
      this.currentPath = this.homeDirectory;

      // 加载文件列表
      await this.loadDirectory(this.currentPath);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to initialize SFTP: ${error}`);
    }
  }

  /**
   * 加载目录内容
   */
  private async loadDirectory(dirPath: string) {
    if (!this.sftp) {
      return;
    }

    try {
      const files = await new Promise<any[]>((resolve, reject) => {
        this.sftp!.readdir(dirPath, (err: Error | undefined, list: any[]) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(list);
        });
      });

      const fileList = files.map(item => ({
        name: item.filename,
        isDirectory: (item.attrs.mode & 0o40000) !== 0,
        size: item.attrs.size,
        mtime: new Date(item.attrs.mtime * 1000).toLocaleString(),
        permissions: this.formatPermissions(item.attrs.mode)
      }));

      this.currentPath = dirPath;
      this.sendToWebview({
        type: 'fileList',
        path: this.currentPath,
        files: fileList
      });
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to load directory: ${error}`);
    }
  }

  /**
   * 处理来自 webview 的消息
   */
  private async handleMessage(message: any) {
    switch (message.type) {
      case 'navigate':
        await this.loadDirectory(message.path);
        break;

      case 'download':
        await this.downloadFile(message.path, message.name);
        break;

      case 'upload':
        await this.uploadFile();
        break;

      case 'delete':
        await this.deleteFile(message.path, message.isDirectory);
        break;

      case 'createFolder':
        await this.createFolder(message.name);
        break;

      case 'createFile':
        await this.createFile(message.name);
        break;

      case 'refresh':
        await this.loadDirectory(this.currentPath);
        break;

      case 'changePermissions':
        await this.changePermissions(message.path, message.permissions);
        break;

      case 'promptCreateFolder':
        await this.promptCreateFolder();
        break;

      case 'promptCreateFile':
        await this.promptCreateFile();
        break;

      case 'promptChangePermissions':
        await this.promptChangePermissions(message.path, message.currentPermissions);
        break;

      case 'edit':
        await this.editFile(message.path);
        break;
    }
  }

  /**
   * 编辑远程文件
   */
  private async editFile(remotePath: string) {
    try {
      const uri = SSHFileSystemProvider.createUri(this.config.id, remotePath);
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to open file for editing: ${error}`);
    }
  }

  /**
   * 提示创建文件夹
   */
  private async promptCreateFolder() {
    const folderName = await vscode.window.showInputBox({
      prompt: 'Enter folder name',
      placeHolder: 'folder_name',
      validateInput: (value) => {
        if (!value || value.trim() === '') {
          return 'Folder name cannot be empty';
        }
        if (value.includes('/') || value.includes('\\')) {
          return 'Folder name cannot contain path separators';
        }
        return null;
      }
    });

    if (folderName) {
      await this.createFolder(folderName);
    }
  }

  /**
   * 提示创建文件
   */
  private async promptCreateFile() {
    const fileName = await vscode.window.showInputBox({
      prompt: 'Enter file name',
      placeHolder: 'file_name.txt',
      validateInput: (value) => {
        if (!value || value.trim() === '') {
          return 'File name cannot be empty';
        }
        if (value.includes('/') || value.includes('\\')) {
          return 'File name cannot contain path separators';
        }
        return null;
      }
    });

    if (fileName) {
      await this.createFile(fileName);
    }
  }

  /**
   * 提示修改权限
   */
  private async promptChangePermissions(filePath: string, currentPermissions: string) {
    const commonPermissions = [
      { label: '777', description: '所有权限 (rwxrwxrwx)' },
      { label: '755', description: '所有者全部权限，其他读取和执行 (rwxr-xr-x)' },
      { label: '644', description: '所有者读写，其他只读 (rw-r--r--)' },
      { label: '600', description: '仅所有者读写 (rw-------)' },
      { label: '自定义...', description: '手动输入权限数字' }
    ];

    const selected = await vscode.window.showQuickPick(commonPermissions, {
      placeHolder: `为 ${path.basename(filePath)} 选择权限 (当前: ${currentPermissions})`
    });

    if (!selected) {
      return;
    }

    let newPerms: string | undefined;

    if (selected.label === '自定义...') {
      newPerms = await vscode.window.showInputBox({
        prompt: '输入八进制权限数字 (例如: 755, 644)',
        value: currentPermissions,
        placeHolder: '755',
        validateInput: (value) => {
          if (!value || !/^[0-7]{3,4}$/.test(value)) {
            return '请输入有效的权限数字 (例如: 755, 644, 0755)';
          }
          return null;
        }
      });
    } else {
      newPerms = selected.label;
    }

    if (newPerms) {
      await this.changePermissions(filePath, newPerms);
    }
  }

  /**
   * 下载文件
   */
  private async downloadFile(filePath: string, fileName: string) {
    const saveUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(fileName),
      saveLabel: 'Download'
    });

    if (saveUri && this.sftp) {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Downloading ${fileName}...`,
          cancellable: false
        },
        async () => {
          const readStream = this.sftp!.createReadStream(filePath);
          const writeStream = require('fs').createWriteStream(saveUri.fsPath);

          await new Promise<void>((resolve, reject) => {
            readStream.pipe(writeStream);
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
            readStream.on('error', reject);
          });
        }
      );

      vscode.window.showInformationMessage(`Downloaded ${fileName}`);
    }
  }

  /**
   * Upload files or directories
   */
  private async uploadFile() {
    const fileUri = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,  // Enable folder selection
      canSelectMany: true,     // Enable multi-selection
      openLabel: 'Upload'
    });

    if (fileUri && fileUri.length > 0 && this.sftp) {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Uploading...',
          cancellable: false
        },
        async (progress) => {
          let uploadedCount = 0;
          const totalItems = fileUri.length;

          for (const uri of fileUri) {
            const localPath = uri.fsPath;
            const fileName = path.basename(localPath);

            try {
              const fs = require('fs');
              const stat = fs.statSync(localPath);

              if (stat.isDirectory()) {
                // Upload directory
                progress.report({ message: `Uploading directory ${fileName}...`, increment: 0 });
                await this.uploadDirectory(localPath, this.currentPath, progress);
              } else {
                // Upload single file
                progress.report({ message: `Uploading file ${fileName}...`, increment: 0 });
                await this.uploadSingleFile(localPath, this.currentPath);
              }

              uploadedCount++;
              progress.report({ increment: (uploadedCount / totalItems) * 100 });
            } catch (error) {
              vscode.window.showErrorMessage(`Failed to upload ${fileName}: ${error}`);
            }
          }

          vscode.window.showInformationMessage(`Successfully uploaded ${uploadedCount} item(s)`);
          await this.loadDirectory(this.currentPath);
        }
      );
    }
  }

  /**
   * Upload a single file
   */
  private async uploadSingleFile(localPath: string, remoteDir: string): Promise<void> {
    if (!this.sftp) {
      throw new Error('SFTP connection not established');
    }

    const fileName = path.basename(localPath);
    const remotePath = path.posix.join(remoteDir, fileName);

    const fs = require('fs');
    const readStream = fs.createReadStream(localPath);
    const writeStream = this.sftp.createWriteStream(remotePath);

    return new Promise<void>((resolve, reject) => {
      writeStream.on('close', () => resolve());
      writeStream.on('error', reject);
      readStream.on('error', reject);
      readStream.pipe(writeStream);
    });
  }

  /**
   * Recursively upload directory
   */
  private async uploadDirectory(
    localDir: string,
    remoteParentDir: string,
    progress: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<void> {
    if (!this.sftp) {
      throw new Error('SFTP connection not established');
    }

    const fs = require('fs');
    const dirName = path.basename(localDir);
    const remoteDirPath = path.posix.join(remoteParentDir, dirName);

    // Create directory on remote server
    await new Promise<void>((resolve, reject) => {
      this.sftp!.mkdir(remoteDirPath, (err: Error | null | undefined) => {
        // Ignore "already exists" error
        if (err && !err.message.includes('already exists')) {
          reject(err);
        } else {
          resolve();
        }
      });
    });

    // Read local directory contents
    const items = fs.readdirSync(localDir);

    for (const item of items) {
      const localItemPath = path.join(localDir, item);
      const stat = fs.statSync(localItemPath);

      if (stat.isDirectory()) {
        // Recursively upload subdirectory
        await this.uploadDirectory(localItemPath, remoteDirPath, progress);
      } else {
        // Upload file
        progress.report({ message: `Uploading ${item}...` });
        await this.uploadSingleFile(localItemPath, remoteDirPath);
      }
    }
  }

  /**
   * Delete file or directory
   */
  private async deleteFile(filePath: string, isDirectory: boolean) {
    const fileName = path.basename(filePath);
    const confirmed = await vscode.window.showWarningMessage(
      `Are you sure you want to delete "${fileName}"?${isDirectory ? ' (including all subdirectories and files)' : ''}`,
      { modal: true },
      'Delete'
    );

    if (confirmed === 'Delete' && this.sftp) {
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Deleting ${fileName}...`,
            cancellable: false
          },
          async (progress) => {
            if (isDirectory) {
              // Recursively delete directory
              await this.deleteDirectoryRecursive(filePath, progress);
            } else {
              // Delete single file
              await new Promise<void>((resolve, reject) => {
                this.sftp!.unlink(filePath, (err: Error | null | undefined) => {
                  if (err) reject(err);
                  else resolve();
                });
              });
            }
          }
        );

        vscode.window.showInformationMessage(`Deleted ${fileName}`);
        await this.loadDirectory(this.currentPath);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to delete ${fileName}: ${error}`);
      }
    }
  }

  /**
   * Recursively delete directory and all its contents
   */
  private async deleteDirectoryRecursive(
    dirPath: string,
    progress: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<void> {
    if (!this.sftp) {
      throw new Error('SFTP connection not established');
    }

    progress.report({ message: `Scanning ${path.basename(dirPath)}...` });

    // List directory contents
    const items = await new Promise<any[]>((resolve, reject) => {
      this.sftp!.readdir(dirPath, (err: Error | null | undefined, list: any) => {
        if (err) reject(err);
        else resolve(list || []);
      });
    });

    // Recursively delete all items
    for (const item of items) {
      const itemPath = path.posix.join(dirPath, item.filename);
      const isDir = item.attrs.isDirectory();

      if (isDir) {
        // Recursively delete subdirectory
        await this.deleteDirectoryRecursive(itemPath, progress);
      } else {
        // Delete file
        progress.report({ message: `Deleting ${item.filename}...` });
        await new Promise<void>((resolve, reject) => {
          this.sftp!.unlink(itemPath, (err: Error | null | undefined) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }
    }

    // Delete empty directory
    progress.report({ message: `Deleting directory ${path.basename(dirPath)}...` });
    await new Promise<void>((resolve, reject) => {
      this.sftp!.rmdir(dirPath, (err: Error | null | undefined) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * 创建文件夹
   */
  private async createFolder(folderName: string) {
    if (!this.sftp || !folderName || folderName.trim() === '') {
      return;
    }

    const remotePath = path.posix.join(this.currentPath, folderName.trim());

    try {
      await new Promise<void>((resolve, reject) => {
        this.sftp!.mkdir(remotePath, (err: Error | null | undefined) => {
          if (err) reject(err);
          else resolve();
        });
      });

      vscode.window.showInformationMessage(`Created folder ${folderName}`);
      await this.loadDirectory(this.currentPath);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to create folder: ${error}`);
    }
  }

  /**
   * 创建文件
   */
  private async createFile(fileName: string) {
    if (!this.sftp || !fileName || fileName.trim() === '') {
      return;
    }

    const remotePath = path.posix.join(this.currentPath, fileName.trim());

    try {
      // Create an empty file by writing an empty buffer
      await new Promise<void>((resolve, reject) => {
        const writeStream = this.sftp!.createWriteStream(remotePath);
        writeStream.on('close', () => resolve());
        writeStream.on('error', reject);
        writeStream.end();
      });

      vscode.window.showInformationMessage(`Created file ${fileName}`);
      await this.loadDirectory(this.currentPath);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to create file: ${error}`);
    }
  }

  /**
   * 修改文件或目录权限
   */
  private async changePermissions(filePath: string, permissions: string) {
    if (!this.sftp) {
      return;
    }

    try {
      // Convert octal string to number (e.g., "755" -> 0o755)
      const mode = parseInt(permissions, 8);

      await new Promise<void>((resolve, reject) => {
        this.sftp!.chmod(filePath, mode, (err: Error | null | undefined) => {
          if (err) reject(err);
          else resolve();
        });
      });

      vscode.window.showInformationMessage(`Changed permissions to ${permissions}`);
      await this.loadDirectory(this.currentPath);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to change permissions: ${error}`);
    }
  }

  /**
   * 格式化权限
   */
  private formatPermissions(mode: number): string {
    const perms: string[] = [];
    perms.push((mode & 0o40000) ? 'd' : '-');
    perms.push((mode & 0o400) ? 'r' : '-');
    perms.push((mode & 0o200) ? 'w' : '-');
    perms.push((mode & 0o100) ? 'x' : '-');
    perms.push((mode & 0o040) ? 'r' : '-');
    perms.push((mode & 0o020) ? 'w' : '-');
    perms.push((mode & 0o010) ? 'x' : '-');
    perms.push((mode & 0o004) ? 'r' : '-');
    perms.push((mode & 0o002) ? 'w' : '-');
    perms.push((mode & 0o001) ? 'x' : '-');
    return perms.join('');
  }

  /**
   * 发送消息到 webview
   */
  private sendToWebview(message: any) {
    this.panel.webview.postMessage(message);
  }

  /**
   * 更新 HTML 内容
   */
  private updateContent() {
    this.panel.webview.html = this.getHtmlContent();
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
    <title>File Manager</title>
    <style>
        :root {
            --toolbar-height: 38px;
            --row-height: 24px;
            --header-height: 24px;
            --font-size-small: 11px;
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
            overflow: hidden;
            padding: 0;
        }

        #toolbar {
            display: flex;
            align-items: center;
            height: var(--toolbar-height);
            padding: 0 16px;
            background-color: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            gap: 4px;
            user-select: none;
        }

        .toolbar-group {
            display: flex;
            align-items: center;
            gap: 2px;
        }

        .toolbar-separator {
            width: 1px;
            height: 18px;
            background-color: var(--vscode-panel-border);
            margin: 0 6px;
        }

        #path {
            flex: 1;
            height: 24px;
            padding: 0 8px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, transparent);
            border-radius: 2px;
            font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
            font-size: 11px;
            display: flex;
            align-items: center;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            margin: 0 8px;
            cursor: text;
        }
        
        #path:hover {
            border-color: var(--vscode-focusBorder);
        }

        .icon-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 26px;
            height: 26px;
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

        #file-list {
            position: absolute;
            top: var(--toolbar-height);
            left: 0;
            right: 0;
            bottom: 0;
            overflow: auto;
            background-color: var(--vscode-list-hoverBackground, transparent);
            background-image: linear-gradient(var(--vscode-editor-background), var(--vscode-editor-background));
        }

        table {
            width: 100%;
            border-collapse: collapse;
            table-layout: fixed;
            user-select: none;
        }

        thead {
            position: sticky;
            top: 0;
            z-index: 10;
            background-color: var(--vscode-editor-background);
        }

        th {
            text-align: left;
            padding: 0 12px;
            height: var(--header-height);
            border-bottom: 1px solid var(--vscode-panel-border);
            font-weight: 600;
            font-size: var(--font-size-small);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
        }

        th:hover {
            color: var(--vscode-foreground);
        }

        th:first-child { width: 45%; }
        th:nth-child(2) { width: 12%; }
        th:nth-child(3) { width: 23%; }
        th:nth-child(4) { width: 12%; }
        th:last-child { width: 80px; }

        td {
            padding: 0 12px;
            height: var(--row-height);
            vertical-align: middle;
            font-size: 13px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            border-bottom: 1px solid transparent;
        }

        tr {
            outline: none;
        }

        tbody tr:hover {
            background-color: var(--vscode-list-hoverBackground);
        }

        tbody tr.selected {
            background-color: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }
        
        tbody tr:focus {
            outline: 1px solid var(--vscode-list-focusOutline);
            outline-offset: -1px;
        }

        .actions {
            display: flex;
            gap: 2px;
            opacity: 0;
            transition: opacity 0.1s;
            justify-content: flex-end;
        }

        tr:hover .actions, tr:focus-within .actions {
            opacity: 1;
        }

        .action-btn {
            height: 20px;
            width: 20px;
            padding: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            background: transparent;
            color: var(--vscode-icon-foreground);
            border: none;
            cursor: pointer;
            border-radius: 4px;
        }

        .action-btn:hover {
            background-color: var(--vscode-toolbar-hoverBackground);
        }
        
        tbody tr.selected .action-btn {
            color: var(--vscode-list-activeSelectionForeground);
        }
        
        tbody tr.selected .action-btn:hover {
             background-color: rgba(255, 255, 255, 0.15);
        }

        .file-entry {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .file-icon {
            font-size: 16px;
            width: 16px;
            text-align: center;
            flex-shrink: 0;
            display: inline-block;
            opacity: 0.9;
        }

        .file-name {
            cursor: pointer;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        
        .file-name:hover {
            text-decoration: underline;
        }

        .file-size, .file-date, .file-perms {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            opacity: 0.8;
        }
        
        tbody tr.selected .file-size,
        tbody tr.selected .file-date,
        tbody tr.selected .file-perms {
            color: inherit;
            opacity: 1;
        }

        .empty-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 100px 20px;
            color: var(--vscode-descriptionForeground);
            text-align: center;
        }

        .empty-state .icon {
            font-size: 48px;
            margin-bottom: 20px;
            opacity: 0.2;
        }

        .loading {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 100px;
            color: var(--vscode-descriptionForeground);
            gap: 16px;
        }

        .spinner {
            width: 24px;
            height: 24px;
            border: 2px solid var(--vscode-progressBar-background, #0e70c0);
            border-top-color: transparent;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        .context-menu {
            position: fixed;
            background-color: var(--vscode-menu-background);
            color: var(--vscode-menu-foreground);
            border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border));
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
            z-index: 1000;
            min-width: 180px;
            display: none;
            border-radius: 4px;
            padding: 4px;
        }

        .context-menu-item {
            padding: 4px 8px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 13px;
            border-radius: 3px;
        }

        .context-menu-item:hover {
            background-color: var(--vscode-menu-selectionBackground);
            color: var(--vscode-menu-selectionForeground);
        }

        .context-menu-separator {
            height: 1px;
            background-color: var(--vscode-menu-separatorBackground);
            margin: 4px 0;
            opacity: 0.5;
        }

        ::-webkit-scrollbar {
            width: 12px;
            height: 12px;
        }

        ::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background);
        }

        ::-webkit-scrollbar-thumb:hover {
            background: var(--vscode-scrollbarSlider-hoverBackground);
        }
    </style>
</head>
<body>
    <div id="toolbar">
        <button class="icon-btn" onclick="goUp()" title="Go to Parent Directory">
            <span class="icon">↑</span>
        </button>
        <div class="toolbar-separator"></div>
        
        <div id="path">/</div>
        
        <button class="icon-btn" onclick="uploadFile()" title="Upload File">
            <span class="icon">☁</span>
        </button>
        <button class="icon-btn" onclick="refresh()" title="Refresh">
            <span class="icon">↻</span>
        </button>
    </div>

    <div id="file-list">
        <div class="loading">Loading...</div>
    </div>

    <div id="context-menu" class="context-menu">
        <div class="context-menu-item" data-action="newFile">New File</div>
        <div class="context-menu-item" data-action="newFolder">New Folder</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="edit" id="ctx-edit" style="display:none">Edit</div>
        <div class="context-menu-item" data-action="download" id="ctx-download" style="display:none">Download</div>
        <div class="context-menu-item" data-action="chmod" id="ctx-chmod" style="display:none">Permissions</div>
        <div class="context-menu-item" data-action="delete" id="ctx-delete" style="display:none">Delete</div>
        <div class="context-menu-separator" id="ctx-separator" style="display:none"></div>
        <div class="context-menu-item" data-action="refresh">Refresh</div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let currentPath = '/';
        let selectedFile = null; // 当前选中的文件信息

        // 接收来自扩展的消息
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'fileList':
                    currentPath = message.path;
                    document.getElementById('path').textContent = currentPath;
                    renderFileList(message.files);
                    break;
            }
        });

        function escapeHtml(str) {
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }

        function renderFileList(files) {
            const container = document.getElementById('file-list');

            if (files.length === 0) {
                container.innerHTML = \`
                    <div class="empty-state">
                        <div class="icon">📂</div>
                        <p>This directory is empty</p>
                        <p class="hint">Right-click to create a file or folder</p>
                    </div>\`;
                return;
            }

            let html = '<table><thead><tr>';
            html += '<th>Name</th>';
            html += '<th>Size</th>';
            html += '<th>Modified</th>';
            html += '<th>Perms</th>';
            html += '<th></th>';
            html += '</tr></thead><tbody>';

            files.forEach((file, index) => {
                const icon = file.isDirectory ? '📁' : '📄';
                const size = file.isDirectory ? '' : formatSize(file.size);
                const filePath = currentPath === '/' ? '/' + file.name : currentPath + '/' + file.name;

                html += \`<tr data-index="\${index}" data-path="\${escapeHtml(filePath)}" data-name="\${escapeHtml(file.name)}" data-is-dir="\${file.isDirectory}" data-perms="\${escapeHtml(file.permissions)}">\`;
                html += \`<td><div class="file-entry"><span class="file-icon">\${icon}</span><span class="file-name" data-name="\${escapeHtml(file.name)}" data-is-dir="\${file.isDirectory}">\${escapeHtml(file.name)}</span></div></td>\`;
                html += \`<td class="file-size">\${size}</td>\`;
                html += \`<td class="file-date">\${escapeHtml(file.mtime)}</td>\`;
                html += \`<td class="file-perms">\${escapeHtml(file.permissions)}</td>\`;
                html += '<td><div class="actions">';
                if (!file.isDirectory) {
                    html += \`<button class="action-btn edit-btn" data-path="\${escapeHtml(filePath)}" title="Edit">✎</button>\`;
                    html += \`<button class="action-btn download-btn" data-path="\${escapeHtml(filePath)}" data-name="\${escapeHtml(file.name)}" title="Download">↓</button>\`;
                }
                html += \`<button class="action-btn chmod-btn" data-path="\${escapeHtml(filePath)}" data-perms="\${escapeHtml(file.permissions)}" title="Permissions">⚙</button>\`;
                html += \`<button class="action-btn delete-btn" data-path="\${escapeHtml(filePath)}" data-is-dir="\${file.isDirectory}" title="Delete">×</button>\`;
                html += '</div></td>';
                html += '</tr>';
            });

            html += '</tbody></table>';
            container.innerHTML = html;

            // Add event listeners
            addTableEventListeners();
        }

        function addTableEventListeners() {
            // 文件名点击事件
            document.querySelectorAll('.file-name').forEach(el => {
                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const name = el.dataset.name;
                    const isDir = el.dataset.isDir === 'true';
                    navigate(name, isDir);
                });
            });

            // Download 按钮
            document.querySelectorAll('.download-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    downloadFile(btn.dataset.path, btn.dataset.name);
                });
            });

            // Edit 按钮
            document.querySelectorAll('.edit-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    openForEdit(btn.dataset.path);
                });
            });

            // Chmod 按钮
            document.querySelectorAll('.chmod-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    changePermissions(btn.dataset.path, btn.dataset.perms);
                });
            });

            // Delete 按钮
            document.querySelectorAll('.delete-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    deleteFile(btn.dataset.path, btn.dataset.isDir === 'true');
                });
            });

            // 行右键菜单
            document.querySelectorAll('#file-list tr[data-path]').forEach(row => {
                row.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    
                    // 高亮选中的行
                    document.querySelectorAll('#file-list tr').forEach(r => r.classList.remove('selected'));
                    row.classList.add('selected');
                    
                    // 设置选中的文件信息
                    selectedFile = {
                        path: row.dataset.path,
                        name: row.dataset.name,
                        isDirectory: row.dataset.isDir === 'true',
                        permissions: row.dataset.perms
                    };
                    
                    showContextMenu(e, true);
                });
            });
        }

        function navigate(name, isDirectory) {
            if (isDirectory) {
                const newPath = currentPath === '/' ? '/' + name : currentPath + '/' + name;
                vscode.postMessage({
                    type: 'navigate',
                    path: newPath
                });
            }
        }

        function goUp() {
            if (currentPath === '/') return;
            const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/')) || '/';
            vscode.postMessage({
                type: 'navigate',
                path: parentPath
            });
        }

        function downloadFile(path, name) {
            vscode.postMessage({
                type: 'download',
                path: path,
                name: name
            });
        }

        function openForEdit(path) {
            vscode.postMessage({
                type: 'edit',
                path: path
            });
        }

        function uploadFile() {
            vscode.postMessage({
                type: 'upload'
            });
        }

        function deleteFile(path, isDirectory) {
            vscode.postMessage({
                type: 'delete',
                path: path,
                isDirectory: isDirectory
            });
        }

        function createNewFolder() {
            vscode.postMessage({
                type: 'promptCreateFolder'
            });
        }

        function createNewFile() {
            vscode.postMessage({
                type: 'promptCreateFile'
            });
        }

        // Context menu functions
        function showContextMenu(event, hasFile = false) {
            event.preventDefault();
            const menu = document.getElementById('context-menu');
            
            // 显示/隐藏文件相关菜单项
            document.getElementById('ctx-edit').style.display = hasFile && selectedFile && !selectedFile.isDirectory ? 'flex' : 'none';
            document.getElementById('ctx-download').style.display = hasFile && selectedFile && !selectedFile.isDirectory ? 'flex' : 'none';
            document.getElementById('ctx-chmod').style.display = hasFile ? 'flex' : 'none';
            document.getElementById('ctx-delete').style.display = hasFile ? 'flex' : 'none';
            document.getElementById('ctx-separator').style.display = hasFile ? 'block' : 'none';
            
            // 定位菜单
            menu.style.display = 'block';
            
            // 确保菜单不超出视口
            const menuRect = menu.getBoundingClientRect();
            let x = event.clientX;
            let y = event.clientY;
            
            if (x + menuRect.width > window.innerWidth) {
                x = window.innerWidth - menuRect.width - 5;
            }
            if (y + menuRect.height > window.innerHeight) {
                y = window.innerHeight - menuRect.height - 5;
            }
            
            menu.style.left = x + 'px';
            menu.style.top = y + 'px';
        }

        function hideContextMenu() {
            const menu = document.getElementById('context-menu');
            menu.style.display = 'none';
            // 不立即清除 selectedFile，直到下一次操作或显式点击空白处
        }

        // 上下文菜单项点击事件
        document.querySelectorAll('.context-menu-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = item.dataset.action;
                
                // 执行动作
                switch (action) {
                    case 'newFile':
                        createNewFile();
                        break;
                    case 'newFolder':
                        createNewFolder();
                        break;
                    case 'refresh':
                        refresh();
                        break;
                    case 'edit':
                        if (selectedFile && !selectedFile.isDirectory) {
                            openForEdit(selectedFile.path);
                        }
                        break;
                    case 'download':
                        if (selectedFile && !selectedFile.isDirectory) {
                            downloadFile(selectedFile.path, selectedFile.name);
                        }
                        break;
                    case 'chmod':
                        if (selectedFile) {
                            changePermissions(selectedFile.path, selectedFile.permissions);
                        }
                        break;
                    case 'delete':
                        if (selectedFile) {
                            deleteFile(selectedFile.path, selectedFile.isDirectory);
                        }
                        break;
                }
                
                hideContextMenu();
                selectedFile = null;
                document.querySelectorAll('#file-list tr').forEach(r => r.classList.remove('selected'));
            });
        });

        // 空白区域右键菜单
        document.getElementById('file-list').addEventListener('contextmenu', (e) => {
            // 如果点击的不是表格行，显示基本菜单
            if (!e.target.closest('tr[data-path]')) {
                e.preventDefault();
                selectedFile = null;
                document.querySelectorAll('#file-list tr').forEach(r => r.classList.remove('selected'));
                showContextMenu(e, false);
            }
        });

        // 点击其他地方隐藏菜单
        document.addEventListener('click', (e) => {
            if (!e.target.closest('#context-menu')) {
                hideContextMenu();
            }
        });

        // ESC 键隐藏菜单
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                hideContextMenu();
            }
        });

        function changePermissions(path, currentPerms) {
            const octalPerms = getOctalFromSymbolic(currentPerms);
            vscode.postMessage({
                type: 'promptChangePermissions',
                path: path,
                currentPermissions: octalPerms
            });
        }

        function getOctalFromSymbolic(symbolic) {
            // 将符号权限转换为八进制 (如 -rw-r--r-- -> 644)
            if (symbolic.length !== 10) return '644';

            let octal = '';
            for (let i = 1; i < 10; i += 3) {
                let value = 0;
                if (symbolic[i] === 'r') value += 4;
                if (symbolic[i + 1] === 'w') value += 2;
                if (symbolic[i + 2] === 'x') value += 1;
                octal += value;
            }
            return octal;
        }

        function refresh() {
            vscode.postMessage({
                type: 'refresh'
            });
        }

        function formatSize(bytes) {
            if (bytes === 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        }
    </script>
</body>
</html>`;
  }

  /**
   * 清理资源
   */
  public dispose() {
    const sessionKey = this.config.id;
    FileManagerPanel.panels.delete(sessionKey);

    if (this.sftp) {
      this.sftp.end();
    }

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
    for (const panel of FileManagerPanel.panels.values()) {
      panel.dispose();
    }
    FileManagerPanel.panels.clear();
  }
}
