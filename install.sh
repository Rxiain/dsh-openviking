#!/bin/sh
# dsh-openviking 一键安装（GitHub 版）。
# 走官方 dsh CLI 的 profile 插件机制：`add` 自动初始化 profile（首层
# dsh-base），pnpm 从 GitHub 拉取本仓库并追加为 bundle 层。
# 仓库已提交预构建 lib/，无需构建授权、无需 prepare 脚本。
# 用法：sh install.sh [profile-name]   （默认 dsh-openviking）
set -eu

PROFILE="${1:-dsh-openviking}"

if ! command -v dsh >/dev/null 2>&1; then
  echo "未检测到 dsh CLI。先安装官方客户端：" >&2
  echo "  npm install -g @deepseek-ai/dsh" >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "未检测到 pnpm。dsh plugin 把安装转发给 pnpm，请先安装：" >&2
  echo "  npm install -g pnpm   （或启用 corepack：corepack enable pnpm）" >&2
  exit 1
fi

dsh plugin --profile "$PROFILE" add github:Rxiain/dsh-openviking
echo
echo "安装完成。启动：dsh --profile $PROFILE"
echo "配置（endpoint/apiKey/account/user 等）在 \$DSH_HOME/profiles/$PROFILE/cordis.patch.yml 中按 id: openviking 覆盖。"
