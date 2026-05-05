# UltraRelay-AAStar Operations Runbook

## 0 · 适用范围

M1 阶段 OP-Sepolia / OP-Mainnet prod 部署。M2 / M3 上线时本手册扩展。

本文是给运维 / DevOps 看的"上线必读"，列出 prod 部署的关键约束、部署清单、月度上游同步流程、故障排查手册和版本回滚策略。配套 `docs/M1_DESIGN.md`（产品设计）+ `docs/UPSTREAM_SYNC.md`（同步细则）+ `docs/UPSTREAM_PR_QUEUE.md`（待提上游 PR）一同阅读。

---

## 1 · 必配项（不配会出事）

### 1.1 --chain-type op-stack
- **必须配置** for OP-Sepolia (chainId 11155420) 和 OP-Mainnet (chainId 10)
- **不配的后果**：preVerificationGas 严重低估（不计 L1 数据费），UserOp 上链 OOG，executor wallet 烧空 gas 但 op 失败
- **来源**：dispatch 由运维显式配置 `--chain-type` 决定（`src/cli/config/options.ts:471-484`），bundler **不会**按 chainId 自动选 manager
- **验证方式**：启动后查 logs 确认 `chainType: op-stack` 输出；提交一笔 UserOp，对比 estimateGas 给出的 preVerificationGas 与链上实际消耗（误差应 < 5%）

### 1.2 IP allowlist (--rate-limit-allowlist)
- **必须配置** prod 环境
- **列出允许调用 bundler 的 IP**：AAStar 自己的 SDK 服务器、内部后端、监控系统
- **不配的后果**：任何外部 IP 都能调 `eth_sendUserOperation` with `maxFeePerGas == 0` 触发 bundler 垫付 ETH（详见 M1 §5.5 Known Limitation 2 — `eth_sendUserOperation` 接到零 fee 时自动升级为 boost 模式，由 utility wallet 垫付）
- **配置方式**：CLI `--rate-limit-allowlist "1.2.3.4,5.6.7.8"`，或 rate-limit config 文件中的 `allowlist` 数组
- **验证方式**：从 allowlist 之外的 IP 发 200 req/min，确认前 N 通过、剩下被 429；从 allowlist IP 不被限

### 1.3 BETTER_STACK_TOKEN 环境变量（如需 JSON 日志）
- 详见 M1 §5.5 Known Limitation 1
- **不配的后果**：`--json true` 退化为 pino-pretty 彩色输出，日志聚合 filter 困难
- **临时绕过**：`BETTER_STACK_TOKEN=dummy`（注意这会让 pino 尝试连 Better Stack endpoint 失败，但 stdout JSON 部分会工作）

### 1.4 utility wallet 余额监控
- bundler 启动配 `--min-balance`（建议至少够 100 笔 boost op 的总 gas）
- 余额低于阈值时 `utilityWalletMonitor` 在日志告警；M3 加 webhook（Slack / Discord）
- **余额耗尽 = bundler 立刻停摆**（boost 路径无 utility ETH 即无法发 handleOps tx）

---

## 2 · 部署清单（prod 上线前）

### 2.1 环境变量
- `BETTER_STACK_TOKEN`（如需 JSON 日志，详见 §1.3；未配置时 logger 退化到 pino-pretty）
- 其他根据部署平台需要的环境变量（k8s secret、ECR auth、Redis auth 等）

### 2.2 CLI flags 必备组合（OP-Mainnet 启动示例）

```bash
node ./lib/cli/alto.js \
  --network op \
  --rpc-url "https://opt-mainnet.g.alchemy.com/v2/YOUR_KEY" \
  --rpc-basic-auth-username "your_user" \
  --rpc-basic-auth-password "your_pass" \
  --entrypoints "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789,0x0000000071727De22E5E9d8BAf0edAc6f37da032" \
  --executor-private-keys "0x...,0x...,0x..." \
  --utility-private-key "0x..." \
  --chain-type op-stack \
  --safe-mode true \
  --bundle-mode auto \
  --max-bundle-count 8 \
  --min-balance 100000000000000000 \
  --rate-limit-enabled true \
  --rate-limit-max 100 \
  --rate-limit-window-ms 60000 \
  --rate-limit-allowlist "10.0.1.5,10.0.1.6" \
  --enable-horizontal-scaling true \
  --redis-endpoint "redis://your-redis-host:6379" \
  --json true \
  --log-level info \
  --port 3000
```

注意点：
- `--chain-type op-stack` 不能省（详见 §1.1）
- `--rate-limit-allowlist` 必须填实际的 SDK / 后端 IP（详见 §1.2）
- `--executor-private-keys` 多个用逗号分隔，建议 3-5 个并发 executor
- `--utility-private-key` 单个，需保持余额（详见 §1.4）
- 横向扩展用 Redis 时 `--enable-horizontal-scaling true` + `--redis-endpoint` 必须同时配

### 2.3 RPC provider
- **必须支持** `debug_traceCall`（safe-mode 必备；不支持则 spec-tests 不过）
- **推荐** OP-Mainnet 用付费 provider（Alchemy / QuickNode / Infura）。免费 endpoint quota 太低，bundler 灰度期就会撞限
- 配 basic auth 见 M1 §3.3 — 通过 `--rpc-basic-auth-username` + `--rpc-basic-auth-password` 两个 flag 显式传递；同一组 credentials 会同时应用到 public client 和 wallet client
- **caveat**：`--send-transaction-rpc-url` 与 main `--rpc-url` 共用同一组 basic auth credentials，无独立 auth 支持

### 2.4 健康检查
- `GET /health` 接 LB / k8s liveness probe（200 = bundler 进程存活，不保证 RPC 后端可用）
- `GET /metrics` 接 Prometheus scrape（M3 加 dashboard）
- `GET /wallets` 返回 `{ wallets: [executor 地址数组], chainId }`，可用于运维快速查 executor 钱包余额

---

## 3 · 月度上游同步流程

详细步骤见 `docs/UPSTREAM_SYNC.md`，本节列流程要点：

1. **fetch upstream**
   ```bash
   git fetch upstream
   git log --oneline aastar-dev..upstream/main  # 看上游有什么新东西
   ```

2. **检查 docs/UPSTREAM_PR_QUEUE.md**
   - 我们之前提给 ZeroDev 的 PR 是否已被上游 merge
   - 若已 merge → 在 sync 时移除我们 fork 的等价改动（避免重复 patch）
   - 若未 merge → 维持 fork 本地改动，下个月再查

3. **merge upstream/main 到 main → PR 到 aastar-dev**
   ```bash
   git checkout main
   git merge upstream/main      # 推到 origin/main 保持镜像
   git checkout aastar-dev
   git merge main               # 处理冲突，参考 docs/FORK_DELTA.md 判断哪些必须保留
   ```

4. **跑测试**
   - `pnpm test` (e2e)
   - `pnpm run test:spec`（eth-infinitism bundler-spec-tests）
   - 跑通才能 push

5. **部署灰度**
   - OP-Sepolia 灰度 24h，监控错误率、bundle 提交率、wallet 余额
   - 24h 稳定后再上 OP-Mainnet
   - 先 1% canary 流量，观察 1h 后 100%

---

## 4 · 常见故障排查

### 4.1 "submitted UserOp reverted onchain"
- 检查 `--chain-type op-stack` 是否配（见 §1.1，最常见原因）
- 检查 utility / executor wallet 余额（见 §1.4）
- 看 drop 日志里的 `reason` 字段（M1 §5.5 Known Limitation 5：`sender` / `paymaster` / `factory` 嵌在 stringified userOp 里，需 grep 字符串）
- 看链上 tx 的 revert reason；hex revert reason 解码由 ZeroDev 上游已支持

### 4.2 bundler 不出 bundle
- 检查 `--bundle-mode` 是 `auto` 不是 `manual`（manual 模式必须显式调 `debug_bundler_sendBundleNow`）
- 检查 mempool 是否真有 op：`debug_bundler_dumpMempool`（dev/staging 可用，prod 关闭）
- 检查 executor wallet 是否被 throttled：`debug_bundler_dumpReputation`
- 检查 `--max-bundle-count` 配置（注意 M1 §5.5 Known Limitation 3：该 flag 实际限制 `getBundles()` 循环产出的 bundle 数量，不是单 bundle 内 op 数）

### 4.3 JSON 日志不工作
- 见 M1 §5.5 Known Limitation 1
- 临时方案：设 `BETTER_STACK_TOKEN=dummy` 让 logger 走 JSON 分支
- 或：让日志聚合系统直接解析 pino-pretty 的 stdout 文本（多数 aggregator 支持，效率略低）

### 4.4 utility wallet 烧 gas 但 op 失败
- 通常是 §4.1 的下游表现
- 先确认 `--chain-type` 配对，再看 simulation vs onchain 的差异
- ZeroDev 上游 PR #2 / PR #11 已移除非必要的 sender balance override（M1 §2.2），降低假阳性。若仍出现，需排查具体 op 的 paymaster / factory 行为

### 4.5 RPC 限流（429 from upstream provider）
- bundler 自身的 fastify rate-limit 见 M1 §4.1
- upstream provider quota 用满需联系 provider 升档，或 reduce 自身的 polling interval
- 配多个 RPC URL 做 fallback（viem `fallback` transport，bundler 已支持 `--send-transaction-rpc-url`）

---

## 5 · 版本与回滚

### 5.1 版本标签
- bundler image 标签建议格式 `aastar-x.y.z`（区别于上游 zerodevapp/ultra-relay 的版本号，避免混淆）
- 每次发布在 git 打 tag：`git tag aastar-1.0.0 && git push origin aastar-1.0.0`
- 在 `docs/FORK_DELTA.md` 记录该版本包含的 fork-specific 改动

### 5.2 prod 灰度策略
1. OP-Sepolia 部署 → 24h 稳定运行 + 100+ 笔 op
2. OP-Mainnet 1% canary（用 LB 切流量比例）→ 1h 观察
3. OP-Mainnet 50% → 1h 观察
4. OP-Mainnet 100%

### 5.3 回滚流程
- 上一版 image 替换（k8s rollout undo / docker tag 切换）
- **Redis state 兼容性**：M1 schema 稳定，回滚不破数据。M2 / M3 加字段时需评估迁移（字段加了不破，删字段需脚本清理）
- 回滚后立刻在 `docs/UPSTREAM_PR_QUEUE.md` 加一条 incident 记录，分析根因

### 5.4 紧急停摆
- 如发现严重 bug（如 utility wallet 被恶意流量烧空、bundler 接错版本 op）：
  1. 先把 LB 流量切到维护页 / 503
  2. 再调查 + 回滚 + 修复
  3. 修复后从 OP-Sepolia 灰度走一遍再上 OP-Mainnet
- 不要"在线热修"，prod 修代码不走灰度 = 二次事故

---

## 6 · 相关文档

- `docs/M1_DESIGN.md` — M1 产品设计 + Known Limitations
- `docs/UPSTREAM_SYNC.md` — 月度上游同步详细步骤
- `docs/UPSTREAM_PR_QUEUE.md` — 待提给 zerodevapp/ultra-relay 的 PR 队列
- `docs/FORK_DELTA.md` — fork-specific 改动注册表
- `docs/CHAIN_CONFIG.md` — 每条目标链的推荐配置矩阵
- `docs/M1_ACCEPTANCE.md` — M1 验收检查表
