# 人类斜杠命令: `/memlearn`

插件仅在 DSH 提供 `commands` capability 时注册该命令。命令输入不会重复写入会话日志；命令使用 `recordInput: false`。

## `/memlearn <lesson>`

把一条用户撰写的经验交给共享 LearnService，保持原有脱敏、查重、限制、持久化和取消行为。

```text
Usage: /memlearn <lesson>
/memlearn The deployment requires a fake server before lifecycle tests
```

空输入只返回 usage，不调用 OpenViking，也不启动模型回合。命令不会 steer、send 或 followup agent。

## 兼容性

没有 `commands` capability 时命令不注册，模型工具、自动召回、会话捕获和自动提交行为保持不变。