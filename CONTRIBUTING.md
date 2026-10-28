# 参与贡献

## 先读这些

- [docs/product-design.md](docs/product-design.md)：产品边界与非目标。
- [docs/architecture.md](docs/architecture.md)：数据模型、锚定与同步协议。
- [docs/build.md](docs/build.md)：本机工具链、运行与验证方式。

## 报告问题

用 [Issue 模板](https://github.com/ranger1112/glossnote/issues/new/choose) 提交，尽量包含：

- 系统版本与应用版本（书库页或安装包文件名里的版本）。
- 复现步骤、期望结果、实际结果。
- 相关日志或截图；涉及标注时说明 PDF 是否为扫描件。

**不要**粘贴 API Key、私人文档正文或书库路径中的用户名。安全问题按 [SECURITY.md](SECURITY.md) 私下报告。

## 开发流程

```bash
npm install
npm run desktop:dev   # Tauri 桌面应用
npm test              # 前端单元测试
npm run build         # 类型检查 + 生产构建
```

Rust 侧在 `src-tauri/`：

```bash
cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

`scripts/` 下是作者本机的工具链包装脚本，不是跨机器约定；普通环境直接用上面的 npm / cargo 命令即可。

## 代码约定

- **数据不丢是第一位**：sidecar 是真相源，SQLite 是可重建的索引。改持久化逻辑时，先确认删库后能从书库重建。
- **锚点是准不可变的**：新增字段要能容忍旧 sidecar 缺省值；不要改变已有字段的含义。
- **不引入网络默认行为**：除用户主动触发的 AI 请求外，应用不联网；不加入遥测。
- **密钥不落书库**：API Key 只能写应用数据目录的 `settings.json`，不能进 sidecar、日志或测试数据。
- **文档跟着代码走**：行为变化时同步更新 `docs/`，不写尚未验证的结论。
- **提交前**：`npm test`、`npm run build`、`cargo test`、`cargo clippy --all-targets -- -D warnings` 全部通过。

## 提交信息

沿用现有风格：`feat:` / `fix:` / `docs:` / `refactor:` / `perf:` / `ci:` / `chore:`，后面用一句中文说明做了什么。一个提交只做一件事，确实需要拆开时在正文里写清原因。

## PR

- 说明动机、改动范围和验证方式。
- 涉及界面变化时附截图或录屏。
- 涉及数据格式时说明向前/向后兼容策略。
- PR 模板里的检查项请如实勾选。

## 发布

维护者按以下顺序发布：

1. 同步 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 的版本号（三处必须一致）。
2. 在 `CHANGELOG.md` 顶部加对应版本段落；需要更贴用户的 Release 说明时，在 `.github/release-notes/vX.Y.Z.md` 另写一份（缺省使用 CHANGELOG）。
3. 提交后创建带注释的标签并推送：`git tag -a v0.1.0 -m "GlossNote 0.1.0" && git push origin v0.1.0`。
4. `Release` workflow 会在 windows-latest 上构建 NSIS 安装包、生成 `SHA256SUMS.txt` 并上传到对应 Release；失败时可在 Actions 里用 `workflow_dispatch` 填同一个标签重跑。

版本号遵循语义化版本；0.x 阶段不承诺数据格式稳定，但 sidecar 的旧字段必须继续可读。
