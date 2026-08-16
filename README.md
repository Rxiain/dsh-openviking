[![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)
[![Node: ^22.19.0 || >=24.0.0](https://img.shields.io/badge/Node-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-339933)](package.json)
[![TypeScript](https://img.shields.io/badge/Language-TypeScript-3178C6)](https://www.typescriptlang.org/)
[![DeepSeek Harness](https://img.shields.io/badge/Platform-DeepSeek%20Harness-4B32C3)](https://deepseek-harness.github.io/deepseek-harness/)
[![OpenViking](https://img.shields.io/badge/Service-OpenViking-0052CC)](https://github.com/volcengine/OpenViking)

**简体中文** | [English](README_EN.md)

# dsh-openviking

面向 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) 的 OpenViking 检索、资源管理、自动召回与会话记忆插件

## 功能

| 工具 | 功能 |
| --- | --- |
| `memsearch` | 语义搜索（`auto`/`fast`/`deep`；deep 使用会话上下文） |
| `memfind` | 快速语义查找，不带会话上下文 |
| `memread` | 读取 `viking://` URI（`abstract`/`overview`/`read`/`auto`） |
| `membrowse` | 浏览 `viking://` 文件系统（`list`/`tree`/`stat`） |
| `memgrep` | 精确/正则内容搜索（默认 `viking://resources/`） |
| `memglob` | 按 glob 模式枚举文件 |
| `memadd` | 在 `viking://resources/` 下添加远程 URL 或本地文本文件 |
| `memremove` | 删除资源——需字面量 `confirm: true` |
| `memqueue` | 查看观察者队列状态 |
| `memcommit` | 提交当前会话并提取持久记忆 |

另含：已索引仓库上下文注入、通过上下文注入通道自动召回、会话同步 + 自动提交。

## 快速开始

```sh
# 一键安装（GitHub 仓库，含预构建 lib/，无需构建授权）：
sh install.sh [profile-name]          # 默认 profile: dsh-openviking

# 或手动安装：
dsh plugin --profile <name> add github:Rxiain/dsh-openviking
dsh --profile <name>
```

配置默认指向 `http://localhost:1933`。如需覆盖任何设置，请在 profile 的
`cordis.patch.yml` 中以 `id: openviking` 写入**完整**配置（patch 整体替换
`config`）：

```yaml
- id: openviking
  config:
    endpoint: 'http://localhost:1933'
    # X-API-Key 认证头；为空则省略
    apiKey: !!js process.env.OPENVIKING_API_KEY ?? ''
    # X-OpenViking-Account 租户头；为空则省略
    account: ''
    # X-OpenViking-User 用户头；为空则省略
    user: ''
    # X-OpenViking-Agent agent 标识头；为空则省略
    agentId: 'deepseek-harness'
    # 单次请求超时（毫秒），范围 1000–300000
    timeoutMs: 30000
    # 会话同步状态文件（~ 会展开）；只存消息 id，不存正文或密钥
    stateFile: '~/.dsh/openviking/state.json'
    # 将已索引仓库列表注入提示词
    repoContext:
      enabled: true
      # 仓库列表缓存 TTL（毫秒），范围 1000–3600000
      cacheTtlMs: 60000
    # 每个模型步骤前自动召回相关记忆
    autoRecall:
      enabled: true
      # 每步最多注入的记忆条数，范围 1–50
      limit: 6
      # 补充记忆的最低分数，范围 0–1
      scoreThreshold: 0.15
      # 单条记忆内容上限（字符），范围 100–5000
      maxContentChars: 500
      # 注入预算 ≈ tokenBudget × 4 字符，范围 100–10000
      tokenBudget: 2000
    # 定期提交含未提交消息的会话
    autoCommit:
      enabled: true
      # 两次自动提交之间的最少分钟数，至少 1
      intervalMinutes: 10
```


## 可视化配置（dsh Web UI）

部署 `dsh web` 时，插件配置可以直接在浏览器里编辑：**设置 → 插件 → 插件配置 → OpenViking**。卡片字段与上方 YAML 完全对应，保存后写入 `$DSH_HOME/settings.yaml` 的用户层，叠加在 profile 的 `id: openviking` 配置之上：

- 请求相关字段（`endpoint`、`apiKey`、`account`/`user`/`agentId`、`timeoutMs`、`repoContext.*`、`autoRecall.*`、自动提交间隔）**保存即生效**；
- `stateFile` 在插件启动时读取，修改后需重启；
- 已覆盖的字段显示「已覆盖」徽标，可一键「恢复默认」（清掉用户层覆盖，重新继承 profile 配置）；
- 非法值（含非 http(s) 的 `endpoint`）在保存时被设置层拒绝，不会写入。

该卡片是插件的浏览器半（`dsh.client` + `exports["./client"]`，构建产物 `lib/client-ui.js`）。宿主侧只把白名单内的 settings 命名空间下发给浏览器，因此本部署需要把 `openviking` 加入已安装 `@deepseek-ai/dsh-host-apiproxy` 的 `WEB_SETTINGS_NAMESPACES`——仓库提供了一键脚本（把打过补丁的副本放到 profile 自己的 `node_modules`，不改动系统安装）：

```sh
node scripts/patch-dsh-exposure.mjs --profile web
```

在 `dsh plugin --profile web add|remove`（pnpm 会清理 profile 的 `node_modules`）或升级 dsh 之后重新执行；如果插件页里卡片消失，先跑这个脚本再重启 `dsh web`。

## 创建账号与密钥

管理命令需要 root 密钥（本地服务通常位于 `~/.openviking/root_api_key.txt`）：

```sh
ROOT=$(cat ~/.openviking/root_api_key.txt)
printf '{"url":"http://localhost:1933","api_key":"%s"}' "$ROOT" > /tmp/ov-root.conf
export OPENVIKING_CLI_CONFIG_FILE=/tmp/ov-root.conf

ov admin create-account dsh --admin dsh-admin   # 建账号 dsh + 首个管理员，返回其密钥
ov admin register-user dsh dsh --role user      # 账号 dsh 内注册普通用户 dsh，返回其密钥
ov admin regenerate-key dsh dsh                 # 重新生成密钥（旧密钥立即失效）

unset OPENVIKING_CLI_CONFIG_FILE && rm -f /tmp/ov-root.conf
```

把返回的密钥填入插件配置的 `apiKey`，`account`/`user` 填对应的账号与用户。

## 贡献

欢迎贡献：

1. Fork 仓库并创建功能分支（`git checkout -b feature/your-change`）
2. 修改代码，并补充或更新测试
3. 运行 `npm test` 验证（默认套件无需 OpenViking 服务）
4. 提交并打开 Pull Request

## 许可证与致谢

[MIT](LICENSE)

参考了：

- [@tanyouqing/pi-openviking](https://pi.dev/packages/@tanyouqing/pi-openviking)（[源码仓库](https://github.com/tanyouqing/Opencode_openviking-plugin)）
- 上游：[volcengine/OpenViking](https://github.com/volcengine/OpenViking)
