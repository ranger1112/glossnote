# 安全策略

## 支持范围

| 版本 | 是否接收安全修复 |
| --- | --- |
| 0.1.x | 是 |
| 更早版本 | 否 |

## 报告漏洞

请通过 GitHub 的 [私下漏洞报告](https://github.com/ranger1112/glossnote/security/advisories/new) 提交，不要开公开 Issue。

报告里请包含：影响版本、复现方式、可能的后果。如果涉及用户数据，请只描述结构，不要附带真实的文档或密钥。

## 关注范围

- 本地文件读写与路径拼接（书库目录、sidecar、封面）。
- Tauri command 的输入校验（文档 id、路径、导入文件大小）。
- CSP 与 asset protocol 的暴露面。
- AI 请求中的密钥处理与发送内容边界。
- 依赖漏洞（Dependabot 会定期提交更新）。

## 不在范围内

- 安装包未签名导致的 SmartScreen 提示（已知限制）。
- 用户自行把书库放在不可信云盘后产生的文件篡改。
- 用户主动分享出去的 sidecar 或导出文件中的内容。

## 设计边界

应用默认不联网、无遥测。API Key 明文保存在本机 `%APPDATA%\com.phoebe.glossnote\settings.json`，不会写入书库或 sidecar；日志与错误信息不记录 Key，也不记录正文。
