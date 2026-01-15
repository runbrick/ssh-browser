import { SSHManager } from './sshManager';
import { DockerContainerInfo } from '../types';

/**
 * Docker 容器管理器
 * 通过 SSH 执行 Docker 命令获取和管理容器
 */
export class DockerManager {
    private sshManager: SSHManager;

    constructor(sshManager: SSHManager) {
        this.sshManager = sshManager;
    }

    /**
     * 获取所有容器信息
     * @param connectionId SSH 连接 ID
     * @returns 容器信息列表
     */
    async listContainers(connectionId: string): Promise<DockerContainerInfo[]> {
        try {
            // 首先检查 Docker 是否可用
            const dockerCheckCommand = 'command -v docker >/dev/null 2>&1 && echo "OK" || echo "NOTFOUND"';
            const dockerCheck = await this.sshManager.execCommand(connectionId, dockerCheckCommand);

            if (dockerCheck.trim() === 'NOTFOUND') {
                console.error('Docker 未安装或不在 PATH 中');
                return [];
            }

            // 检查 Docker 服务是否运行
            const dockerStatusCommand = 'docker info >/dev/null 2>&1 && echo "OK" || echo "NOTRUNNING"';
            const dockerStatus = await this.sshManager.execCommand(connectionId, dockerStatusCommand);

            if (dockerStatus.trim() === 'NOTRUNNING') {
                console.error('Docker 服务未运行或无权限访问');
                return [];
            }

            // 批量执行命令以减少往返次数
            // 使用 docker ps 作为主要数据源，docker stats 作为补充
            const command = `
echo "=DOCKERPS="; docker ps -a --format "{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}" 2>&1 || echo "";
echo "=DOCKER="; docker stats --no-stream --format "{{.ID}}|{{.Name}}|{{.Image}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}|{{.PIDs}}" 2>&1 || echo "";
`;

            const output = await this.sshManager.execCommand(connectionId, command);

            // 检查是否有错误输出
            if (output.includes('Cannot connect to the Docker daemon') ||
                output.includes('permission denied') ||
                output.includes('command not found')) {
                console.error('Docker 命令执行失败:', output);
                return [];
            }

            return this.parseContainers(output);
        } catch (error) {
            console.error('获取 Docker 容器信息失败:', error);
            return [];
        }
    }

    /**
     * 解析 Docker 命令输出为容器信息列表
     * @param output 命令执行输出
     * @returns 容器信息列表
     */
    private parseContainers(output: string): DockerContainerInfo[] {
        const lines = output.split('\n').map(l => l.trim());
        const containers: DockerContainerInfo[] = [];

        try {
            const dockerPsIndex = lines.findIndex(l => l === '=DOCKERPS=');
            const dockerIndex = lines.findIndex(l => l === '=DOCKER=');

            // 验证标记是否存在
            if (dockerPsIndex === -1) {
                console.error('Docker 输出格式无效：缺少 DOCKERPS 标记');
                return [];
            }

            // 首先收集 docker stats 的性能数据（可选）
            const statsMap = new Map<string, any>();
            if (dockerIndex !== -1 && dockerIndex + 1 < lines.length) {
                for (let i = dockerIndex + 1; i < lines.length; i++) {
                    const line = lines[i];
                    if (line.startsWith('=') || line === '') {
                        break;
                    }

                    try {
                        // 格式: ID|Name|Image|CPUPerc|MemUsage|MemPerc|NetIO|BlockIO|PIDs
                        const parts = line.split('|');
                        if (parts.length >= 9) {
                            const containerId = parts[0].trim();

                            // 解析 CPU 百分比
                            const cpuPercent = parseFloat(parts[3].replace('%', '')) || 0;

                            // 解析内存使用量
                            const memUsageStr = parts[4].trim();
                            const memMatch = memUsageStr.match(/([\d.]+)([KMGT]i?B)\s*\/\s*([\d.]+)([KMGT]i?B)/);
                            let memUsage = 0;
                            let memLimit = 0;
                            if (memMatch) {
                                memUsage = this.parseDockerSize(memMatch[1], memMatch[2]);
                                memLimit = this.parseDockerSize(memMatch[3], memMatch[4]);
                            }

                            // 解析内存百分比
                            const memPercent = parseFloat(parts[5].replace('%', '')) || 0;

                            // 解析网络 IO
                            const netIOStr = parts[6].trim();
                            const netMatch = netIOStr.match(/([\d.]+)([KMGT]?B)\s*\/\s*([\d.]+)([KMGT]?B)/);
                            let netInput = 0;
                            let netOutput = 0;
                            if (netMatch) {
                                netInput = this.parseDockerSize(netMatch[1], netMatch[2]);
                                netOutput = this.parseDockerSize(netMatch[3], netMatch[4]);
                            }

                            // 解析块 IO
                            const blockIOStr = parts[7].trim();
                            const blockMatch = blockIOStr.match(/([\d.]+)([KMGT]?B)\s*\/\s*([\d.]+)([KMGT]?B)/);
                            let blockInput = 0;
                            let blockOutput = 0;
                            if (blockMatch) {
                                blockInput = this.parseDockerSize(blockMatch[1], blockMatch[2]);
                                blockOutput = this.parseDockerSize(blockMatch[3], blockMatch[4]);
                            }

                            // 解析进程数
                            const pids = parseInt(parts[8].trim(), 10) || 0;

                            // 存储时使用短 ID（前12位）和完整 ID
                            const stats = {
                                cpuPercent,
                                memUsage,
                                memLimit,
                                memPercent,
                                netInput,
                                netOutput,
                                blockInput,
                                blockOutput,
                                pids
                            };

                            statsMap.set(containerId, stats);
                            // 同时存储短 ID 版本以便匹配
                            if (containerId.length > 12) {
                                statsMap.set(containerId.substring(0, 12), stats);
                            }
                        }
                    } catch (lineError) {
                        console.warn(`解析 docker stats 行时出错：${line}`, lineError);
                        // 继续处理下一行
                    }
                }
            }

            // 解析 docker ps 输出作为主要数据源（包含所有容器，不管是否运行）
            if (dockerPsIndex !== -1 && dockerPsIndex + 1 < lines.length) {
                for (let i = dockerPsIndex + 1; i < lines.length; i++) {
                    const line = lines[i];
                    if (line.startsWith('=') || line === '') {
                        break;
                    }

                    try {
                        // 格式: ID|Names|Image|Status
                        const parts = line.split('|');
                        if (parts.length < 4) {
                            console.warn(`跳过格式不正确的容器行：${line}`);
                            continue;
                        }

                        const containerId = parts[0].trim();
                        const containerName = parts[1].trim();
                        const image = parts[2].trim();
                        const status = parts[3].trim();

                        // 从 statsMap 获取性能数据（尝试完整 ID 和短 ID）
                        let stats = statsMap.get(containerId);
                        if (!stats && containerId.length > 12) {
                            stats = statsMap.get(containerId.substring(0, 12));
                        }
                        if (!stats) {
                            stats = {
                                cpuPercent: 0,
                                memUsage: 0,
                                memLimit: 0,
                                memPercent: 0,
                                netInput: 0,
                                netOutput: 0,
                                blockInput: 0,
                                blockOutput: 0,
                                pids: 0
                            };
                        }

                        const container: DockerContainerInfo = {
                            id: containerId,
                            name: containerName,
                            image: image,
                            status: status,
                            ...stats
                        };
                        containers.push(container);
                    } catch (lineError) {
                        console.error(`解析容器行时出错：${line}`, lineError);
                        // 继续处理下一行
                    }
                }
            }
        } catch (error) {
            console.error('解析 Docker 容器信息时出错:', error);
        }

        return containers;
    }

    /**
     * Start a Docker container
     * @param connectionId SSH connection ID
     * @param containerId Container ID
     * @returns Success status
     */
    async startContainer(connectionId: string, containerId: string): Promise<boolean> {
        try {
            const command = `docker start ${containerId}`;
            const output = await this.sshManager.execCommand(connectionId, command);

            // Check for errors in output
            if (output.includes('Error') || output.includes('error')) {
                console.error(`Failed to start container ${containerId}:`, output);
                return false;
            }

            return true;
        } catch (error) {
            console.error(`Failed to start container ${containerId}:`, error);
            return false;
        }
    }

    /**
     * Stop a Docker container
     * @param connectionId SSH connection ID
     * @param containerId Container ID
     * @returns Success status
     */
    async stopContainer(connectionId: string, containerId: string): Promise<boolean> {
        try {
            const command = `docker stop ${containerId}`;
            const output = await this.sshManager.execCommand(connectionId, command);

            // Check for errors in output
            if (output.includes('Error') || output.includes('error')) {
                console.error(`Failed to stop container ${containerId}:`, output);
                return false;
            }

            return true;
        } catch (error) {
            console.error(`Failed to stop container ${containerId}:`, error);
            return false;
        }
    }

    /**
     * Restart a Docker container
     * @param connectionId SSH connection ID
     * @param containerId Container ID
     * @returns Success status
     */
    async restartContainer(connectionId: string, containerId: string): Promise<boolean> {
        try {
            const command = `docker restart ${containerId}`;
            const output = await this.sshManager.execCommand(connectionId, command);

            // Check for errors in output
            if (output.includes('Error') || output.includes('error')) {
                console.error(`Failed to restart container ${containerId}:`, output);
                return false;
            }

            return true;
        } catch (error) {
            console.error(`Failed to restart container ${containerId}:`, error);
            return false;
        }
    }

    /**
     * Parse Docker output size format to bytes
     * @param value Number part (e.g., "1.5")
     * @param unit Unit part (e.g., "GiB", "MB", "KB")
     * @returns Bytes
     */
    private parseDockerSize(value: string, unit: string): number {
        const num = parseFloat(value);
        if (isNaN(num)) {
            return 0;
        }

        const unitUpper = unit.toUpperCase();
        // Docker 可能使用 MB (1000-based) 或 MiB (1024-based)
        const is1024Based = unitUpper.includes('I');
        const base = is1024Based ? 1024 : 1000;

        // 提取单位字母 (M, G, K, T)
        const unitLetter = unitUpper.charAt(0);

        const multipliers: { [key: string]: number } = {
            'B': 1,
            'K': base,
            'M': base * base,
            'G': base * base * base,
            'T': base * base * base * base
        };

        return Math.round(num * (multipliers[unitLetter] || 1));
    }

    /**
     * 格式化字节数为可读字符串
     * @param bytes 字节数
     * @returns 格式化后的字符串（如 "1.5 GB"）
     */
    static formatBytes(bytes: number): string {
        if (bytes === 0) {
            return '0 B';
        }

        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
    }
}
