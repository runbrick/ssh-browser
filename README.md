# SSH Browser - VSCode Extension

<p align="center">
  <img src="resources/logo.png" width="128" alt="SSH Browser Logo">
</p>

SSH Browser is a powerful VSCode extension designed to provide developers with a seamless Linux server management experience. It integrates terminal, file management, system monitoring, and Docker management, all within VSCode.


## 🚀 Key Features

- **Connection Management**: 
  - Support for connection grouping with drag-and-drop management.
  - **Double-click** to connect and automatically open an SSH session panel.
  - Automatic reconnection with exponential backoff strategy.
- **SSH Terminal (Session)**:
  - High-performance terminal interface based on Webview.
  - Support for command history and intelligent command prediction.
  - One-click clear screen, copy, and paste.
  - Real-time synchronization between terminal path and file manager.
- **File Manager**:
  - Visual SFTP file browser.
  - Support for file upload, download, delete, and rename.
  - Direct editing of remote files.
- **System Monitoring**:
  - Real-time view of server CPU, Memory, Swap, Disk Space, and Network Traffic.
  - Automatic refresh with customizable frequency.
- **Docker Management**:
  - Real-time monitoring of Docker container status.
  - Support for start, stop, and restart containers.
- **UI Optimization**:
  - Clean and intuitive SVG icons in VSCode native style.
  - Split-screen mode: File management, monitoring, and Docker interfaces automatically open in a split view on the right when clicked.

## 🛠 Technologies & Modules

This extension primarily uses the following core modules:

- **[ssh2](https://github.com/mscdex/ssh2)**: Core SSH protocol library for low-level connections, command execution, and shell stream handling.
- **[ssh2-sftp-client](https://github.com/theophilusx/ssh2-sftp-client)**: SFTP wrapper based on `ssh2`, providing a more convenient file operation interface.
- **[xterm.js](https://xtermjs.org/)**: Frontend terminal emulator for rendering high-performance SSH sessions in Webview.
- **VSCode Webview API**: Used to build all custom management interfaces (Terminal, File Manager, Monitoring, etc.).
- **VSCode TreeDataProvider**: Implements the connection list and grouping in the Activity Bar.

## 📖 Usage Instructions

1. **Add Connection**: Click the SSH Browser icon in the Activity Bar, then click the `+` button at the top to add server configurations.
2. **Connect to Server**: **Double-click** a server entry in the list to establish a connection and open the SSH terminal.
3. **Manage Groups**: Click the folder icon at the top to create a new group. Drag and drop connections to move them in or out of groups.
4. **Use Tools**: 
   - In the toolbar at the top of the SSH session panel, click the corresponding buttons to open **File Manager**, **System Monitor**, or **Docker Management**.
   - These tools will automatically open in a **split view** to the right of the current editor for easy reference.
5. **Disconnect**: Close the corresponding SSH session tab, and the extension will safely disconnect from the server.

## ⚙ Configuration

You can search for `sshBrowser` in VSCode settings to adjust the following:
- `sshBrowser.terminal.theme`: Change terminal color scheme.
- `sshBrowser.terminal.rightClickBehavior`: Set right-click behavior (context menu or direct paste).
- `sshBrowser.fileManager.syncWithTerminal`: Enable/disable path synchronization between the terminal and file manager.

## 📦 Packaging & Installation

To package the extension into a `.vsix` file for manual installation, run the following in the project root:

```bash
npm run build:vsix
```

After packaging, select "Install from VSIX..." in the VSCode Extensions panel to install the generated file.

---
**Note**: The extension may request a password or private key passphrase when establishing a connection. This information is securely stored in VSCode's `SecretStorage`.
