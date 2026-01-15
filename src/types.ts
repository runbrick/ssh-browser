/**
 * SSH 代理（跳板机）配置
 */
export interface SSHProxyConfig {
  /** 代理主机地址 */
  host: string;
  /** 代理端口号 */
  port: number;
  /** 代理用户名 */
  username: string;
  /** 代理认证方式 */
  authType: 'password' | 'privateKey';
  /** 代理私钥路径 */
  privateKeyPath?: string;
}

/**
 * SSH 连接配置接口
 */
export interface SSHConfig {
  /** 连接唯一标识符 */
  id: string;
  /** 服务器名称 */
  name: string;
  /** 主机地址 */
  host: string;
  /** 端口号 */
  port: number;
  /** 用户名 */
  username: string;
  /** 认证方式 */
  authType: 'password' | 'privateKey';
  /** 私钥路径（当 authType 为 privateKey 时使用） */
  privateKeyPath?: string;
  /** 密码提示（不存储实际密码） */
  passwordHint?: string;
  /** 分组名称 */
  group?: string;
  /** 代理配置（跳板机） */
  proxyConfig?: SSHProxyConfig;
}

/**
 * SSH 连接状态
 */
export enum ConnectionStatus {
  /** 已断开 */
  Disconnected = 'disconnected',
  /** 连接中 */
  Connecting = 'connecting',
  /** 已连接 */
  Connected = 'connected',
  /** 连接失败 */
  Failed = 'failed'
}

/**
 * SSH 连接信息（包含状态）
 */
export interface SSHConnection extends SSHConfig {
  /** 连接状态 */
  status: ConnectionStatus;
  /** 最后连接时间 */
  lastConnected?: Date;
  /** 错误信息 */
  error?: string;
}

/**
 * 远程文件信息
 */
export interface RemoteFile {
  /** 文件名 */
  name: string;
  /** 完整路径 */
  path: string;
  /** 是否为目录 */
  isDirectory: boolean;
  /** 文件大小（字节） */
  size: number;
  /** 修改时间 */
  modifiedTime: Date;
  /** 权限 */
  permissions: string;
  /** 所有者 */
  owner: string;
  /** 所属组 */
  group: string;
}

/**
 * 终端会话信息
 */
export interface TerminalSession {
  /** 会话 ID */
  id: string;
  /** 连接配置 ID */
  connectionId: string;
  /** VSCode 终端实例 */
  terminal: any;
  /** 创建时间 */
  createdAt: Date;
}

/**
 * 磁盘信息
 */
export interface DiskInfo {
  /** 挂载点 */
  mountPoint: string;
  /** 文件系统 */
  filesystem: string;
  /** 总大小（字节） */
  total: number;
  /** 已用大小（字节） */
  used: number;
  /** 可用大小（字节） */
  available: number;
  /** 使用率（百分比 0-100） */
  usagePercent: number;
}

/**
 * 网络接口信息
 */
export interface NetworkInfo {
  /** 接口名称 */
  interface: string;
  /** 接收字节数 */
  rxBytes: number;
  /** 发送字节数 */
  txBytes: number;
  /** 接收包数 */
  rxPackets: number;
  /** 发送包数 */
  txPackets: number;
}

/**
 * Docker 容器信息
 */
export interface DockerContainerInfo {
  /** 容器 ID */
  id: string;
  /** 容器名称 */
  name: string;
  /** 镜像名称 */
  image: string;
  /** 运行状态 */
  status: string;
  /** CPU 使用率（百分比） */
  cpuPercent: number;
  /** 内存使用量（字节） */
  memUsage: number;
  /** 内存限制（字节） */
  memLimit: number;
  /** 内存使用率（百分比） */
  memPercent: number;
  /** 网络接收（字节） */
  netInput: number;
  /** 网络发送（字节） */
  netOutput: number;
  /** 块设备读取（字节） */
  blockInput: number;
  /** 块设备写入（字节） */
  blockOutput: number;
  /** 进程数 */
  pids: number;
}

/**
 * 系统监控指标
 */
export interface SystemMetrics {
  /** CPU 信息 */
  cpu: {
    /** CPU 使用率（百分比 0-100） */
    usage: number;
    /** CPU 核心数 */
    cores: number;
    /** CPU 型号 */
    model?: string;
  };
  /** 内存信息 */
  memory: {
    /** 总内存（字节） */
    total: number;
    /** 已用内存（字节） */
    used: number;
    /** 可用内存（字节） */
    available: number;
    /** 内存使用率（百分比 0-100） */
    usagePercent: number;
    /** 缓存大小（字节） */
    cached?: number;
    /** 缓冲区大小（字节） */
    buffers?: number;
  };
  /** 交换内存信息 */
  swap: {
    /** 总交换内存（字节） */
    total: number;
    /** 已用交换内存（字节） */
    used: number;
    /** 可用交换内存（字节） */
    free: number;
    /** 交换内存使用率（百分比 0-100） */
    usagePercent: number;
  };
  /** 系统负载 */
  load: {
    /** 1 分钟负载 */
    load1: number;
    /** 5 分钟负载 */
    load5: number;
    /** 15 分钟负载 */
    load15: number;
  };
  /** 磁盘信息 */
  disks: DiskInfo[];
  /** 网络信息 */
  network: NetworkInfo[];
  /** 系统信息 */
  system: {
    /** 主机名 */
    hostname: string;
    /** 系统运行时间（秒） */
    uptime: number;
    /** 运行中的进程数 */
    processCount: number;
    /** 登录用户数 */
    userCount: number;
    /** 操作系统 */
    os?: string;
    /** 内核版本 */
    kernel?: string;
  };
  /** 采集时间戳 */
  timestamp: Date;
}
