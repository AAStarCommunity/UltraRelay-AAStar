# Upstream PR Queue (zerodevapp/ultra-relay)

> 本文件跟踪 AAStar fork 发现的、应当回馈给上游 ZeroDev / ultra-relay 的修复。
> 月度上游同步时检查这里的 PR 是否已被上游 merge。已 merge 则在 sync 时移除我们 fork 的本地等价改动（避免双 patch）。

---

## 待 review

### PR #1 — chore: remove debug log and clarify max-bundle-count description
- **Status**: 已提交，等待 review — **https://github.com/zerodevapp/ultra-relay/pull/27**
- **Branch**: `AAStarCommunity:upstream-pr/cleanup-debug-and-cli-description` → `zerodevapp:ultra-relay:main`
- **Files**:
  - `src/rpc/methods/eth_sendUserOperation.ts:225` — 删除 `console.log("=== eth_sendUserOperation called ===")`（commit 702f9af 引入的 debug 残留）
  - `src/cli/config/options.ts:103-108` — `--max-bundle-count` description 修正为 "Maximum number of bundles produced per getBundles iteration (NOT per-bundle op count)"
- **Why upstream**: 两处都是 ZeroDev fork 自带，提到 ZeroDev 让所有下游 fork 受益（不只 AAStar）
- **Risk**: 极低（一行 description + 删一行 console.log）
- **Local note**: AAStar fork 的 `m1/acceptance-and-planning` branch 已包含等价改动；如 PR #27 被 merge，月度 sync 时上游 patch 会覆盖本地（无操作需要）；如被拒，转入下文 "已被上游拒绝" 段维护本地 patch

---

## 未来 PR（推到 M3 一并提）

### Pending — refactor: structured drop logging
- **来源**: M1 §5.5 Known Limitation 5 + M3 监控成熟需求
- **修改**: `src/mempool/mempool.ts` 的 `dropUserOps` 方法，把 `sender` / `paymaster` / `factory` 提到 pino log 顶级 key（当前嵌在 stringified userOp 里，filter 困难）
- **预计触发**: M3 配 Loki / Grafana 时
- **Why upstream**: 任何接日志聚合的 ZeroDev 用户都会撞上这个问题

### Pending — feat: --allow-implicit-boost flag
- **来源**: M1 §5.5 Known Limitation 2 + M3 X402 启动需求
- **修改**: `src/rpc/methods/eth_sendUserOperation.ts:230-236` 的 boost 自动升级逻辑加 flag 控制（默认保持现行为以兼容 ZeroDev 当前用户）
- **预计触发**: M3 X402 启动时（届时必须能关掉隐式垫付，由 X402 收费决定是否走 boost 路径）
- **Why upstream**: ZeroDev 的产品定位是 "relayer-without-paymaster" + 入口 API key 鉴权，他们自己的部署不需要这个 flag。但任何想"按调用方分级"的 fork（包括我们）需要这个开关
- **风险点**: ZeroDev 可能拒绝（认为该行为是产品定位）。如被拒，我们在本仓库长期维护此 patch 并在 docs/FORK_DELTA.md 记录决策

### Pending — fix: JSON logging without Better Stack
- **来源**: M1 §5.5 Known Limitation 1
- **修改**: `src/utils/logger.ts` 的 `initProductionLogger`，无 `BETTER_STACK_TOKEN` 时也能输出 JSON 到 stdout（当前会 fallback 到 pino-pretty）
- **预计触发**: M3 监控成熟时（如生产用 Loki 而非 Better Stack）
- **Why upstream**: Better Stack 不是 universal 选择，多数生产环境用 Loki / CloudWatch / Datadog，这个 fallback 让所有用户受益
- **背景**: 上游 `520f27a` (#18) + `0993646` (#19) 已加 logtail transport 异常处理 + dead transport noop，但 fallback 逻辑未改——这条 limitation 仍适用

### Pending — fix: --json with formatter on Better Stack branch
- **来源**: M1 §5.5 Known Limitation 1（sub-issue）
- **修改**: `src/utils/logger.ts` Better Stack 分支也应用 customSerializer（BigInt → hex）。当前只有 pino-pretty 分支处理 BigInt
- **预计触发**: 同上（一并提）
- **Why upstream**: Better Stack branch 收到 BigInt 会 JSON.stringify 报错，是上游真 bug

---

## 已 merge（历史）

（空，待第一个 PR 进入此节）

---

## 流程

1. **fix branch 在本地完成**：在 AAStarCommunity/UltraRelay-AAStar 上开 branch（如 `fix/xxx`），完成 + 本地 e2e 通过 → push 到 origin
2. **在 zerodevapp/ultra-relay 上发起 PR**：
   - head = `AAStarCommunity:UltraRelay-AAStar:fix/xxx`
   - base = `zerodevapp:ultra-relay:main`
3. **PR description 必须包含**：
   - 发现于哪个 commit / 复现路径
   - 修复方式（diff 摘要）
   - 为何上游也应该接收（不只是我们 fork 的特殊需求）
   - 测试覆盖（unit / e2e）
4. **tag** @doug 或当前的 ZeroDev maintainer
5. **等待 review**：
   - 通过 → 等 merge，merge 后从本节 "待提" 移到 "已 merge"，下次月度同步时确认上游 patch 已覆盖我们 fork 的等价改动
   - 拒绝（如 ZeroDev 有意保留行为，例如隐式 boost 升级）→ 在本仓库的 `docs/FORK_DELTA.md` 文档化决策（我们自己长期维护此 patch，靠其他机制解决业务问题，如 IP allowlist + rate limit）
6. **每月例行**：在 `docs/RUNBOOK.md` §3 上游同步流程时检查本文件，确认状态

---

## 相关文档

- `docs/M1_DESIGN.md` — Known Limitations 来源
- `docs/UPSTREAM_SYNC.md` — 上游同步详细步骤
- `docs/RUNBOOK.md` §3 — 月度上游同步流程在运营手册中的位置
- `docs/FORK_DELTA.md` — fork-specific 改动注册表（当 PR 被上游拒绝时，记录为长期 fork-only 改动）
