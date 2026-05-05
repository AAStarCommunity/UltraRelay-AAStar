# UltraRelay-AAStar · M1 产品设计

> **里程碑定位**：把本仓库交付为一个**完整、合规、可生产**的标准 ERC-4337 bundler，部署在 OP-Sepolia + OP-Mainnet。M1 之后才进入 M2（绿色通道）和 M3（X402 / 监控 / 上游自动化）。
>
> **不在 M1**：trusted-paymaster 白名单、xPNTs 收费、X402、监控告警 webhook、RPC 缓存、上游同步自动化、postOp gas 精算。
>
> **当前状态**：bundler 大部分协议能力继承自 ZeroDev fork of Pimlico Alto，已覆盖大半。M1 的工作主要是 (a) 确保所有继承能力在 OP-Sepolia/OP-Mainnet 实测通过；(b) 把 #12-#15 四个 AAStar 增量补完 e2e；(c) 加 HTTP rate limit；(d) 把上游同步治理的轨道铺好。

---

## 0 · M1 验收顺序

1. 部分 1（协议核心能力）—— 写测试覆盖矩阵，测一遍，签字
2. 部分 2（ZeroDev 上游修改）—— 理解清楚为什么保留，写 e2e 防止误删
3. 部分 3（AAStar fork 增量）—— 现有 PR 的 e2e 补齐，运维文档化
4. 部分 4（M1 新加）—— rate limit + 上游同步治理
5. 部分 5（部署运维）—— OP-Sepolia 灰度 → OP-Mainnet 上线

---

## 部分 1 · 协议核心能力（继承，需验收）

> 这些能力由 Alto/ZeroDev 已经实现。**M1 工作 = 写测试 + 实测，不需要写新代码**。每条配上"如何验证"。

### 1.1 ERC-4337 多版本支持（v0.6 / v0.7 / v0.8）

- **业务价值**：不同钱包/SDK 用不同 EntryPoint。AirAccount v7 用的是 v0.7，其他生态合作方可能还在 v0.6。bundler 必须三个版本都接得住，否则就把生态合作方挡在门外。
- **必要性**：标准 ERC-4337 bundler 的最低门槛。无此则不算合规 bundler。
- **流程**：bundler 启动时通过 `--entrypoints "0xv06,0xv07,0xv08"` 注册多个 EntryPoint 地址；每笔 UserOp 在 RPC 调用里携带 entryPoint 参数，bundler 按地址路由到对应版本的 handler。
- **技术方案**：
  - 已实现位置：`src/rpc/methods/*` 各方法内部按 `isVersion06 / isVersion07 / isVersion08` 分支；`src/rpc/validation/` 三个版本各有 `BundlerCollectorTracerV0X` 和 `TracerResultParserV0X`
  - 验收：e2e 在每个版本上跑：账户部署 → `eth_sendUserOperation` → 等收据 → `eth_getUserOperationReceipt`
  - **OP-Mainnet 主推 v0.7**（AirAccount v7 默认），v0.6/v0.8 保留兼容

### 1.2 标准 RPC 方法集

- **业务价值**：任何符合 ERC-4337 标准的 SDK / 钱包都能直接对接，无须为我们做特殊适配——这是"开放 bundler"业务诉求的协议基座。
- **必要性**：标准必备，缺一项就不能自称 ERC-4337 bundler。
- **流程**：客户端 POST 到 `/rpc` / `/:version/rpc` / `/`（`src/rpc/server.ts:128-130`）。
- **技术方案**：
  - 已实现：`eth_chainId` / `eth_supportedEntryPoints` / `eth_estimateUserOperationGas` / `eth_sendUserOperation` / `eth_getUserOperationByHash` / `eth_getUserOperationReceipt`
  - 注册位置：`src/rpc/methods/index.ts`
  - 验收：每个方法用 OP-Sepolia 跑 happy path + 至少 1 个 error path（如非法签名、余额不足）

### 1.3 Pimlico 扩展 RPC 方法集

- **业务价值**：Pimlico 扩展接口已被生态广泛使用（permissionless.js 等 SDK 默认调用），保留可让任何用 Pimlico SDK 的开发者无缝切到我们 bundler。
- **必要性**：保持 SDK 兼容性的"零摩擦切换"承诺。
- **流程**：客户端调 `pimlico_*` 方法，bundler 按 namespace 分发。
- **技术方案**：
  - 已实现：`pimlico_getUserOperationGasPrice`（按链/拥塞返回 slow/standard/fast）、`pimlico_getUserOperationStatus`、`pimlico_sendUserOperationNow`（同步等收据）、`pimlico_simulateAssetChange`
  - 验收：四个方法各跑一次，结果与 OP-Sepolia 上同等查询的实际值相符（例如 GasPrice 与链上 baseFee 一致）

### 1.4 Debug 接口（dev/staging 启用，prod 关闭）

- **业务价值**：本地开发、E2E 测试和 spec-tests 强依赖 debug 接口。bundler-spec-tests 用 `debug_bundler_setBundlingMode("manual")` + `debug_bundler_sendBundleNow` 来精确控制 bundle 时序。
- **必要性**：spec-tests 通过的硬性前置条件。
- **流程**：通过 `--environment development` 或 `--safe-mode` 配置启用；prod 默认关闭。
- **技术方案**：
  - 已实现：`debug_bundler_clearState / clearReputation / dumpMempool / dumpReputation / setReputation / sendBundleNow / setBundlingMode / getStakeStatus`
  - 验收：`pnpm run test:spec` 全套 eth-infinitism bundler-spec-tests 通过

### 1.5 Bundling 模式（auto / manual）

- **业务价值**：生产用 auto；spec-tests 和压力测试用 manual。可切换是测试可重现性的前提。
- **必要性**：spec-tests 强依赖 manual 模式。
- **流程**：`--bundle-mode auto`（默认按时间/数量打包）或 `--bundle-mode manual`（仅 `debug_bundler_sendBundleNow` 触发）。
- **技术方案**：
  - 已实现：`src/executor/executorManager.ts` 的 bundling loop
  - 验收：在 manual 模式下提交 UserOp 不上链，调 `debug_bundler_sendBundleNow` 后才上链

### 1.6 Validation 模式（safe / unsafe，ERC-7562 tracer）

- **业务价值**：生产用 safe（启用 ERC-7562 tracer 拦截恶意 paymaster/factory）；本地开发或不支持 `debug_traceCall` 的 RPC 用 unsafe。
- **必要性**：safe 是生产合规要求；unsafe 是本地开发兜底。
- **流程**：`--safe-mode true`（默认）/ `--safe-mode false`。safe 模式下 bundler 对每笔 op 跑 `debug_traceCall` 抓取 opcode 和 storage 访问，按 `TracerResultParserV07.ts` 拒绝违规 op。
- **技术方案**：
  - 已实现：`src/rpc/validation/SafeValidator.ts` (safe) vs `UnsafeValidator.ts` (unsafe)
  - 验收：safe 模式下 spec-tests 全套通过；unsafe 模式下能在本地不支持 traceCall 的 anvil 上跑

### 1.7 Storage 后端（in-memory / Redis）

- **业务价值**：单机开发用 in-memory，零依赖；生产用 Redis 共享 mempool 状态，支持多 bundler 实例水平扩展和重启不丢 op。
- **必要性**：生产环境多实例 + 高可用要求。
- **流程**：默认 in-memory；配 `--enable-horizontal-scaling true` + `--redis-endpoint redis://...` 切到 Redis。可选附加配置：`--enable-redis-receipt-cache`、`--redis-key-prefix`（默认 `alto`）、`--redis-events-queue-endpoint` + `--redis-events-queue-name`（独立的 userOp 事件队列）。
- **技术方案**：
  - 已实现：编排入口 `src/store/createMempoolStore.ts:51-100` 按 `enableHorizontalScaling && redisEndpoint` 分支调用 `createRedisOutstandingQueue` / `createRedisStore`，否则调用 `createMemoryOutstandingQueue` / `createMemoryStore`（注意函数名是 `*OutstandingQueue` 不是 `*OutstandingStore`）
  - 验收：双后端各跑一次完整 e2e；Redis 后端额外测重启场景（kill bundler → 重启 → mempool 恢复）

### 1.8 Gas 处理器（M1 主推 EVM 默认 + Optimism）

- **业务价值**：OP-Mainnet 是 L2，gas 计算包含 L1 数据费。直接用 EVM 默认 oracle 会严重低估，导致 op 上链 OOG。`optimismManager` 把 L1 数据费纳入。
- **必要性**：上 OP-Mainnet 必备。
- **流程**：dispatch 由运维显式配置 `--chain-type` 决定（`src/cli/config/options.ts:471-484`，choices: `default | op-stack | arbitrum | hedera | mantle | abstract | etherlink`），**不是按 chainId 自动选**。OP-Sepolia / OP-Mainnet 必须显式 `--chain-type op-stack`。
- **技术方案**：
  - 已实现：L2-fee 分支位于 `src/utils/preVerificationGasCalulator.ts:360-377`（`switch (config.chainType)` → op-stack/arbitrum/mantle）、`src/executor/filterOpsAndEstimateGas.ts:62-102`、`src/executor/executor.ts:110,118`
  - M1 验收：OP-Sepolia + OP-Mainnet 跑通，对比同笔 op 的估算值与实际链上消耗，误差 < 5%
  - Arbitrum / Mantle handler 保留代码、不上线、不测试（保留是为了 merge 上游不破坏）
  - **如果运维忘配 `--chain-type op-stack`**：bundler 静默 fall back 到默认 oracle，preVerificationGas 严重低估（不计 L1 数据费）→ UserOp 上链 OOG，executor wallet 烧空 gas 但 op 失败。详见 `docs/RUNBOOK.md` §1.1

---

## 部分 2 · ZeroDev 上游核心修改（继承，理解为什么保留）

> 我们 fork 自 ZeroDev/ultra-relay 而不是直接从 Pimlico/alto，**就是为了拿这一组修改**。每条都要理解清楚，避免未来 merge 上游时被误删。

### 2.1 Boost endpoint：`boost_sendUserOperation`（relayer-without-paymaster）

- **业务价值**：传统 ERC-4337 流程要求 UserOp 要么自带 ETH 要么挂 paymaster。Boost endpoint 让 bundler 直接以"运营商身份"垫 ETH——这对"内部生态、bundler 是同一运营方"的场景天然契合：用户根本不需要 paymaster，bundler 用 utility wallet 出 ETH，对账在链下完成。
- **必要性**：这是 ZeroDev fork 区别于 Pimlico 主线的**核心增量**。AAStar 业务里"内部 SuperPaymaster + xPNTs UserOp"理论上可以走 boost 路径（不带 paymaster，直接由 bundler 垫付，xPNTs 在链下另算）——M2 的绿色通道实现可能复用这条通道，所以 M1 必须确保它工作。
- **流程**：
  1. 客户端调 `boost_sendUserOperation(userOp, entryPoint)`
  2. bundler 校验 `userOp.maxFeePerGas == 0` 且 `maxPriorityFeePerGas == 0`，且**不带任何 paymaster 字段**（v0.6 要求 `paymasterAndData == "0x"`；v0.7 要求所有 paymaster 字段为空）
  3. 校验通过 → bundler 按"自己出 gas"模式打包 → utility wallet 签 handleOps tx 上链
- **技术方案**：
  - 已实现：`src/rpc/methods/boost_sendUserOperation.ts:9-39` 校验函数；`addToMempoolIfValid({ ..., boost: true })` 走 boost 分支
  - 验收：在 OP-Sepolia 提交一笔零 fee、零 paymaster 的 UserOp，确认上链且 utility wallet 余额减少
  - **保留 PR #11 的修复**：boost 路径下 simulation 不要做 sender balance override（因为 sender 真没钱、是 bundler 在垫）

### 2.2 移除非必要的 sender balance override（PR #2、PR #11）

- **业务价值**：默认 simulation 会给 sender 和 paymaster 做 balance override（强行让模拟阶段余额够），这在某些场景（例如 boost、某些 L2 上的 verifying paymaster）会掩盖真实失败。ZeroDev 移除了不必要的 override，让 simulation 反映真实链上行为。
- **必要性**：避免"模拟通过、上链失败"的假阳性，减少 utility wallet 烧空 gas 的事故。
- **流程**：bundler simulation 阶段对 sender/paymaster 不做 balance override；只对 EntryPoint deposit 做必要 override。
- **技术方案**：
  - 已实现：`src/rpc/estimation/` 和 `src/rpc/validation/` 内 simulation 调用的 stateOverride 参数
  - 验收：boost 路径 e2e 已经覆盖（同 2.1）

### 2.3 结构化 JSON 日志（PR `feat: enable structured JSON logging in production builds`）

- **业务价值**：JSON 日志可以直接被 Loki / CloudWatch / Datadog 摄取，按 sender/paymaster/userOpHash 字段查询失败链路。文本日志在生产基本不可用。
- **必要性**：生产可观测性的最低基线。
- **流程**：bundler 启动时按 `NODE_ENV` / `--log-format json` 切换日志格式。Pino 自动按 level 输出。
- **技术方案**：
  - 已实现：Pino + 自定义 serializer（BigInt → hex），见 `src/utils/`
  - M1 验收：在 OP-Sepolia 部署后，日志能被 stdout 收集、JSON 行可被 jq 解析；hex revert reason 解码工作正常（PR `fix: decode hex-encoded revert reasons`）

### 2.4 `--max-bundle-count` 单 bundle op 数上限

- **业务价值**：单笔 handleOps tx 太大会触碰 block gas limit 导致整批 revert，损失全部 utility wallet gas。上限保护。
- **必要性**：生产稳定性。
- **流程**：bundler 在凑 bundle 时按 `maxBundleCount` 截断，剩余 op 留下次。
- **技术方案**：
  - 已实现：`src/cli/config/options.ts` 的 `--max-bundle-count` flag
  - M1 验收：默认值合理（建议 5-10），灰度跑通

### 2.5 详细日志 + UserOp drop 原因（PR `Add detailed logging for UserOp drops`）

- **业务价值**：op 被 drop 的理由（reputation、validation 失败、过期）必须能精确追踪到，否则 SDK 侧调试无从下手。
- **必要性**：开发者支持效率。
- **流程**：每次 drop 在日志里输出 `{ userOpHash, reason, paymaster, sender, code }`。
- **技术方案**：
  - 已实现：`src/mempool/mempool.ts` drop 路径上的 logger.warn 调用
  - M1 验收：人工触发几种 drop（reputation throttled、validation revert、过期）确认日志完整

---

## 部分 3 · AAStar fork 增量（PR #12-#15，已落地，需补 e2e + 文档）

### 3.1 PR #12 — `--block-tag-support` 控制 getLogs 调用

- **业务价值**：部分 L2 / Rollup（特别是新链）的 RPC 不支持 `eth_getLogs` 的 block tag（如 "latest"、"finalized"），只接受具体区块号。bundler 默认带 block tag 调用会在这种链上直接报错。这条 flag 让我们在不支持的链上自动 fallback 到 block 号方式。
- **必要性**：扩链能力——AAStar 想覆盖的链不止 OP，未来上 Linea / Scroll / 自家 Rollup 都可能撞上这个问题。
- **流程**：启动时配 `--block-tag-support true|false`（按链查"推荐配置矩阵"决定）。`true` 时用 block tag（节省一次 `eth_blockNumber`）；`false` 时先查 block number 再用具体数字调 getLogs。
- **技术方案**：
  - 已实现：`src/cli/config/options.ts` 加 flag；实际生效位置仅两处——`src/executor/bundleManager.ts:456`（getLogs）和 `src/rpc/methods/eth_getUserOperationByHash.ts:43`（getLogs）
  - **范围说明**：该 flag 语义只覆盖 `getLogs` 调用。OP-Sepolia / OP-Mainnet 都支持 block tag，业务不受影响。其他 RPC 调用（`getTransactionCount`、`getBalance` 等）在 `executor.ts` / `executorManager.ts` / `gasPriceManager.ts` / `rpcHandler.ts` / `utils.ts` 中仍硬编码 `blockTag: "latest"`。**如未来上链不支持 block tag 的链（如某些 alt-L2），需扩展到所有 RPC 调用——目前不在 M1 范围**
  - M1 验收：
    - 在 OP-Mainnet 配 `true` 跑通（OP 支持）
    - 在某条不支持的链（如本地 anvil 模拟拒绝 block tag）配 `false` 跑通
    - 文档化：`docs/CHAIN_CONFIG.md`（M1 一并产出）列每条目标链的推荐值

### 3.2 PR #13 — `authorizationList` in estimateGas（EIP-7702 路径）

- **业务价值**：EIP-7702 让 EOA 可以临时挂 smart wallet 代码（`SET_CODE_TX_TYPE = 0x04`），是 AirAccount/账户抽象演进的下一站。bundler 在 estimateGas 阶段需要把 UserOp 里的 `authorizationList` 一并塞给 underlying RPC，否则 estimate 不准确（gas 算少了上链 OOG）。
- **必要性**：AirAccount 团队规划中的 EIP-7702 升级路径要求 bundler 支持。M1 至少把通路打通，实战验收推到 M3。
- **流程**：UserOp 携带 `authorizationList` → bundler `eth_estimateUserOperationGas` 内部调 `eth_estimateGas` 时透传该字段 → 仅当 `--rpc-gas-estimate` 模式启用时生效。
- **技术方案**：
  - 已实现：`src/rpc/estimation/` 估算路径
  - M1 验收：单元测试覆盖即可，e2e 推到 M3

### 3.3 PR #14 — RPC basic auth 支持

- **业务价值**：很多 RPC provider（Alchemy / QuickNode / 自建 Geth）支持 basic auth 隔离 endpoint。bundler 同时维护 public client（读链）和 wallet client（发 tx），都要能配 basic auth。
- **必要性**：上线 OP-Mainnet 用付费 RPC provider 时必须。
- **流程**：通过两个独立 CLI flag 显式配置——`--rpc-basic-auth-username <user>` + `--rpc-basic-auth-password <pass>`（`src/cli/config/options.ts:584-593`）。bundler 在 `customTransport` 内构造 `Authorization: Basic <base64(user:pass)>` header（`src/cli/customTransport.ts:18-41`），注入 viem 的 transport fetch options。
- **技术方案**：
  - 已实现：`src/cli/customTransport.ts:18-41` 的 `getRpcFetchOptions`；同一组 credentials 在 `src/cli/handler.ts:124-198` 同时应用到 public client 和 wallet client
  - **caveat**：`--send-transaction-rpc-url` 与 main `--rpc-url` 共用同一组 basic auth credentials，**无独立 auth 支持**。如需 send-tx RPC 用不同 credentials，当前架构需改造（M2/M3 评估）
  - M1 验收：用一个真实带 basic auth 的 OP-Mainnet RPC 配置跑通；对比明文 URL 配置确认行为一致

### 3.4 PR #15 — `/wallets` HTTP 端点

- **业务价值**：运营方需要快速查到 bundler 当前在用的 executor 钱包地址列表（监控余额、做 dashboard、上链查询 nonce）。从配置文件 grep 不可靠（多实例、私钥派生不同地址）。HTTP 端点是单一真相源。
- **必要性**：运维可观测性的最小集——比 Prometheus 指标更直接，DevOps 一条 curl 就能查。
- **流程**：`GET /wallets` → 返回 `{ wallets: ["0x...", ...], chainId: <number> }`（`src/rpc/server.ts:179-196`）。**当前实现仅返回 executor 地址列表 + chainId，不包含 utility wallet**。
- **技术方案**：
  - 已实现：`src/rpc/server.ts:179-196` 的 `getWallets` handler
  - **未来扩展**：如运维需要监控 utility wallet 余额，可在该端点扩展返回 `utility` 字段（M2/M3 范围）
  - M1 验收：部署后 curl 能拿到正确地址；对比 chain explorer 上 executor 钱包发出的 tx，地址匹配

---

## 部分 4 · M1 新加 feature

### 4.1 HTTP rate limit（按 IP）

- **业务价值**：bundler 是公网开放服务（生态内任何 SDK 都能调）。没有限流时一个 buggy 客户端或恶意脚本能瞬间把 bundler 的 RPC quota 烧干、把 mempool 灌满。
- **必要性**：上 OP-Mainnet 公网部署的最低安全门槛。**M1 不加，后面任何 DDoS 都需要紧急修。**
- **流程**：
  1. bundler 启动时读 `--rate-limit-*` 一组参数（或 config 文件）
  2. Fastify 注册 `@fastify/rate-limit` 插件，按 IP 限流
  3. 超限请求返回 HTTP 429 + `Retry-After` header
  4. 白名单 IP（运营方自己的 SDK 服务器、监控系统）通过配置免限流
- **技术方案**：
  - 依赖：`@fastify/rate-limit` (已有 Fastify 生态官方插件)
  - 实现位置：`src/rpc/server.ts` 的 setupServer 阶段，注册插件
  - 配置项（CLI flag + config 文件双通道，按 ZeroDev 已有的 CLI 风格扩展）：
    - `--rate-limit-enabled true|false`（默认 true）
    - `--rate-limit-max 100`（每窗口最大请求数）
    - `--rate-limit-window-ms 60000`（窗口长度，默认 1 分钟）
    - `--rate-limit-allowlist "1.2.3.4,5.6.7.8"`（豁免 IP 列表）
    - `--rate-limit-config-file ./rate-limit.json`（高级配置文件，按 method 分别限流，可选）
  - **可配置文件**示例（用户要求）：
    ```json
    {
      "global": { "max": 100, "windowMs": 60000 },
      "perMethod": {
        "eth_sendUserOperation": { "max": 30, "windowMs": 60000 },
        "boost_sendUserOperation": { "max": 30, "windowMs": 60000 },
        "eth_estimateUserOperationGas": { "max": 60, "windowMs": 60000 }
      },
      "allowlist": ["1.2.3.4"]
    }
    ```
  - M1 验收：
    - 单元测试：超限返回 429
    - 灰度测试：用 `wrk` 或 `k6` 打 200 req/min，确认前 100 通过、剩下被 429
    - 配置 allowlist：白名单 IP 不被限

### 4.2 上游同步治理

- **业务价值**：业务目标 1 是"持续跟住 ZeroDev 上游"。当前 git 没配 upstream remote，过去 PR #5 是手动 cherry-pick，没有可重复流程，长期会越漂越远。
- **必要性**：fork 治理基线——没这个就没法保证我们继承上游 bug fix 和新 feature。
- **流程**：
  1. **一次性配置**：`git remote add upstream git@github.com:zerodevapp/ultra-relay.git`
  2. **每月例行**（手动，自动化推到 M3）：
     a. `git fetch upstream`
     b. `git checkout main && git merge upstream/main` → 推到我们的 `main` 分支（保持镜像）
     c. 在 `main` 上开 PR 把 `aastar-dev` rebase/merge `main`，处理冲突
     d. CI 跑通后 merge 到 `aastar-dev`
  3. **冲突处理依据**：CLAUDE.md 已有"AAStar additions"清单（CLAUDE.md:14-15），冲突时按清单判断哪些是"我们的"必须保留
  4. **fork-specific 改动注册表**（M1 产出 `docs/FORK_DELTA.md`）：每条增量列 `PR # | 文件 | 语义 | 上线日期`
- **技术方案**：
  - 文档化：`docs/UPSTREAM_SYNC.md` 描述步骤
  - `docs/FORK_DELTA.md` 维护增量清单（M2/M3 任何新增都更新这里）
  - **不写代码**——纯流程
  - M1 验收：跑一次完整流程（即便上游没新东西，也走一遍 fetch + diff + 文档更新）

---

## 部分 5 · 部署与运维（已存在但需验收）

### 5.1 `/health` 健康检查端点

- **业务价值**：负载均衡器 / k8s liveness probe / 监控系统都靠这个判断 bundler 是否存活。
- **必要性**：生产部署必备。
- **流程**：`GET /health` → 200 OK + JSON `{ status: "ok" }` 或类似。
- **技术方案**：
  - 已实现：`src/rpc/server.ts:155`
  - M1 验收：部署后 curl 200；kill underlying RPC 后端确认是否要返回 503（取决于现有实现，验收时确认行为）
  - **不改代码**，只验收

### 5.2 `/metrics` Prometheus 端点

- **业务价值**：所有指标（mempool size、bundle 提交速率、failure rate、wallet balance）都通过这里被 Prometheus 抓取。
- **必要性**：生产可观测性。
- **流程**：`GET /metrics` → Prometheus exposition format。
- **技术方案**：
  - 已实现：`src/rpc/server.ts:156`
  - M1 验收：部署后 curl 拿到指标列表；用 prom2json 验证格式合规
  - **不改代码**，只验收。配 Prometheus scrape + Grafana dashboard 推到 M3

### 5.3 `utilityWalletMonitor` 余额监控

- **业务价值**：utility wallet 出 boost 路径 ETH，executor wallet 出常规 handleOps gas。任何一个余额耗尽 bundler 立刻停摆。
- **必要性**：生产稳定性的最低保障。
- **流程**：bundler 内部周期检查 utility wallet 余额，低于 `--min-balance` 在日志告警。
- **技术方案**：
  - 已实现：`src/executor/utilityWalletMonitor.ts`
  - M1 验收：`--min-balance` 配一个高于实际余额的值，确认日志告警
  - 告警 webhook（Slack / Discord）推到 M3

### 5.4 Docker 部署

- **业务价值**：生产环境一键部署，环境一致性。
- **必要性**：上线 OP-Mainnet 必备。
- **流程**：`docker build -f Dockerfile -t ultra-relay-aastar .` → 推 ECR → 跑容器。
- **技术方案**：
  - 已实现：根目录 `Dockerfile`、`.dockerignore`
  - PR #6（`Add CI to build and push to ECR`）已合，需要在 M1 验收 ECR 推送是否真的工作
  - M1 验收：CI 推一次镜像；从 ECR 拉镜像在 OP-Sepolia 跑通

---

## 5.5 Known Limitations（M1 不修，文档化）

### Limitation 1: JSON logging fallback
- **现象**：`--json true` 在未配置 `BETTER_STACK_TOKEN` 环境变量时，fallback 到 pino-pretty 彩色输出，并非 JSON 格式
- **来源**：上游 ZeroDev fork 自带（`src/utils/logger.ts:100-107`）
- **业务影响**：若需把日志摄入 Loki / CloudWatch / Datadog，必须配置 `BETTER_STACK_TOKEN`（即便不真用 Better Stack，也要设一个），或日志聚合系统直接解析 pino-pretty 的 stdout 文本（多数 aggregator 支持）
- **M1 处理**：不修代码（最小化原则）。M3 配 Loki / Grafana 时若证明真有问题，再 fork branch 修并提 PR 给 zerodevapp/ultra-relay
- **临时绕过**：在容器/服务环境变量加 `BETTER_STACK_TOKEN=dummy`（注意这会让 pino 试图连真的 Better Stack endpoint 失败，但 stdout 部分会工作。或者部署期日志走 stderr 由 sidecar 拦截）

### Limitation 2: eth_sendUserOperation 隐式 boost 升级
- **现象**：`eth_sendUserOperation` 接到 `maxFeePerGas == 0 && maxPriorityFeePerGas == 0` 的 op 时，自动升级为 boost 模式（bundler utility wallet 垫付 ETH），不需要客户端显式调 `boost_sendUserOperation`
- **来源**：上游 ZeroDev fork 设计（`src/rpc/methods/eth_sendUserOperation.ts:230-236`）
- **业务定位**：ZeroDev 的产品定位是 "relayer-without-paymaster"，bundler 默认承担垫付，他们的安全前提是 HTTP 入口已有 API key 鉴权
- **我们的安全前提**：M1 §4.1 加的 HTTP rate limit + IP allowlist 是入口防线。**prod 部署时必须配 IP allowlist 只允许 AAStar 自己的 SDK 服务器/后端 IP**（详见 `docs/RUNBOOK.md`），否则任何外部 IP 都能让 bundler 垫付 gas
- **阶段处理**：M1 / M2 不修代码（行为合理）。M3 启动 X402 收费时必须加 `--allow-implicit-boost false` flag 切换语义——届时这条限制升级为阻塞器并修复

### Limitation 3: --max-bundle-count 描述误导
- **现象**：CLI flag 描述说 "Maximum number of UserOperations to include in a bundle"，实际行为是限制单次 `getBundles()` 循环产出的 bundle 数量（**非单 bundle 内 op 数**）
- **来源**：上游 ZeroDev fork（`src/cli/config/options.ts:103-108`，实际行为 `src/mempool/mempool.ts:725-773`）
- **业务影响**：运维按字面理解配置可能与预期不符
- **处理**：通过 `fix/cleanup-debug-and-cli-description` 分支改 CLI description（一行），同步给 zerodevapp/ultra-relay 提 PR（详见 `docs/UPSTREAM_PR_QUEUE.md`）

### Limitation 4: --block-tag-support 范围
（同 §3.1 已加说明，此处只引用）该 flag 仅影响 `getLogs` 调用；其他 RPC 调用仍硬编码 `blockTag: "latest"`。

### Limitation 5: Drop 日志结构化字段
- **现象**：UserOp drop 日志中 `sender` / `paymaster` / `factory` 嵌在 stringified userOp 里，不是顶级 JSON key
- **来源**：上游 ZeroDev fork（`src/mempool/mempool.ts:155-180`）
- **业务影响**：M1 不影响（pino-pretty 肉眼可读）；M3 配日志聚合时 filter 困难
- **处理**：M3 监控成熟时一并修，给 zerodevapp/ultra-relay 提 PR

---

## 6 · 验收检查表（最终签字依据）

| # | Feature | 类型 | 验收方式 | 状态 |
|---|---------|------|---------|------|
| 1.1 | EntryPoint v0.6/v0.7/v0.8 | 协议 | 三版本各一笔 e2e on OP-Sepolia | ☐ |
| 1.2 | 标准 RPC 6 个方法 | 协议 | 每方法 happy + 1 error path | ☐ |
| 1.3 | Pimlico 扩展 4 个方法 | 协议 | 每方法实测 OP-Sepolia | ☐ |
| 1.4 | Debug 接口 | 协议 | `pnpm run test:spec` 全过 | ☐ |
| 1.5 | Bundling 模式 auto/manual | 协议 | manual 模式下 sendBundleNow 才上链 | ☐ |
| 1.6 | Validation safe/unsafe | 协议 | safe 模式 spec-tests 全过；unsafe 在 anvil 跑通 | ☐ |
| 1.7 | Storage in-memory + Redis | 协议 | 双后端各 e2e；Redis 重启场景 | ☐ |
| 1.8 | OP gas oracle | 协议 | OP-Sepolia + OP-Mainnet 估算误差 < 5% | ☐ |
| 2.1 | Boost endpoint | ZeroDev | OP-Sepolia 零 fee 零 paymaster e2e | ☐ |
| 2.2 | Sender balance override 移除 | ZeroDev | 同 2.1 覆盖 | ☐ |
| 2.3 | JSON 日志 | ZeroDev | jq 可解析 + revert reason 解码 | ☐ |
| 2.4 | maxBundleCount | ZeroDev | 配置生效，灰度跑通 | ☐ |
| 2.5 | UserOp drop 详细日志 | ZeroDev | 触发 3 种 drop 看日志 | ☐ |
| 3.1 | block-tag-support | AAStar | OP-Mainnet 跑通 + chain config 文档 | ☐ |
| 3.2 | EIP-7702 estimateGas | AAStar | 单元测试覆盖 | ☐ |
| 3.3 | RPC basic auth | AAStar | 真带 basic auth 的 RPC 跑通 | ☐ |
| 3.4 | /wallets 端点 | AAStar | curl 返回正确地址 | ☐ |
| 4.1 | HTTP rate limit | M1 新加 | 429 测试 + allowlist 测试 | ☐ |
| 4.2 | 上游同步治理 | M1 新加 | UPSTREAM_SYNC.md + FORK_DELTA.md + 跑一次流程 | ☐ |
| 5.1 | /health | 运维 | curl 200 | ☐ |
| 5.2 | /metrics | 运维 | prom2json 验证 | ☐ |
| 5.3 | utilityWalletMonitor | 运维 | 触发余额告警日志 | ☐ |
| 5.4 | Docker 部署 | 运维 | ECR 推 + 拉镜像跑通 | ☐ |
| J | OP-Sepolia 部署灰度 | 部署 | 24h 稳定运行 + 100+ 笔 op | ☐ |
| K | OP-Mainnet 部署上线 | 部署 | 灰度 N 笔标准 SuperPaymaster + xPNTs UserOp | ☐ |

---

## 7 · M1 输出物清单

代码改动：
- `src/rpc/server.ts` — 注册 `@fastify/rate-limit` 插件
- `src/cli/config/options.ts` — 加 `--rate-limit-*` 系列 flag
- `package.json` — 加 `@fastify/rate-limit` 依赖

文档（新增）：
- `docs/M1_DESIGN.md` — 本文件
- `docs/UPSTREAM_SYNC.md` — 上游同步流程
- `docs/FORK_DELTA.md` — fork-specific 改动注册表
- `docs/CHAIN_CONFIG.md` — 每条目标链的推荐配置（block-tag-support、gas oracle 等）
- `docs/M1_ACCEPTANCE.md` — 验收检查表（同 §6，独立成文便于打钩归档）
- `docs/RUNBOOK.md` — 运营手册：M1 prod 部署的必配项、部署清单、月度上游同步、常见故障排查、版本与回滚
- `docs/UPSTREAM_PR_QUEUE.md` — 跟踪需要给 zerodevapp/ultra-relay 提的 PR 队列

不动：
- `src/rpc/methods/*` — 无新方法
- `src/mempool/*` — reputationManager 已合规
- `src/rpc/validation/*` — 不放宽任何规则
- 任何合约 — bundler 不出合约改动

---

## 8 · M1 → M2 切换条件

M1 §6 验收表全部打钩 + OP-Mainnet 稳定运行 1 周后，启动 M2（绿色通道 / trusted-paymasters）。

M2 设计文档在 M1 验收完成后写。
