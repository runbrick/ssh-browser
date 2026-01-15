import { SSHManager } from './sshManager';
import { SystemMetrics, DiskInfo, NetworkInfo } from '../types';

/**
 * 系统指标采集器
 * 通过 SSH 执行命令获取服务器系统监控指标
 */
export class SystemMetricsCollector {
    private sshManager: SSHManager;

    constructor(sshManager: SSHManager) {
        this.sshManager = sshManager;
    }

    /**
     * 采集系统指标
     * @param connectionId SSH 连接 ID
     * @returns 系统指标数据
     */
    async collect(connectionId: string): Promise<SystemMetrics> {
        // 批量执行命令以减少往返次数
        const command = `
echo "=CPU="; top -bn1 | grep "Cpu(s)" 2>/dev/null || mpstat 1 1 2>/dev/null | tail -1;
echo "=CORES="; nproc 2>/dev/null || grep -c processor /proc/cpuinfo 2>/dev/null || echo 1;
echo "=CPUMODEL="; grep "model name" /proc/cpuinfo 2>/dev/null | head -1 | cut -d: -f2 | xargs;
echo "=MEM="; free -b 2>/dev/null | grep -E "^Mem:";
echo "=SWAP="; free -b 2>/dev/null | grep -E "^Swap:";
echo "=LOAD="; uptime;
echo "=DISK="; df -B1 2>/dev/null | grep -E "^/dev/" | awk '{print $1","$2","$3","$4","$5","$6}';
echo "=NETWORK="; cat /proc/net/dev 2>/dev/null | grep -E "^\\s*(eth|ens|enp|wlan|wlp|bond|veth)" | awk '{gsub(/:/, ""); print $1","$2","$3","$10","$11}';
echo "=HOSTNAME="; hostname 2>/dev/null || cat /etc/hostname 2>/dev/null;
echo "=UPTIME="; cat /proc/uptime 2>/dev/null | awk '{print $1}';
echo "=PROCS="; ps aux 2>/dev/null | wc -l;
echo "=USERS="; who 2>/dev/null | wc -l;
echo "=OS="; cat /etc/os-release 2>/dev/null | grep "^PRETTY_NAME=" | cut -d'"' -f2 || uname -o 2>/dev/null;
echo "=KERNEL="; uname -r 2>/dev/null;
`;

        const output = await this.sshManager.execCommand(connectionId, command);

        return this.parseMetrics(output);
    }

    /**
     * 解析命令输出为结构化数据
     * @param output 命令执行输出
     * @returns 系统指标对象
     */
    private parseMetrics(output: string): SystemMetrics {
        const lines = output.split('\n').map(l => l.trim());

        // 初始化默认值
        const metrics: SystemMetrics = {
            cpu: {
                usage: 0,
                cores: 1
            },
            memory: {
                total: 0,
                used: 0,
                available: 0,
                usagePercent: 0
            },
            swap: {
                total: 0,
                used: 0,
                free: 0,
                usagePercent: 0
            },
            load: {
                load1: 0,
                load5: 0,
                load15: 0
            },
            disks: [],
            network: [],
            system: {
                hostname: 'unknown',
                uptime: 0,
                processCount: 0,
                userCount: 0
            },
            timestamp: new Date()
        };

        try {
            // 解析 CPU 使用率
            const cpuIndex = lines.findIndex(l => l === '=CPU=');
            if (cpuIndex !== -1 && cpuIndex + 1 < lines.length) {
                const cpuLine = lines[cpuIndex + 1];
                // 示例输出: Cpu(s): 12.5%us, 3.2%sy, 0.0%ni, 84.3%id, ...
                // 提取 idle 百分比，然后计算 usage = 100 - idle
                const idleMatch = cpuLine.match(/(\d+\.?\d*)%?\s*id/i);
                if (idleMatch) {
                    const idle = parseFloat(idleMatch[1]);
                    metrics.cpu.usage = Math.round(100 - idle);
                }
            }

            // 解析 CPU 核心数
            const coresIndex = lines.findIndex(l => l === '=CORES=');
            if (coresIndex !== -1 && coresIndex + 1 < lines.length) {
                const coresLine = lines[coresIndex + 1];
                const cores = parseInt(coresLine.trim(), 10);
                if (!isNaN(cores)) {
                    metrics.cpu.cores = cores;
                }
            }

            // 解析 CPU 型号
            const cpuModelIndex = lines.findIndex(l => l === '=CPUMODEL=');
            if (cpuModelIndex !== -1 && cpuModelIndex + 1 < lines.length) {
                const modelLine = lines[cpuModelIndex + 1].trim();
                if (modelLine && modelLine !== '') {
                    metrics.cpu.model = modelLine;
                }
            }

            // 解析内存信息
            const memIndex = lines.findIndex(l => l === '=MEM=');
            if (memIndex !== -1 && memIndex + 1 < lines.length) {
                const memLine = lines[memIndex + 1];
                // 示例输出: Mem: 8589934592 4294967296 2147483648 ...
                // 字段顺序: total used free shared buff/cache available
                const memParts = memLine.split(/\s+/);
                if (memParts.length >= 6) {
                    metrics.memory.total = parseInt(memParts[1], 10) || 0;
                    metrics.memory.used = parseInt(memParts[2], 10) || 0;
                    if (memParts.length >= 7) {
                        metrics.memory.available = parseInt(memParts[6], 10) || 0;
                    }
                    if (memParts.length >= 6) {
                        metrics.memory.buffers = parseInt(memParts[4], 10) || 0;
                        metrics.memory.cached = parseInt(memParts[5], 10) || 0;
                    }

                    if (metrics.memory.total > 0) {
                        metrics.memory.usagePercent = Math.round(
                            (metrics.memory.used / metrics.memory.total) * 100
                        );
                    }
                }
            }

            // 解析 Swap 信息
            const swapIndex = lines.findIndex(l => l === '=SWAP=');
            if (swapIndex !== -1 && swapIndex + 1 < lines.length) {
                const swapLine = lines[swapIndex + 1];
                const swapParts = swapLine.split(/\s+/);
                if (swapParts.length >= 4) {
                    metrics.swap.total = parseInt(swapParts[1], 10) || 0;
                    metrics.swap.used = parseInt(swapParts[2], 10) || 0;
                    metrics.swap.free = parseInt(swapParts[3], 10) || 0;

                    if (metrics.swap.total > 0) {
                        metrics.swap.usagePercent = Math.round(
                            (metrics.swap.used / metrics.swap.total) * 100
                        );
                    }
                }
            }

            // 解析系统负载
            const loadIndex = lines.findIndex(l => l === '=LOAD=');
            if (loadIndex !== -1 && loadIndex + 1 < lines.length) {
                const loadLine = lines[loadIndex + 1];
                // 示例输出: 20:45:23 up 10 days, 5:23, 2 users, load average: 0.52, 0.58, 0.59
                const loadMatch = loadLine.match(/load average:\s*(\d+\.?\d*),\s*(\d+\.?\d*),\s*(\d+\.?\d*)/i);
                if (loadMatch) {
                    metrics.load.load1 = parseFloat(loadMatch[1]);
                    metrics.load.load5 = parseFloat(loadMatch[2]);
                    metrics.load.load15 = parseFloat(loadMatch[3]);
                }
            }

            // 解析磁盘信息
            const diskIndex = lines.findIndex(l => l === '=DISK=');
            if (diskIndex !== -1) {
                for (let i = diskIndex + 1; i < lines.length; i++) {
                    const line = lines[i];
                    if (line.startsWith('=') || line === '') {
                        break;
                    }
                    const parts = line.split(',');
                    if (parts.length >= 6) {
                        const disk: DiskInfo = {
                            filesystem: parts[0],
                            total: parseInt(parts[1], 10) || 0,
                            used: parseInt(parts[2], 10) || 0,
                            available: parseInt(parts[3], 10) || 0,
                            usagePercent: parseInt(parts[4].replace('%', ''), 10) || 0,
                            mountPoint: parts[5]
                        };
                        metrics.disks.push(disk);
                    }
                }
            }

            // 解析网络信息
            const networkIndex = lines.findIndex(l => l === '=NETWORK=');
            if (networkIndex !== -1) {
                for (let i = networkIndex + 1; i < lines.length; i++) {
                    const line = lines[i];
                    if (line.startsWith('=') || line === '') {
                        break;
                    }
                    const parts = line.split(',');
                    if (parts.length >= 5) {
                        const net: NetworkInfo = {
                            interface: parts[0].trim(),
                            rxBytes: parseInt(parts[1], 10) || 0,
                            rxPackets: parseInt(parts[2], 10) || 0,
                            txBytes: parseInt(parts[3], 10) || 0,
                            txPackets: parseInt(parts[4], 10) || 0
                        };
                        metrics.network.push(net);
                    }
                }
            }

            // 解析主机名
            const hostnameIndex = lines.findIndex(l => l === '=HOSTNAME=');
            if (hostnameIndex !== -1 && hostnameIndex + 1 < lines.length) {
                const hostname = lines[hostnameIndex + 1].trim();
                if (hostname) {
                    metrics.system.hostname = hostname;
                }
            }

            // 解析运行时间
            const uptimeIndex = lines.findIndex(l => l === '=UPTIME=');
            if (uptimeIndex !== -1 && uptimeIndex + 1 < lines.length) {
                const uptime = parseFloat(lines[uptimeIndex + 1].trim());
                if (!isNaN(uptime)) {
                    metrics.system.uptime = Math.floor(uptime);
                }
            }

            // 解析进程数
            const procsIndex = lines.findIndex(l => l === '=PROCS=');
            if (procsIndex !== -1 && procsIndex + 1 < lines.length) {
                const procs = parseInt(lines[procsIndex + 1].trim(), 10);
                if (!isNaN(procs)) {
                    metrics.system.processCount = procs - 1; // 减去表头行
                }
            }

            // 解析用户数
            const usersIndex = lines.findIndex(l => l === '=USERS=');
            if (usersIndex !== -1 && usersIndex + 1 < lines.length) {
                const users = parseInt(lines[usersIndex + 1].trim(), 10);
                if (!isNaN(users)) {
                    metrics.system.userCount = users;
                }
            }

            // 解析操作系统
            const osIndex = lines.findIndex(l => l === '=OS=');
            if (osIndex !== -1 && osIndex + 1 < lines.length) {
                const os = lines[osIndex + 1].trim();
                if (os) {
                    metrics.system.os = os;
                }
            }

            // 解析内核版本
            const kernelIndex = lines.findIndex(l => l === '=KERNEL=');
            if (kernelIndex !== -1 && kernelIndex + 1 < lines.length) {
                const kernel = lines[kernelIndex + 1].trim();
                if (kernel) {
                    metrics.system.kernel = kernel;
                }
            }

        } catch (error) {
            console.error('解析系统指标时出错:', error);
        }

        return metrics;
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
