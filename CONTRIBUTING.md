# 开发与发布规范（Contributing）

## 分支模型

```
main      稳定发布线：每个提交都对应一个可用版本，受分支保护（禁 force-push、禁删除）
develop   集成分支：日常开发与功能合入都在这里，稳定后合入 main 并发版
feature/* 短生命周期功能分支（可选）：大改动从 develop 拉出，完成后合回 develop
```

- **main 上的每个提交都应可直接发布**。不确定能否发布的改动留在 develop。
- 发版时：develop 稳定 → 合入 main → 打 `vX.Y.Z` tag → CI（`.github/workflows/release.yml`）自动构建并发布安装包。

## 提交信息（Conventional Commits）

```
<type>(<scope>): <一句话摘要，现在时>

<可选的正文：动机与影响面>
```

常用 type：`feat`（新功能）、`fix`（修 bug）、`docs`、`refactor`、`test`、`build`、`chore`。
一个提交只做一件事；提交前跑 `wails3 task precommit`，门禁红则不提交。

## 版本号（SemVer）

- `0.x` 阶段：minor（`0.3.0`）= 新功能波次，patch（`0.2.1`）= 纯修复
- 预发布：`0.3.0-beta.N`，正式发布去掉后缀
- `1.0.0` 的门槛：签名问题解决、数据/配置格式冻结、经过一轮长期真实使用

## 发版流程

```bash
# 1. 在 develop 上确认门禁全绿
wails3 task precommit

# 2. 合入 main 并打 tag（CI 自动构建发布）
git checkout main
git merge develop
git tag -a vX.Y.Z -m "Kafka Explorer X.Y.Z"
git push origin main vX.Y.Z

# 3. 回到 develop 继续开发
git checkout develop
```

CI 会在 windows runner 上构建单文件安装器并发布到 GitHub Release（含
`.sha256` 校验文件，应用内自动更新会验证）。

## 注意事项

- Windows 下通过 REST API 推送时用 `scripts/api_push.mjs`（本机网络对
  git-over-HTTPS 有干扰时使用；SSH 推送不受影响，优先走 SSH）
- 更新源 `RELEASE_REPO` 已在 Taskfile 默认指向本仓库，发版无需手动传
