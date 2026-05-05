# UltraRelay-AAStar · 订阅与计费产品规划

> **文档类型**：产品规划（Product Planning），不是单一里程碑设计稿。
>
> **定位**：M1/M2/M3 已经定义"内部生态闭环 + 白名单 fast-lane + X402 一次性收费"三条 bundler-as-a-service 通道；本文档规划**面向外部用户**（不在 trusted-paymasters 名单里、也不愿走 X402 一次性付款的开发者 / 企业 / 个人）的**第四条通道**——**订阅式 / 配额式 / 合约结算式**计费体系。
>
> **解决问题**：M3 §A.1 的 X402 是 per-UserOp 一次性握手，对**频繁调用**的客户端来说握手开销大、报价波动不可预期、跨 op 状态难追踪。订阅模型把"一次性付款"换成"长期可预测计费 + 链上账户化"，且能与 SuperPaymaster v5 的 credit/agent 体系互通。
>
> **三层设计**（可独立、可组合）：
>   - **Layer 1：API key 鉴权**——HTTP 层 X-API-Key，bundler 运营方人工管控，企业 / 合作 SDK 第一站
>   - **Layer 2：链上订阅状态合约**——`SubscriptionManager.sol`，链上配额（quota）+ 订阅 tier，bundler 链下查询缓存
>   - **Layer 3：aPNTs 自动抵扣**——订阅费 / per-UserOp 费用从用户 aPNTs 余额扣，依赖 **AirAccount Session Key**（algId 0x08）授权 bundler 在限定 scope 内代签
>
> **不在本文档**：
>   - bundler 内置 paymaster 业务逻辑（永远由 SuperPaymaster 出，bundler 只读 / 只签 intent）
>   - 订阅价格的最终定价（由商务团队给）
>   - 跨链订阅互通的具体桥接路径（Phase 4 占位）
>   - SuperPaymaster v5 内部信用 / 角色 / agent 系统的合约改动（依赖 SP v5 已落地能力）
>
> **关键决策（已敲定，本文不再讨论备选）**：
>   1. SubscriptionManager **独立合约**部署在 bundler 自家仓库，不嵌入 SuperPaymaster
>   2. **复用 xPNTs 作为支付 token**（同 M3 §A.2），不引入新代币
>   3. **复用 AirAccount Session Key 协议**（algId 0x08）做 bundler 代签授权，不自创签名协议
>   4. Layer 1 / 2 / 3 是**正交的可组合层**，运营方按客户画像自由排列
>   5. 订阅与 trusted-paymasters fast-lane / X402 **可共存不互斥**——一笔 op 可能同时命中订阅配额（不收费）+ trusted-paymasters fast-lane（优先级）；命中规则见 §6
>
> **当前状态**：M1 已上线、M2 设计完成、M3 设计完成。本文档属于**M4 / 长期规划**，分四个 Phase 推进，每个 Phase 可独立验收上线。

---

## 0 · 文档定位 + 与 M1/M2/M3 关系图

### 0.1 与既有里程碑的关系

```
                     ┌─────────────────────────────────────────────────────┐
                     │  bundler 入口 (eth_sendUserOperation / boost_*)    │
                     └─────────────────────────────────────────────────────┘
                                            │
              ┌─────────────────────────────┼─────────────────────────────┐
              │                             │                             │
              ▼                             ▼                             ▼
     ┌────────────────┐           ┌────────────────┐           ┌────────────────┐
     │ M1 标准合规通道 │           │ M2 trusted-pm │           │ M3 X402 一次性  │
     │ (用户自付 gas)  │           │ fast-lane     │           │ 收费 + 监控运维 │
     └────────────────┘           └────────────────┘           └────────────────┘
              │                             │                             │
              │ 公网开放但限流              │ 白名单内免费             │ 非白名单付钱
              │ (M1 §4.1 rate limit)        │ (M2 §1)                  │ (M3 §A.1)
              │                             │                             │
              └─────────────────┬───────────┴─────────────────────────────┘
                                │
                                │ 都不解决：频繁调用、可预期月度计费
                                │
                                ▼
                     ┌─────────────────────────────────────┐
                     │ M4 / 长期：订阅与配额计费体系       │
                     │  Layer 1: API key 鉴权              │  ← 本文档
                     │  Layer 2: SubscriptionManager 合约  │
                     │  Layer 3: aPNTs 自动抵扣            │
                     │           (AirAccount Session Key)  │
                     └─────────────────────────────────────┘
```

### 0.2 差异化定位（与 fast-lane / X402 对比）

| 维度 | M2 trusted-pm fast-lane | M3 X402 一次性收费 | M4 订阅模型（本文）|
|------|----------------------|------------------|------------------|
| 目标用户 | AAStar 自家 / 合作伙伴的 SuperPaymaster 实例 | 偶发外部 UserOp / AI agent 单次调用 | 高频外部用户（企业 SDK / 个人 Pro） |
| 收费方式 | 不收费（运营方自付） | 一次性 HTTP 402 握手 + 单笔报价 | 月度 / 配额预存 + per-op 抵扣 |
| 计费单位 | N/A | 一次握手一次报价 | 订阅 tier (Free/Basic/Pro) + 余量 |
| 状态位置 | 链下白名单 | 链下账本 (Redis) | **链上 SubscriptionManager + 链下缓存** |
| 信任模型 | 运营方 KYC paymaster | 客户端预存 → bundler 信账本 | 链上订阅状态 = 单一真相源 |
| 报价稳定性 | 免费 | 每次握手报价（gas 波动） | tier 内固定 |
| 用户体验 | 完全无感 | 首笔握手有延迟 | 首次订阅一次设置后无感 |
| 资金流 | 运营方 → utility wallet | 客户预存 xPNTs/ETH → bundler 收款 | 用户 aPNTs / xPNTs → SubscriptionManager → bundler |

### 0.3 与 SuperPaymaster v5 的关系

SP v5 已经实现的部分（[INTERFACES.md](file:///Users/jason/Dev/Brood/orgs/aastar/INTERFACES.md#L51-L62)）：
- 角色体系：`registerRole / configureRole / hasRole / ROLE_*`（ANODE / DVT / KMS / Community / EndUser）
- 信用 / 债务：`recordDebt / repayDebt / clearPendingDebt / getCreditLimit / getDebt`
- Agent 注册：`registerAgent / revokeAgent / isRegisteredAgent / setAgentPolicies`
- SBT 声誉：`safeMint / burnSBT / getUserSBT / setReputation`
- 代币操作：`mint / burn / burnFromWithOpHash / faucet / transferAndCall`

**本文设计原则**：bundler 的订阅合约**不复制** SP v5 的角色 / Agent / SBT，而是**复用**——SubscriptionManager 在订阅资格检查时调用 `SP.hasRole(EndUser, user) || SP.isRegisteredAgent(user)` 作为门槛；支付 token 用现有 xPNTs（[xPNTsToken.sol:33](file:///Users/jason/Dev/aastar/SuperPaymaster/contracts/src/tokens/xPNTsToken.sol#L33)）；不在 SP 合约里新增任何状态。

详见 §8。

---

## 1 · 三层鉴权 / 计费机制总览

### 1.1 用户旅程图（外部用户从打开 SDK 到 op 上链）

```
[外部客户端]                                   [bundler]                                          [链上]
     │                                            │                                                  │
     │ ① POST /rpc + X-API-Key (可选)            │                                                  │
     ├───────────────────────────────────────────▶│                                                  │
     │                                            │                                                  │
     │                                            │ ② 鉴权前置（HTTP middleware）                    │
     │                                            │   ┌────────────────────────────────────┐         │
     │                                            │   │ Layer 1: API key check             │         │
     │                                            │   │  - 白名单：直通                    │         │
     │                                            │   │  - 限流：per-key rate limit        │         │
     │                                            │   │  - 黑名单：return 403              │         │
     │                                            │   └────────────────────────────────────┘         │
     │                                            │                                                  │
     │                                            │ ③ 命中规则判断 (RPC handler 入口)              │
     │                                            │   ┌────────────────────────────────────┐         │
     │                                            │   │ paymaster ∈ trusted-paymasters?    │         │
     │                                            │   │  → fast-lane (M2)，跳过订阅 + X402│         │
     │                                            │   │ 否则继续                          │         │
     │                                            │   └────────────────────────────────────┘         │
     │                                            │                                                  │
     │                                            │ ④ Layer 2: 查链上订阅状态                       │
     │                                            │   ┌────────────────────────────────────┐         │
     │                                            │   │ SubscriptionManager.getQuota(sender)│        │
     │                                            │   │  (链下缓存 5-30s TTL)              │         │ ◀── 链上读
     │                                            │   │  - quota > 0：扣本地 quota；       │         │
     │                                            │   │    若需要链上扣减，进 ⑤            │         │
     │                                            │   │  - quota = 0 + tier=Pro：进 ⑥    │         │
     │                                            │   │  - 无订阅：fallback X402 (M3)    │         │
     │                                            │   └────────────────────────────────────┘         │
     │                                            │                                                  │
     │                                            │ ⑤ Layer 3a: 订阅预付（per epoch）              │
     │                                            │   ┌────────────────────────────────────┐         │
     │                                            │   │ 用户已 deposit aPNTs 到 SM          │        │
     │                                            │   │ bundler 周期 settlement，本笔不扣  │         │
     │                                            │   └────────────────────────────────────┘         │
     │                                            │                                                  │
     │                                            │ ⑥ Layer 3b: per-UserOp 抵扣                    │
     │                                            │   ┌────────────────────────────────────┐         │
     │                                            │   │ bundler 持 user 的 SessionKey       │        │
     │                                            │   │ (algId 0x08, scope=SM.payFor)      │         │
     │                                            │   │ 用 SessionKey 签 intent UserOp     │         │ ──▶ 上链
     │                                            │   │ → SM.payFor(user, fee_aPNTs)       │         │
     │                                            │   └────────────────────────────────────┘         │
     │                                            │                                                  │
     │                                            │ ⑦ 标准 simulation + mempool + bundle           │
     │                                            ├──────────────────────────────────────────────────▶ 上链
     │                                            │                                                  │
     │ ⑧ userOpHash + 收据                        │                                                  │
     ◀────────────────────────────────────────────┤                                                  │
```

### 1.2 三层正交性

每一层可独立启用 / 关闭，bundler CLI 通过三组开关控制：
- `--api-key-auth-enabled true|false`
- `--subscription-manager-address 0x...`（不配 = Layer 2 关闭）
- `--apnts-deduct-enabled true|false`（依赖 Layer 2 + AirAccount session key 协议）

实际部署常见组合（详见 §6 矩阵）：
- **企业 SDK 集成**：Layer 1 only（API key 即足）
- **个人 Pro 订阅者**：Layer 2 + Layer 3a（链上订阅 + aPNTs 预付月费）
- **AI agent 高频调用**：Layer 1 + Layer 2 + Layer 3b（API key 限流 + 订阅 quota + 链上 per-op 扣）
- **一次性外部 op**：Layer 都不命中 → fallback 到 M3 X402

### 1.3 与既有 M2/M3 通道的优先级

bundler 入口处的命中顺序（从高到低）：
1. **trusted-paymasters fast-lane**（M2 §2.4 H1）—— 命中即免费走快通道
2. **订阅 quota 命中**（本文 Layer 2/3）—— 命中即用配额，不收 X402
3. **X402 收费**（M3 §A.1）—— 前两者都未命中
4. **API key 黑名单 / 限流耗尽** —— 直接 403/429

详见 §6.2 决策树。

---

## 2 · Layer 1 — API key 鉴权

### 2.1 业务价值

- **企业客户接入门槛**：合作 SDK / 企业开发者期望的不是"链上订阅 / aPNTs 钱包"，而是"给我一个 API key，我喂给我的 backend 服务"——这是 Web2 标准做法，AWS / Stripe / Anthropic 都这样
- **SLA 兑现的最小单元**：API key 是 bundler 与外部客户的 SLA 合同 ID。出问题时按 key 查日志、按 key 计费、按 key 限流
- **运营可控**：运营方人工签发 / 撤销 / 调整额度，不用走链上治理（链上治理 latency 太长，Web2 客户受不了）
- **迁移路径**：API key 客户后续可以选择"升级"到 Layer 2 / Layer 3，但 Layer 1 永远是最低门槛

### 2.2 必要性

- 公网开放后，纯 IP 限流（M1 §4.1）只能挡野生流量，无法精细化为不同付费等级客户
- 没有 key 就没有"客户身份"，所有 RPC 调用是匿名的，运营方无法追溯出问题的源头
- 链上订阅模型（Layer 2）从签 onchain tx 到生效有 10-60s 延迟（OP 链 finality），不能作为唯一鉴权
- 与 trusted-paymasters 白名单（M2）正交：白名单按 paymaster 地址（链上身份），API key 按 HTTP 调用方（客户身份）

### 2.3 流程

#### 2.3.1 Key 颁发

1. 运营方在内部 admin 系统（**M4 不做完整的 Web 控制台**，先用 CLI / SQL 直操作 Redis）执行：
   ```bash
   pnpm run admin:issue-key \
     --owner-name "AcmeCorp" \
     --tier enterprise \
     --rate-limit-per-min 1000 \
     --rate-limit-per-day 1000000 \
     --allowed-methods "eth_sendUserOperation,eth_estimateUserOperationGas" \
     --expires-at "2026-12-31T23:59:59Z"
   ```
2. 命令生成：
   - `key_id`：4 字符前缀（`acme`），便于日志辨识
   - `key_secret`：32 字节随机，base64url 编码
   - 完整 key：`url_aastar_<key_id>_<base64url(key_secret)>`（前缀 `url_aastar_` 便于 grep / 区分泄露的其他 service key）
   - 写入 Redis：`api_key:<sha256(full_key)>` → JSON 元数据
3. 运营方把 full key 一次性交付客户（与 Stripe `sk_live_...` 同模式），客户存自己 secret store

#### 2.3.2 客户端调用

```http
POST /rpc HTTP/1.1
Host: bundler.aastar.io
X-API-Key: url_aastar_acme_<base64url-secret>
Content-Type: application/json

{"jsonrpc":"2.0","method":"eth_sendUserOperation","params":[...]}
```

#### 2.3.3 bundler 鉴权

1. Fastify middleware（`onRequest` hook）取 `X-API-Key` header
2. 计算 `sha256(headerValue)` 查 Redis `api_key:<hash>`
3. 三种结果：
   - **命中且有效**：把 metadata（owner / tier / quotas）注入 `request.context`，下游 handler 能读
   - **命中但过期 / 黑名单**：返回 `403 Forbidden`，body `{"error":"key_revoked","reason":"..."}`
   - **未命中**：
     - 若 `--api-key-required true` → 返回 `401 Unauthorized`
     - 若 `--api-key-required false`（默认 false，兼容公开访问）→ 走匿名路径（受 §4 / §5 / M3 X402 约束）
4. 命中时立即做 per-key 限流：
   - 用 `@fastify/rate-limit` 的 `keyGenerator: req => req.context.apiKeyId`
   - 超限返回 `429 Too Many Requests` + `Retry-After`

#### 2.3.4 撤销与轮换

- **撤销**：管理员设 Redis key 的 `revoked: true` 字段，立刻生效（middleware 每次都查 Redis）
- **轮换**：管理员调 `pnpm run admin:rotate-key --key-id acme`，生成新 secret 同时把旧 secret 标 `grace_until: <ts>`（24h grace period），客户更新 SDK 后旧 key 自动失效
- **客户自助查询**：bundler 暴露 `GET /admin/api-keys/me` 端点（带自己的 key 调），返回当前 quota / 用量 / 过期时间（不返回 secret）

### 2.4 技术方案

#### 2.4.1 新增模块

```
src/auth/
├── apiKey.ts           # KeyManager：issue / revoke / rotate / lookup
├── apiKeyMiddleware.ts # Fastify hook
├── apiKeyAdmin.ts      # admin CLI 子命令
└── types.ts            # ApiKeyMetadata 类型
```

#### 2.4.2 关键类型

```ts
// src/auth/types.ts
export interface ApiKeyMetadata {
    keyId: string                  // 4 字符前缀，e.g. "acme"
    sha256: string                 // 索引用，base64url
    ownerName: string              // 客户名（运营内部）
    tier: "free" | "basic" | "pro" | "enterprise"
    rateLimitPerMin: number
    rateLimitPerDay: number
    allowedMethods: string[]       // 空数组 = 所有方法
    allowedChainIds: number[]      // 空数组 = 所有链
    issuedAt: number               // unix
    expiresAt: number              // unix; 0 = 永不过期
    revoked: boolean
    revokedAt?: number
    revokedReason?: string
    graceUntil?: number            // 轮换 grace period
    metadata?: Record<string, string>
}

export interface ApiKeyContext {
    apiKeyId: string               // 命中后的 keyId
    tier: ApiKeyMetadata["tier"]
    ownerName: string
}
```

#### 2.4.3 KeyManager 接口

```ts
// src/auth/apiKey.ts
export class ApiKeyManager {
    constructor(args: { redisClient: Redis | null; logger: Logger })

    async issue(args: Omit<ApiKeyMetadata, "sha256" | "issuedAt" | "revoked">): Promise<{
        fullKey: string
        metadata: ApiKeyMetadata
    }>

    async lookup(headerValue: string): Promise<ApiKeyMetadata | null>

    async revoke(keyId: string, reason: string): Promise<void>

    async rotate(keyId: string, graceSeconds: number): Promise<{ newFullKey: string }>

    async listKeys(filter?: { ownerName?: string; tier?: string }): Promise<ApiKeyMetadata[]>
}
```

存储后端：
- 主存储：Redis hash `api_key:<sha256>` → serialized JSON
- 反向索引：Redis set `api_key_owner:<ownerName>` → 一组 sha256
- 旋转期间：旧 sha256 仍可查到，但响应里 `metadata.graceUntil` 提示客户端切换

#### 2.4.4 Fastify middleware

```ts
// src/auth/apiKeyMiddleware.ts
export const apiKeyHook = (manager: ApiKeyManager, config: AuthConfig) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
        const headerValue = request.headers["x-api-key"]
        if (!headerValue || typeof headerValue !== "string") {
            if (config.apiKeyRequired) {
                return reply.code(401).send({ error: "api_key_missing" })
            }
            request.context = { ...request.context, apiKey: null }
            return
        }

        const meta = await manager.lookup(headerValue)
        if (!meta) {
            if (config.apiKeyRequired) {
                return reply.code(401).send({ error: "api_key_invalid" })
            }
            request.context = { ...request.context, apiKey: null }
            return
        }

        if (meta.revoked) {
            return reply.code(403).send({
                error: "api_key_revoked",
                reason: meta.revokedReason
            })
        }
        if (meta.expiresAt && meta.expiresAt < Date.now() / 1000) {
            return reply.code(403).send({ error: "api_key_expired" })
        }

        // method 白名单
        const body = request.body as { method?: string }
        if (
            meta.allowedMethods.length > 0 &&
            body.method &&
            !meta.allowedMethods.includes(body.method)
        ) {
            return reply.code(403).send({ error: "method_not_allowed_for_key" })
        }

        request.context = {
            ...request.context,
            apiKey: { apiKeyId: meta.keyId, tier: meta.tier, ownerName: meta.ownerName }
        }
    }
```

#### 2.4.5 CLI flags

- `--api-key-auth-enabled true|false`（默认 false）
- `--api-key-required true|false`（默认 false，启用 auth 但允许匿名走 X402）
- `--api-key-redis-prefix api_key`（与其他 namespace 隔离）
- `--api-key-grace-seconds 86400`（rotate 默认 24h grace）

#### 2.4.6 与 M1 §4.1 全局 IP rate-limit 的关系

- M1 的 `@fastify/rate-limit` 是 per-IP 全局限流，**先生效**
- API key per-key 限流是 **after** middleware 运行后再叠加（如同一 key 命中后再走自己的 quota）
- 两层串行：客户端必须既不被 IP 限流又不被 key 限流才能进入 RPC handler

#### 2.4.7 验收

- 单元测试：issue / lookup / revoke / rotate 全路径
- 集成测试：
  - 带正确 key 调 RPC → 200
  - 带过期 key → 403 + `api_key_expired`
  - 带轮换中的旧 key → 200 + 响应 header `Warning: api_key_rotating, switch by <date>`
  - 不带 key + `--api-key-required true` → 401
  - 不带 key + `--api-key-required false` → 走匿名路径
- 限流验证：1 个 key 配 60/min → 第 61 笔 429
- 撤销实时性：`revoke` 后 < 5 秒（受 Redis cache TTL）下一笔请求 403

---

## 3 · Layer 2 — 链上账户订阅

### 3.1 业务价值

- **链上订阅状态 = 单一真相源**：bundler 多实例（M3 §D.2）共享 Redis 也只是 cache，真相在合约里。任一实例宕机或 cache 失效，下次启动重新查链即可恢复
- **订阅可证明**：用户可以 `etherscan.io/address/<SubscriptionManager>#read` 直接看自己的订阅状态，不依赖 bundler 运营方诚信
- **可与 Agent / SBT 体系互通**：SubscriptionManager 检查 `SP.hasRole(EndUser, user)` 或 `SP.isRegisteredAgent(user)` 作为订阅资格门槛，复用 SP v5 现有的身份证书
- **跨 bundler 实例 / 跨运营方共享**：SubscriptionManager 不绑定特定 bundler 运营方——任何遵循同一合约接口的 bundler 都能查到用户订阅状态。**这是订阅模型相对 X402 的最大价值**：X402 账本是 bundler 私有 (M3 §A.1)，订阅是开放标准
- **跨链可移植**：每条链一份 SubscriptionManager 部署，未来可加 cross-chain message 把订阅在多链同步

### 3.2 必要性

- 链下记账（M3 §A.2 xPNTs ledger）的局限：
  - 用户只在 bundler 持有"虚拟余额"，bundler 跑路 = 余额没了
  - 用户换 bundler 服务商需要把余额提现再转，体验差
  - 用户无法证明自己"确实是 Pro 订阅者"（除非看 bundler 私有日志）
- API key（Layer 1）局限：
  - 无法做到"用户自助订阅"——必须运营方人工签发
  - 不能与链上身份（SBT / Agent NFT）绑定
- X402（M3 §A.1）局限：
  - 一次性付款 → 用户每个月签 N 次 op 就需要 N 次握手
  - 报价随 gas 波动，企业财务难做预算

### 3.3 流程

#### 3.3.1 用户首次订阅

1. 用户访问 bundler 运营方 dashboard（**Phase 2 不实现完整 UI**，可用 etherscan 直接交互）
2. 用户调 `SubscriptionManager.subscribe(tier, paymentToken, paymentAmount)`：
   - 选择 tier（Free / Basic / Pro）
   - 选择支付 token（默认 xPNTs，未来可加 USDC）
   - 提交对应 amount（提前 approve 或用 xPNTs 的 autoApprovedSpenders 机制）
3. 合约把 `paymentAmount` 从用户钱包转入 SM 账户
4. 合约写入 `subscriptions[user] = { tier, expiresAt: now + 30 days, remainingQuota: tier.monthlyQuota }`
5. emit `Subscribed(user, tier, expiresAt, remainingQuota)`

#### 3.3.2 bundler 查询订阅状态

1. 客户端发 `eth_sendUserOperation(userOp)`，bundler 提取 `userOp.sender`
2. bundler 先查 Redis cache `subscription:<user>` (TTL 30s)
3. miss → 调 `SubscriptionManager.getSubscription(user)` → 写回 cache
4. 三种结果：
   - **有效订阅 + quota > 0**：bundler 标 `metadata.subscriptionHit = true`，本笔不收 X402
   - **有效订阅 + quota = 0**：根据 tier 决定 fallback：
     - Free tier：拒绝（403 over_quota，提示升级）
     - Basic tier：fallback 到 X402（按笔付）
     - Pro tier：触发 Layer 3b auto-deduct（链上扣 aPNTs 充配额）
   - **无订阅 / 已过期**：fallback 到 X402（M3 §A.1）

#### 3.3.3 quota 消耗

- **方案 A（推荐）**：链下扣减 + 周期 settlement
  - bundler 在内存账本扣 `localQuota[user] -= 1`
  - 周期（每日 / 每千笔）批量调 `SubscriptionManager.consumeQuotaBatch(users[], counts[])` 上链同步
  - 优点：单 op 不发 tx，gas 成本接近 0
  - 缺点：bundler 宕机 / cache 丢失会导致超扣，需 settlement 时和链上 nonce 对账
- **方案 B**：每笔 op 发链上 consumeQuota tx
  - 优点：链上完全准确
  - 缺点：每笔 op 多一次 tx，与 Layer 3b 合并发 intent 可缓解
- **本文档默认方案 A**，方案 B 留给极端审计场景

#### 3.3.4 续订与取消

- **自动续订**：Pro tier 默认开自动续订，到期前 1 天 bundler 调 SM 触发 `autoRenew(user)` 从用户 aPNTs 扣下个月费用（依赖 Layer 3b session key）
- **手动续订**：用户重新调 `subscribe(tier, ...)`，合约延长 expiresAt
- **取消**：用户调 `cancelSubscription()`，合约把 `autoRenew=false`，剩余 quota 仍可用至 expiresAt

### 3.4 技术方案

#### 3.4.1 SubscriptionManager.sol 合约接口

```solidity
// contracts/SubscriptionManager.sol
pragma solidity ^0.8.20;

interface ISubscriptionManager {
    enum Tier { None, Free, Basic, Pro }

    struct Subscription {
        Tier tier;
        uint64 expiresAt;          // unix
        uint64 monthlyQuota;       // tier 配额，写入时定值
        uint64 remainingQuota;     // 链下消耗后周期同步
        uint64 lastSyncedAt;       // bundler 上次 consumeQuotaBatch 的 ts，便于审计
        address paymentToken;      // 用户选的支付 token (xPNTs)
        bool autoRenew;
    }

    struct TierConfig {
        uint64 monthlyQuota;
        uint128 priceInAPNTs;      // 月费，以 aPNTs 计价
        uint16 prioritySlot;       // mempool 优先级提示，bundler 可读
    }

    // ─── User-facing ───
    function subscribe(Tier tier, address paymentToken, uint256 amount) external;
    function cancelSubscription() external;
    function setAutoRenew(bool enabled) external;
    function getSubscription(address user) external view returns (Subscription memory);

    // ─── Bundler-facing ───
    /// Atomic check + decrement for single op (方案 B)
    function consumeQuota(address user, uint64 count) external;

    /// Batch settlement (方案 A)
    function consumeQuotaBatch(address[] calldata users, uint64[] calldata counts) external;

    /// 用户预付 aPNTs 触发 quota 充值（Layer 3a 调用）
    function topupAPNTs(address user, uint256 amount) external;

    /// Auto-renew 触发（bundler 用 session key 代签调）
    function payFor(address user) external returns (uint256 chargedAPNTs);

    // ─── Admin ───
    function setTierConfig(Tier tier, TierConfig calldata config) external;  // onlyOwner
    function setBundlerAllowlist(address bundler, bool allowed) external;   // onlyOwner
    function setSuperPaymaster(address sp) external;                          // onlyOwner

    // ─── Events ───
    event Subscribed(address indexed user, Tier tier, uint64 expiresAt, uint64 quota);
    event QuotaConsumed(address indexed user, uint64 count, uint64 remaining);
    event Cancelled(address indexed user);
    event AutoRenewed(address indexed user, uint256 chargedAPNTs, uint64 newExpiresAt);
}
```

#### 3.4.2 资格门槛（复用 SP v5 身份）

`subscribe()` 的实现里：

```solidity
function subscribe(Tier tier, address paymentToken, uint256 amount) external {
    // 复用 SP v5 的 dual-channel eligibility
    require(
        ISuperPaymaster(superPaymaster).isEligibleForSponsorship(msg.sender),
        "not eligible: need SBT or registered Agent"
    );
    // ... 其余订阅逻辑
}
```

参考 [SuperPaymaster.sol:752](file:///Users/jason/Dev/aastar/SuperPaymaster/contracts/src/paymasters/superpaymaster/v3/SuperPaymaster.sol#L752) 和 [行 1010-1012](file:///Users/jason/Dev/aastar/SuperPaymaster/contracts/src/paymasters/superpaymaster/v3/SuperPaymaster.sol#L1010)。

#### 3.4.3 默认 tier 配置（建议值，需商务确认）

| Tier | 月配额（笔） | 月费 | 备注 |
|------|------------|------|------|
| Free | 50 | 0 aPNTs | 必须有 SBT 或 Agent NFT；超量直接拒 |
| Basic | 500 | 50 aPNTs (≈ $1) | 超量 fallback X402 |
| Pro | 5000 | 300 aPNTs (≈ $6) | 超量自动用 session key 扣 aPNTs 续配额；含 mempool 优先级 |
| Enterprise | 不走链上订阅 | 走 Layer 1 API key + 商务合同 | |

#### 3.4.4 bundler 链下查询缓存策略

```ts
// src/subscription/subscriptionCache.ts
export class SubscriptionCache {
    private cache = new LRU<Address, { sub: Subscription; cachedAt: number }>({
        max: 100_000
    })

    constructor(
        private contract: ISubscriptionManager,
        private logger: Logger,
        private ttlMs = 30_000
    ) {}

    async get(user: Address): Promise<Subscription | null> {
        const hit = this.cache.get(user)
        if (hit && Date.now() - hit.cachedAt < this.ttlMs) return hit.sub

        const sub = await this.contract.getSubscription(user)
        if (sub.tier === Tier.None || sub.expiresAt < now()) {
            this.cache.set(user, { sub, cachedAt: Date.now() })
            return null
        }
        this.cache.set(user, { sub, cachedAt: Date.now() })
        return sub
    }

    /// 链下扣减
    consumeLocal(user: Address): boolean {
        const hit = this.cache.get(user)
        if (!hit || hit.sub.remainingQuota === 0) return false
        hit.sub.remainingQuota--
        return true
    }
}
```

cache invalidation：
- 监听 SM 事件 `Subscribed / QuotaConsumed / Cancelled / AutoRenewed`，命中即 `cache.delete(user)`
- TTL 30s 兜底（事件丢失场景）
- bundler 多实例共享 Redis cache 时用 Redis pub/sub 广播 invalidation

#### 3.4.5 周期 settlement

```ts
// src/subscription/settlement.ts
export class SubscriptionSettler {
    private pendingConsumption = new Map<Address, number>()

    record(user: Address): void {
        this.pendingConsumption.set(user, (this.pendingConsumption.get(user) ?? 0) + 1)
    }

    async settle(): Promise<void> {
        const batch = Array.from(this.pendingConsumption.entries())
        if (batch.length === 0) return

        const users = batch.map(([u]) => u)
        const counts = batch.map(([, c]) => BigInt(c))

        try {
            const txHash = await this.contract.consumeQuotaBatch(users, counts)
            this.logger.info({ txHash, count: batch.length }, "subscription settlement")
            this.pendingConsumption.clear()
        } catch (err) {
            this.logger.error({ err }, "settlement failed, retrying next interval")
        }
    }
}
```

settlement 频率：每 1 小时一次（CLI flag 可配 `--subscription-settlement-interval-seconds 3600`）。

#### 3.4.6 与 SP v5 信用系统对比

| 机制 | SP v5 信用（recordDebt / repayDebt） | SubscriptionManager |
|------|--------------------------------------|---------------------|
| 触发方 | postOp 阶段，paymaster 自己 | 用户主动订阅 |
| 计价单位 | xPNTs（按 op 实际 cost） | aPNTs（按月度 tier） |
| 用户感知 | 后付（debt 累加，下次 mint xPNTs 自动还） | 预付 |
| 适合场景 | 单笔 op 计费 | 长期订阅 |
| 关系 | **互补**：SP 处理"per-op 后付"；SM 处理"per-month 预付" | |

订阅期间 op 走 SuperPaymaster 时仍按 SP 自己的 paymaster 逻辑结算（postOp 扣 xPNTs）；订阅 quota 是**bundler 服务费**（不是 paymaster gas 费），两者计费维度不同。

### 3.5 验收

- 合约单测覆盖 subscribe / cancel / consumeQuota / autoRenew 全路径
- bundler 集成测试：
  - 用户订阅后 bundler 缓存命中
  - cache invalidation 事件正确处理
  - settlement 调用上链成功 + 链下账本与链上一致
- 资格门槛验证：非 SBT 持有者订阅失败
- 多实例一致性：3 bundler 实例并行扣同一 user，settlement 后链上 quota 减少正确

---

## 4 · Layer 3a — aPNTs 订阅预付（依赖 AirAccount Session Key）

### 4.1 业务价值

- **零摩擦续订**：用户订阅 Pro tier 后，每月不需要手动续费——bundler 在到期前一天用 session key 自动调 `SubscriptionManager.payFor(user)`，从用户 aPNTs 扣下月费
- **用户主权保留**：session key 是用户**主动签发**的（一次性 setup），随时可撤销；bundler 没有任意花用户钱的能力
- **预算可控**：session key 限定 scope（only `SubscriptionManager.payFor` 一个 selector）+ 限定 amount cap + 限定 TTL
- **与 SP v5 信用系统互补**：信用系统是"先消费后还债"，预付订阅是"先充值再消费"——同一用户可同时拥有

### 4.2 必要性

- 用户体验：纯链上订阅每月手动签 tx 续费 → 80% 用户会忘记 → 订阅模型崩溃
- 自动续订要求 bundler 有签 tx 的权力，但 bundler **不是用户钱包 owner** → 必须有"受限授权"机制
- AirAccount 已实现 SessionKey（algId 0x08，[SessionKeyValidator.sol](file:///Users/jason/Dev/aastar/airaccount-contract/src/validators/SessionKeyValidator.sol)）—— 直接复用，无需自创
- 区别于 Layer 3b：3a 是**月度大额一次性扣款**（订阅费），3b 是**per-op 小额连续扣款**（按笔付）；两者都用 session key 但 scope 配置不同

### 4.3 流程

#### 4.3.1 用户授权 session key（一次性）

1. 用户在 SDK / dashboard 中选择"启用自动续订"
2. SDK 生成或选择 bundler 的"hot wallet 地址"作为 sessionKey（bundler 公开自己的 hot wallet 地址供 SDK 查询）
3. SDK 构造 grant：
   - `account` = 用户 AirAccount 地址
   - `sessionKey` = bundler hot wallet 地址
   - `expiry` = `now + 7 days`（受 [SessionKeyValidator.sol:38](file:///Users/jason/Dev/aastar/airaccount-contract/src/validators/SessionKeyValidator.sol#L38) `MAX_SESSION_DURATION` 限制）
   - `contractScope` = `SubscriptionManager.address`
   - `selectorScope` = `bytes4(keccak256("payFor(address)"))`
4. 用户用 owner key（passkey / TEE 签）签 grant hash（[L271-L292](file:///Users/jason/Dev/aastar/airaccount-contract/src/validators/SessionKeyValidator.sol#L271-L292)）
5. SDK 把签名发给 SessionKeyValidator：调 `grantSession(account, sessionKey, expiry, contractScope, selectorScope, ownerSig)`（[L111-L127](file:///Users/jason/Dev/aastar/airaccount-contract/src/validators/SessionKeyValidator.sol#L111-L127)）
6. 链上记录 session，emit `SessionGranted`（[L67-L73](file:///Users/jason/Dev/aastar/airaccount-contract/src/validators/SessionKeyValidator.sol#L67-L73)）
7. SDK 通知 bundler："你已被授权，下次续订请用此 session key"

> **session key 续期**：因 7 天上限，session 到期后 bundler 需要再次提示用户授权下一个 7 天窗口。订阅自动续订实际是"7 天内的某次扣款"，**不是 7 天扣一次**——bundler 每 30 天扣一次月费，但 session key 必须每 7 天 refresh 一次。运营方需在 SDK 里做"快到期 → 推送通知 → 用户一键 grant"流程。

#### 4.3.2 用户预付 aPNTs

1. 用户调 `SubscriptionManager.topupAPNTs(self, amount)`（如 1 年额度 = 12 × 月费）
2. SM 把 aPNTs 从用户钱包转入合约，记 `prepaidBalance[user] += amount`
3. emit `APNTsToppedUp(user, amount, newBalance)`

#### 4.3.3 bundler 自动续订

1. bundler 每天扫一次"24 小时内到期"的订阅（用 SM 的 `getExpiringSoon(within = 86400)` view，**M4 在合约里加一个分页 view**）
2. 对每个到期 user：
   - 检查 session key 是否仍有效（链上调 `SessionKeyValidator.isSessionActive(user, bundlerHotWallet)`）
   - 若有效：bundler 用 hot wallet 私钥签一笔 UserOp：
     ```
     sender   = user (AirAccount)
     callData = SubscriptionManager.payFor(user)
     signature = [account(20)][sessionKey(20)][ECDSASig(65)] = 105 bytes
                 (algId 0x08，dispatch by length，[SessionKeyValidator.sol:103])
     ```
   - bundler 把这笔 intent UserOp 提交给自己（自家 bundler，自家入口），打包上链
   - SM.payFor 内部从 `prepaidBalance[user]` 扣月费，延长订阅 30 天
3. 失败处理：
   - session key 失效 → 不扣，把 user 标 `pending_grant`，运营方通过 push 通知 user
   - prepaidBalance 不足 → 不扣，user 订阅自然到期 → fallback X402

### 4.4 技术方案

#### 4.4.1 新增模块

```
src/subscription/
├── sessionKeyClient.ts     # 与 SessionKeyValidator 交互：查 isSessionActive
├── intentBuilder.ts        # 构造 intent UserOp（用 algId 0x08 签名）
├── autoRenewWorker.ts      # 周期扫到期 + 触发续订
└── prepaidLedger.ts        # 链下镜像 SM.prepaidBalance（cache）
```

#### 4.4.2 IntentBuilder 关键代码

```ts
// src/subscription/intentBuilder.ts
import { encodePacked } from "viem"

export class IntentBuilder {
    constructor(private hotWalletAccount: PrivateKeyAccount) {}

    /// 构造 SubscriptionManager.payFor(user) 的 intent UserOp
    /// signature 布局必须匹配 SessionKeyValidator._validateECDSASession
    /// (引 SessionKeyValidator.sol:255-269)
    async buildPayForIntent(args: {
        userAccount: Address
        subscriptionManager: Address
        nonce: bigint
        gasLimits: GasLimits
        userOpHash: Hex
    }): Promise<PackedUserOperation> {
        const callData = encodeFunctionData({
            abi: SUBSCRIPTION_MANAGER_ABI,
            functionName: "payFor",
            args: [args.userAccount]
        })

        // ECDSA session signature: [account(20)][sessionKey(20)][ECDSASig(65)] = 105 bytes
        // (引 SessionKeyValidator.sol:97 注释 + L255-L269 验证逻辑)
        const ecdsaSig = await this.hotWalletAccount.signMessage({
            message: { raw: args.userOpHash }
        })

        const sessionSig = encodePacked(
            ["address", "address", "bytes"],
            [args.userAccount, this.hotWalletAccount.address, ecdsaSig]
        )

        return {
            sender: args.userAccount,
            nonce: args.nonce,
            callData,
            signature: sessionSig,
            // ... callGasLimit / verificationGasLimit / preVerificationGas 等
        }
    }
}
```

#### 4.4.3 AutoRenewWorker

```ts
// src/subscription/autoRenewWorker.ts
export class AutoRenewWorker {
    async run(): Promise<void> {
        const expiringSoon = await this.sm.getExpiringSoon(86400)
        for (const user of expiringSoon) {
            try {
                const sessionActive = await this.sessionKeyClient.isSessionActive(
                    user,
                    this.hotWallet.address
                )
                if (!sessionActive) {
                    await this.notifier.notifyGrantNeeded(user)
                    continue
                }

                const intent = await this.intentBuilder.buildPayForIntent({
                    userAccount: user,
                    subscriptionManager: this.sm.address,
                    nonce: await this.entryPoint.getNonce(user, 0n),
                    gasLimits: this.config.intentGasLimits,
                    userOpHash: /* compute */
                })

                await this.bundlerClient.sendUserOperation(intent)
                this.metrics.autoRenewSucceeded.inc()
            } catch (err) {
                this.metrics.autoRenewFailed.inc()
                this.logger.error({ err, user }, "auto-renew failed")
            }
        }
    }
}
```

#### 4.4.4 CLI flags

- `--subscription-manager-address 0x...`（必填）
- `--subscription-bundler-hot-wallet 0x...`（bundler 用作 sessionKey 的 hot wallet）
- `--subscription-auto-renew-enabled true|false`（默认 false，需要 hot wallet 配置完才开）
- `--subscription-auto-renew-interval-hours 24`
- `--subscription-auto-renew-look-ahead-seconds 86400`

### 4.5 验收

- 单测：buildPayForIntent 生成的 105 字节 sig 能被 SessionKeyValidator._validateECDSASession 通过
- e2e on OP-Sepolia：
  - 用户 grant session → bundler 触发 autoRenew → SM.payFor 上链成功 → 订阅延长
  - session 已 revoked → autoRenew 跳过 + 推送通知
  - prepaidBalance 不足 → autoRenew 不扣，订阅自然到期
- 安全测试：
  - 改 callData 为非 payFor selector → SessionKeyValidator validation 失败
  - 改 contractScope 为非 SubscriptionManager → AAStarAirAccountBase._enforceGuard 拒（运行时 scope 检查，注释见 [SessionKeyValidator.sol:21-23](file:///Users/jason/Dev/aastar/airaccount-contract/src/validators/SessionKeyValidator.sol#L21-L23)）

---

## 5 · Layer 3b — aPNTs 按 UserOp 计量（核心：AirAccount Session Key 集成）

### 5.1 业务价值

- **真正按用量付费**：用户不需要预付月费、不需要承诺月配额——每发一笔 op 扣相应 aPNTs，零浪费
- **AI agent 友好**：agent 调用频率剧烈波动（有时 0/天，有时 10K/天），订阅模型 / 月度配额都不合适；按 op 计量与 agent 的"思考一步行动一步"模式天然契合
- **与 X402 的价值差**：X402 每次 op 都要 HTTP 握手 → 报价 → 付款 → 重发，4 个 RTT；Layer 3b 一次 setup 后无握手，bundler 直接用 session key 在链上扣费
- **可编程额度**：scope 中可配 amount cap，用户给 agent 一个"每天最多扣 100 aPNTs"的预算，bundler 强制不超

### 5.2 必要性

- M3 §A.1 X402 的 4-step 握手对高频 agent 是巨大延迟（每笔 op +200ms，agent 跑 100 步就 +20s）
- 链下记账（M3 §A.2）需要用户对 bundler 信任："我充进去的钱不会被乱扣"——Layer 3b 把这个信任转嫁到链上 session key scope
- 与 Layer 3a 互补：3a 是按月一次大额，3b 是按 op 多次小额；不同用户画像选不同
- 这是订阅设计的**最复杂层**，但也是技术含金量最高的层——做对了 bundler 直接获得"代签 + 自动扣费"能力，是商业模式的护城河

### 5.3 流程

#### 5.3.1 用户授权 session key（与 4.3.1 类似但 scope 不同）

1. SDK 生成 grant：
   - `account` = user AirAccount
   - `sessionKey` = bundler hot wallet
   - `expiry` = `now + 7 days`（受 MAX_SESSION_DURATION 限制）
   - `contractScope` = `SubscriptionManager.address`（**或** xPNTs token，见下文方案）
   - `selectorScope` = 选其一：
     - **方案 X**：`SubscriptionManager.payFor(user)` —— 仍走 SM 中央扣账，bundler 每笔扣的金额由 SM tier 配置或 SM 内部 metering 决定
     - **方案 Y**：`xPNTsToken.transferFrom(user, bundler, amount)` —— 直接 ERC20 转账，bundler 自定 amount，金额受 xPNTs 防火墙 `MAX_SINGLE_TX_LIMIT = 5000 ether` 约束（[xPNTsToken.sol:76](file:///Users/jason/Dev/aastar/SuperPaymaster/contracts/src/tokens/xPNTsToken.sol#L76)）
2. 用户 owner 签 grantHash（同 4.3.1）
3. SDK 调 `grantSession(...)` 上链

> **方案 X vs Y 决策**（本文档默认推方案 X）：
> - **方案 X 优点**：所有计费逻辑在 SubscriptionManager 集中，bundler 只是触发器；金额由合约根据 op 复杂度动态算（SM 可读 op metadata）；tier 限制（如 Free user 不能用 3b）合约层强制
> - **方案 Y 优点**：直接 transferFrom，绕过 SM 中转；xPNTs 自带 firewall 保护（`to == msg.sender == bundler`，[xPNTsToken.sol:262-277](file:///Users/jason/Dev/aastar/SuperPaymaster/contracts/src/tokens/xPNTsToken.sol#L262-L277) 强制此规则）；不依赖 SM 部署
> - **决策**：M4 主推方案 X，方案 Y 留给 xPNTs 生态外的简化 fallback；SDK 默认配方案 X scope

#### 5.3.2 bundler 接收用户的 op 并自动扣费

1. 客户端发 `eth_sendUserOperation(originalUserOp)`，sender = user
2. bundler 鉴权 + 命中规则判断（§1.1 ② ③ ④）
3. 命中 Layer 3b（用户订阅 Pro tier，且开了 per-op metering）：
   - bundler 算本笔报价 `feeInAPNTs = pricing(originalUserOp)`（仿 M3 §A.1 pricing）
   - bundler 用 session key 构造 intent UserOp：
     ```
     sender   = user
     callData = SubscriptionManager.payFor(user)
                (SM 内部按当前时间戳 / op metadata 决定本次扣多少；
                 或 SM.chargeForOp(user, opHash, feeAPNTs)，bundler 显式传金额)
     signature = [account(20)][bundlerHotWallet(20)][ECDSASig(65)] = 105 bytes
     ```
   - bundler 把 intent UserOp 与 originalUserOp **打包成同一 bundle**（atomic 上链）
   - bundle 上链：
     - intent op 先执行 → SM.chargeForOp 扣 user aPNTs
     - originalUserOp 后执行 → 用户业务逻辑
   - 任一失败 → EntryPoint revert（atomicity 由 EntryPoint handleOps 多 op 处理保证）

#### 5.3.3 bundler 自治范围（持有 session key 后能做什么）

session key 让 bundler **对 user account 有有限代签权**，能做：
- 调 `SubscriptionManager.payFor(user)` —— allowed（contractScope + selectorScope 命中）
- 调 `SubscriptionManager.chargeForOp(user, opHash, amount)` —— **如果 selectorScope 配的是 chargeForOp**

**不能做**：
- 调 SM 的其他 selector（如 `subscribe / cancel`）—— `_enforceGuard` 拒（[SessionKeyValidator.sol:21-23](file:///Users/jason/Dev/aastar/airaccount-contract/src/validators/SessionKeyValidator.sol#L21-L23) 注释）
- 调 SM 之外的合约（如直接 transferFrom）—— 同上
- 超出 expiry 后任何调用 —— `_validateECDSASession` 拒（[L262](file:///Users/jason/Dev/aastar/airaccount-contract/src/validators/SessionKeyValidator.sol#L262)）
- 在 user `revokeSession` 后任何调用 —— `_validateECDSASession` 拒（[L261](file:///Users/jason/Dev/aastar/airaccount-contract/src/validators/SessionKeyValidator.sol#L261)）

#### 5.3.4 撤销路径

- **用户主动撤销**：用户在 dashboard 调 `SessionKeyValidator.revokeSession(account, sessionKey)`（[L146-L153](file:///Users/jason/Dev/aastar/airaccount-contract/src/validators/SessionKeyValidator.sol#L146-L153)）
- **过期自动失效**：7 天 TTL 到，session 自动无效
- **bundler 主动放弃**：bundler 通知 SDK，自己不再用此 sessionKey（不上链，链下行为）
- **运营方紧急撤销**（可选）：M4 不实现；若需要，未来可在 SubscriptionManager 加 `setEmergencyBlock(user)`，bundler 在每次 intent 前 check 一遍

### 5.4 技术方案

#### 5.4.1 SessionKey 签名布局（关键）

引 [SessionKeyValidator.sol](file:///Users/jason/Dev/aastar/airaccount-contract/src/validators/SessionKeyValidator.sol) 实际实现：

- **dispatcher**：`validate(userOpHash, signature)` 按 `signature.length` 分发（L99-L106）
  - **105 字节** → ECDSA session：`[account(20)][sessionKey(20)][ECDSASig(65)]`（L97 注释 + L255-L269 解析）
  - **148 字节** → P256 session：`[account(20)][keyX(32)][keyY(32)][r(32)][s(32)]`（L98 注释 + L319-L340 解析）
  - 其他长度 → 返回 `1`（验证失败）

> **注意**：原任务描述里说"106 字节带 algId(1)"——这与实际合约不符。**实际合约用 length-based dispatch 不是 algId 字节**。本文档以合约实现为准。algId 0x08 是该 validator 在 `AAStarValidator` 中的注册 id（L17 注释），不出现在 sig 字节流里。bundler 在构造 sig 时只需要打 105 字节 ECDSA payload，无需加 algId 前缀。

#### 5.4.2 bundler 端集成

```ts
// src/subscription/perOpDeducter.ts
export class PerOpDeducter {
    constructor(
        private hotWallet: PrivateKeyAccount,
        private sm: ISubscriptionManager,
        private sessionKeyClient: SessionKeyClient,
        private intentBuilder: IntentBuilder,
        private pricing: PricingEngine
    ) {}

    /// 在 mempool 入队前调用：构造 intent + 打包
    async maybeBuildDeductIntent(args: {
        originalUserOp: UserOperation
        userTier: Tier
    }): Promise<UserOperation | null> {
        if (args.userTier !== Tier.Pro) return null

        const user = args.originalUserOp.sender
        const sessionActive = await this.sessionKeyClient.isSessionActive(
            user,
            this.hotWallet.address
        )
        if (!sessionActive) return null

        const feeAPNTs = this.pricing.calculate(args.originalUserOp)

        return this.intentBuilder.buildChargeForOpIntent({
            userAccount: user,
            opHash: getUserOpHash(args.originalUserOp),
            amount: feeAPNTs,
            sessionKey: this.hotWallet
        })
    }
}
```

#### 5.4.3 mempool 改造（与 M2 H3 类似但语义不同）

- intent UserOp 与 originalUserOp 必须同 bundle，**且 intent 在前**
- 在 mempool entry 加 `metadata.linkedIntentOpHash` 字段，bundle 创建时强制把 linked pair 一起出队
- 若 intent 失败（gas / nonce / SM revert）→ originalUserOp 也撤回（不入 mempool 或 bundle 重组）

#### 5.4.4 风险分析

| 风险 | 影响 | 缓解 |
|------|------|------|
| bundler hot wallet 私钥泄露 | 攻击者可用所有授权过的 user session 任意调 SM.payFor/chargeForOp，扣空 user aPNTs prepaidBalance | (a) hot wallet 用 KMS / HSM 管理；(b) SM 加 per-tx 上限 + per-day 上限；(c) hot wallet 与 executor / utility wallet 隔离，盗一不影响其他；(d) 紧急时社区 owner 可暂停 SM 合约 |
| bundler 串改 callData | 攻击者改 intent callData 调 SM 之外的方法 | SessionKey scope 强制：contractScope 命中 + selectorScope 命中（在 AirAccount `_enforceGuard` 运行时检查），bundler 改了链上拒 |
| bundler 超额扣费 | 用户 aPNTs 一次性被扣空 | (a) SM.chargeForOp 内部加 max-per-call 上限（如 100 aPNTs / call）；(b) SM.chargeForOp 加 daily cap per-user；(c) 用户在 grant 时通过 SDK 指定 amount cap（M5 扩展，本文 M4 范围内不强制） |
| session key 被多 bundler 并发使用 | nonce 冲突 / replay | bundler 与用户 1:1 绑定（user 选一个 bundler 签 session key）；多 bundler 抢同一 user 时由 SDK 决定授权对象；bundler 之间不共享 hot wallet 私钥 |
| 用户在 bundler 处理 intent 时 revoke session | intent op 上链失败 → originalUserOp 也失败 | EntryPoint atomicity 保证；bundler 重新走 X402 或拒此笔 |
| SM 升级 / 改 selector | 老 session key contractScope/selectorScope 失效 | SM 不可升级（部署时 set immutable）；如必须升级用 proxy 升级前广播 → 用户 re-grant；selector 永远向后兼容 |
| AirAccount session 7 天上限 | 长期 agent 用户每周需要 re-grant | SDK 在 D-1 推 push notification；可选用 P256 session（148 字节，passkey 一键签）减少摩擦 |

### 5.5 验收

- 单测：buildChargeForOpIntent 生成的 105 字节 sig 通过 SessionKeyValidator
- 集成测试：
  - 正常路径：grant → originalUserOp → bundle 含 intent 上链 → SM.chargeForOp 扣 aPNTs
  - revoke 后：bundler 拒绝构造 intent → originalUserOp fallback X402 / 直接拒
  - intent 改 callData：链上 validation 失败（运行时 _enforceGuard 拒）
- 压力测试：100 user 并发 grant + 1000 op/s 持续 1 小时，无 nonce 冲突 / 无超扣
- 安全测试：故意泄露一个 hot wallet → 立即 SM admin 暂停该 hot wallet → 攻击窗口 < 5 分钟

---

## 6 · 三层组合策略

### 6.1 用户画像 × 层组合矩阵

| 用户画像 | API key (L1) | 链上订阅 (L2) | aPNTs 抵扣 (L3) | 备注 |
|---------|-------------|--------------|-----------------|------|
| 企业 SDK 集成（AAStar 自家 SDK 接入合作 partner） | ✅ Enterprise | ✗ | ✗ | 走 Layer 1 即足，商务合同结算，不上链 |
| 个人 Pro 订阅者（活跃个人开发者） | 可选 | ✅ Pro tier | ✅ 3a 自动续订 | 月费 + 大配额，超量 fallback X402 |
| AI agent 高频调用 | ✅ Basic+ | ✅ Pro tier | ✅ 3b per-op metering | API key 限流防过载，3b 按真实用量精确扣 |
| 个人 Free 用户（轻度玩家） | ✗ | ✅ Free tier (50/月) | ✗ | 资格门槛 SBT 持有；超量直接拒 |
| 一次性外部 op（curl 用户、AI agent 单次） | ✗ | ✗ | ✗ | fallback M3 X402 一次性付款 |
| 内部生态 op（AAStar 自家 paymaster + xPNTs） | ✗ | ✗ | ✗ | M2 trusted-paymasters fast-lane，不收费 |

### 6.2 优先级决策树（命中规则）

```
入口：eth_sendUserOperation(userOp, ...)
  │
  ▼
[1] paymaster ∈ trusted-paymasters?
  ├─ YES → M2 fast-lane，免费，不计入订阅，不走 X402，END
  └─ NO ↓
[2] 有 X-API-Key？
  ├─ YES → Layer 1 鉴权
  │       ├─ 失败 → 401/403 END
  │       └─ 通过 ↓
  └─ NO ↓
[3] sender 在 SubscriptionManager 有有效订阅？
  ├─ YES + quota>0 → Layer 2 命中，扣 quota，免 X402，END
  ├─ YES + quota=0 + tier=Pro + sessionKey active → Layer 3b 触发 intent，END
  ├─ YES + quota=0 + tier=Basic → fallback X402
  ├─ YES + quota=0 + tier=Free → 拒 (over_quota)，END
  └─ NO ↓
[4] M3 X402：返回 HTTP 402 + 报价
  ├─ 客户端付款重发 → 走 op
  └─ 客户端不付 → END
```

### 6.3 与 trusted-paymasters / X402 的兜底关系

| 来源 | 命中即终结 | 可降级到 | 永不冲突 |
|------|----------|---------|---------|
| trusted-paymasters fast-lane | ✅ | 不降级 | 与订阅 / X402 互斥（命中 fast-lane 不收任何费） |
| 订阅 quota 命中 | ✅ | 配额耗尽降 X402 / 拒 | 与 fast-lane 互斥（命中其一即不进另一） |
| Layer 3b per-op intent | ✅ | intent 失败降 X402 | 隐性依赖订阅 Pro tier |
| X402 一次性收费 | ✅ | 客户端拒付 → 拒 op | 兜底通道 |

**关键**：trusted-paymasters > 订阅 > X402。运营方可在配置中为某些 paymaster 同时启用"订阅 quota 计入但不收费"模式（即使是 trusted-paymasters，仍统计 quota 用于 SLA 报告），但默认行为是命中 fast-lane 后跳过订阅检查。

---

## 7 · 安全与防护

### 7.1 Sybil 攻击

**威胁**：同一人注册多个 SubscriptionManager 账号，刷 Free tier 配额（50/月 × N 个账号）。

**缓解**：
- SubscriptionManager.subscribe 调用 `SP.isEligibleForSponsorship(msg.sender)`（[SuperPaymaster.sol:752](file:///Users/jason/Dev/aastar/SuperPaymaster/contracts/src/paymasters/superpaymaster/v3/SuperPaymaster.sol#L752)）
- SBT 是非转让 + 一人一份（KYC 限制）
- Agent NFT 注册需要质押 / 信誉门槛（ERC-8004 体系）
- 即便 Sybil 成功创建多账号，每账号 Free tier 仅 50/月，攻击成本 > 收益（攻击者要花 N × KYC 成本换 N × 50 op）

### 7.2 DDoS

**威胁 1：API key 被盗**
- 攻击者用泄露 key 大量调用，把企业客户的 quota 烧光
- **缓解**：(a) per-key rate limit（§2）阻止瞬时洪峰；(b) bundler 监控 RPS 突增 → 自动 throttle → 推 webhook 给 owner（M3 §B.1）；(c) owner 可调 admin endpoint 立即 revoke + rotate

**威胁 2：session key 被盗（hot wallet 私钥泄露）**
- 攻击者用 hot wallet 调 SM.payFor / chargeForOp 扣空所有授权 user 的 aPNTs
- **缓解**：(a) hot wallet 用 KMS / HSM；(b) SM.chargeForOp 加 per-call max（如 100 aPNTs）+ per-user-per-day cap（如 1000 aPNTs）；(c) 监控 SM.payFor 调用频率，异常 → 自动暂停合约（owner pausable）；(d) hot wallet 与 utility / executor 隔离，泄露不放大；(e) 用 P256 session（148 字节）+ passkey 提高签名硬件门槛

**威胁 3：mempool 灌大量 intent op**
- 攻击者构造大量带 session key 的伪 intent op（用过期 / revoked session）打 mempool
- **缓解**：simulation 阶段 SessionKeyValidator 直接拒 → bundler 触发 reputation drop → 同源大量伪 op → IP 限流 → 短期 ban

### 7.3 经济攻击

**订阅退款攻击**：
- 用户付了 Pro 月费，第一天用完 5000 quota，然后取消订阅要求退款
- **缓解**：合约无退款条款；`cancelSubscription` 仅停止 autoRenew，已付月费不退；剩余 quota 仍可用至 expiresAt

**aPNTs 余额耗尽攻击**：
- 用户 prepaidBalance 用尽，bundler autoRenew 失败
- **缓解**：autoRenew 失败 → 推送通知用户 → 订阅自然到期 → 自动 fallback 到 X402 / 拒

**chargeForOp 滥用**：
- bundler 故意每笔 op 收高额 aPNTs（按 op 复杂度算的报价 inflate）
- **缓解**：(a) SM.chargeForOp 内有 max-per-call hardcap；(b) 用户的 session key 配 per-day cap（M5 扩展）；(c) bundler 报价透明（M3 §A.1 X402 规范要求 quote 公开），用户可对账

### 7.4 风控

**黑名单 user**：
- SM 加 `mapping(address => bool) public blocked` + admin function `setBlocked(user, true)`
- bundler 在每笔 op 入口先 check `SM.blocked(sender)`，命中即 403
- 黑名单触发条件：可疑大量 op、欺诈支付、链上行为异常

**黑名单 subscription**：
- 极端情况：某 tier 配置错（如 Free quota 错配 50000）→ admin 调 `pauseTier(Tier.Free)` → 该 tier 下所有用户配额冻结 → 排查后调 `resumeTier`

**审计 log**：
- 所有 SM 状态变更（subscribe / consume / charge / cancel）都 emit event
- bundler 侧每笔订阅命中 / autoRenew / chargeForOp 都结构化日志（M1 §2.3 JSON 格式）
- 周期 bundler 与链上 SM 对账（每 24h 跑一次 reconciliation 任务，差异 > threshold 推 webhook）

---

## 8 · 与 SuperPaymaster v5 的关系

### 8.1 复用 vs 独立

**决策**：SubscriptionManager **独立合约**部署在 UltraRelay-AAStar 仓库（`contracts/SubscriptionManager.sol`），但 **复用** SP v5 的能力：

| 能力 | 复用方式 |
|------|---------|
| **SBT 资格门槛** | SM.subscribe 调 `SP.isEligibleForSponsorship(user)` 检查 SBT / Agent NFT |
| **xPNTs 支付 token** | SM.subscribe 接受 xPNTs 作为 paymentToken；用 SP 已建立的 xPNTs 流通体系 |
| **aPNTs 计价单位** | tier 月费定价用 aPNTs（与 SP postOp 计费同单位，便于用户理解） |
| **role system** | SM admin 角色复用 SP `ROLE_PAYMASTER_SUPER` 或自定义 `ROLE_BUNDLER_OPERATOR` |
| **Agent registry** | SM 在 Layer 3b chargeForOp 时可读 SP.agentPolicies 给 agent 用户优惠 |

不复用的部分（SM 自有）：
- subscribe / cancelSubscription / consumeQuota / payFor 等订阅核心逻辑（SP 没有等价物）
- prepaidBalance（SP 有 aPNTsBalance per-operator，是不同概念）
- session key 协议（SM 不持 sessionKey，session key 在 AirAccount 合约里）

### 8.2 决策依据

**为何不嵌入 SP v5？**
- SP v5 已 1176 行（[SuperPaymaster.sol](file:///Users/jason/Dev/aastar/SuperPaymaster/contracts/src/paymasters/superpaymaster/v3/SuperPaymaster.sol)），加订阅会进一步膨胀，部署 / 审计 / 升级风险大
- 订阅是 bundler 业务，与 paymaster gas sponsorship 业务**不同维度**：paymaster 收 op 的 gas 费；订阅收 bundler 服务费——混在一起难解释
- 独立合约便于不同团队 / 不同链部署不同版本（如 OP-Mainnet 启用，新链先观察）
- SP v5 升级 / 审计 / 部署节奏已经够紧；订阅独立部署不阻塞 SP 路线图

**为何要 reuse SP 资格门槛？**
- SBT / Agent NFT 是 AAStar 生态统一的反 Sybil 证书，**不应该让 bundler 重新发明一遍**
- 用户已经为业务获取了 SBT，订阅时直接复用，零额外门槛
- 跨产品身份一致：用户在 SP 是 EndUser，在 SM 也是 EndUser

### 8.3 接口对接

```solidity
// contracts/SubscriptionManager.sol
interface ISuperPaymasterReadOnly {
    function isEligibleForSponsorship(address user) external view returns (bool);
    function isRegisteredAgent(address account) external view returns (bool);
    function hasRole(bytes32 role, address account) external view returns (bool);
}

contract SubscriptionManager is Ownable {
    ISuperPaymasterReadOnly public immutable superPaymaster;

    constructor(address _sp) {
        superPaymaster = ISuperPaymasterReadOnly(_sp);
    }

    function subscribe(Tier tier, address paymentToken, uint256 amount) external {
        require(superPaymaster.isEligibleForSponsorship(msg.sender), "not eligible");
        // ... 后续订阅逻辑
    }
}
```

### 8.4 协调清单（跨仓库）

| 项 | 责任方 | 状态 |
|---|------|------|
| SP v5 暴露 `isEligibleForSponsorship` view | SP 团队 | ✅ 已完成（[SuperPaymaster.sol:1010](file:///Users/jason/Dev/aastar/SuperPaymaster/contracts/src/paymasters/superpaymaster/v3/SuperPaymaster.sol#L1010)） |
| xPNTs `addAutoApprovedSpender(SubscriptionManager)` | 各社区 owner 配合 | M4 Phase 3 协调 |
| SP `ROLE_BUNDLER_OPERATOR` 注册（可选） | SP 团队 | M4 Phase 4 协商 |
| AirAccount SessionKey scope 文档化 | AirAccount 团队 | ✅ 已实现（[SessionKeyValidator.sol](file:///Users/jason/Dev/aastar/airaccount-contract/src/validators/SessionKeyValidator.sol)） |
| AirAccount SDK 暴露 grantSession 友好 API | AirAccount 团队 | M4 Phase 3 协调 |

---

## 9 · 演进路径

### 9.1 Phase 1：纯 API key（最快上线，企业客户）

**目标**：bundler 对外开放，企业客户能拿 key 接入。

**范围**：
- §2 全部内容
- 不依赖任何合约部署
- 不依赖 AirAccount session key
- 不依赖 SubscriptionManager

**时间估算**：2-3 周（含运营 SOP）

**验收**：见 §10.1

### 9.2 Phase 2：+ 链上订阅（需部署 SubscriptionManager）

**目标**：用户可以在链上自助订阅，bundler 链下查询缓存命中。

**范围**：
- §3 全部内容
- 部署 SubscriptionManager.sol（每条目标链一份）
- bundler 集成 SubscriptionCache + Settler
- 不要求 AirAccount session key（Layer 3 推迟）

**时间估算**：4-6 周（含合约审计）

**依赖前置**：Phase 1 完成

### 9.3 Phase 3：+ aPNTs auto-deduct（需 AirAccount session key 协调）

**目标**：用户开 Pro tier 自动续订；高级用户开 per-op metering。

**范围**：
- §4 + §5 全部内容
- 需 AirAccount 团队配合：SDK 暴露 grantSession 友好 API
- 需 SuperPaymaster 团队配合：xPNTs autoApprovedSpender（如走方案 Y）
- bundler 集成 SessionKeyClient + IntentBuilder + AutoRenewWorker + PerOpDeducter

**时间估算**：6-8 周（含跨仓库协调 + e2e）

**依赖前置**：Phase 2 完成 + AirAccount SessionKeyValidator 部署 + SDK 集成

### 9.4 Phase 4：+ 跨社区订阅互通

**目标**：用户在 community A 持有的 xPNTs 可付 community B bundler 的订阅；多社区共享一个 SubscriptionManager 实例。

**范围**：
- SubscriptionManager 加 multi-token 支持（同时接受多种 xPNTs 作为 payment）
- 与 OpenPNTs 协议层对齐（PROFILE.md 提到 AAStar 依赖 OpenPNTs 协议）
- 跨链 bridge（M3 §D.1 多链上线后规划）

**时间估算**：8-12 周（含协议设计 + 多社区接入）

**依赖前置**：Phase 3 完成 + M3 §D.1 多链上线 + OpenPNTs 跨社区规范确定

---

## 10 · 验收里程碑

### 10.1 Phase 1 验收（API key）

| # | 验收项 | 验收方式 | 状态 |
|---|--------|---------|------|
| 1.1 | KeyManager issue / lookup / revoke / rotate 单测 | `pnpm test src/auth` 全过 | ☐ |
| 1.2 | Fastify middleware 集成测试 | 8 个用例（带正确 / 过期 / 撤销 / 轮换中 / 无 key + required / 无 key + optional / 限流 / method 白名单） | ☐ |
| 1.3 | admin CLI（issue/revoke/rotate/list） | OP-Sepolia 环境验证全流程 | ☐ |
| 1.4 | per-key rate limit | 1 key 配 60/min，第 61 笔 429 | ☐ |
| 1.5 | revoke 实时性 | revoke 后 < 5 秒下一笔 403 | ☐ |
| 1.6 | 与 M1 IP rate-limit 共存 | 两层串行，先 IP 后 key | ☐ |
| 1.7 | 运营 SOP 文档 | `docs/RUNBOOK_API_KEY.md` 完整 | ☐ |

### 10.2 Phase 2 验收（链上订阅）

| # | 验收项 | 验收方式 | 状态 |
|---|--------|---------|------|
| 2.1 | SubscriptionManager 合约审计 | 第三方审计报告归档 | ☐ |
| 2.2 | SM 全 selector 单测覆盖 | foundry test 全过 + coverage > 95% | ☐ |
| 2.3 | 部署 SM 到 OP-Sepolia | 链上确认部署 + tier 配置 | ☐ |
| 2.4 | bundler SubscriptionCache 集成 | mock SM 单测 + 真链 e2e | ☐ |
| 2.5 | 资格门槛验证 | 非 SBT / Agent 调 subscribe → revert | ☐ |
| 2.6 | quota 周期 settlement | 100 笔 op 后 batch settle 上链成功 + 链上链下一致 | ☐ |
| 2.7 | cache invalidation | 监听 Subscribed 事件正确更新 cache | ☐ |
| 2.8 | 多实例一致性 | 3 bundler 实例并行扣同一 user，settlement 后链上正确 | ☐ |

### 10.3 Phase 3 验收（aPNTs auto-deduct + per-op）

| # | 验收项 | 验收方式 | 状态 |
|---|--------|---------|------|
| 3.1 | IntentBuilder 105-byte sig 单测 | 通过 SessionKeyValidator._validateECDSASession | ☐ |
| 3.2 | autoRenewWorker 端到端 | grant → 触发 autoRenew → SM.payFor 上链 → 订阅延长 | ☐ |
| 3.3 | session key 撤销路径 | revokeSession 后 autoRenew 跳过 + 推送通知 | ☐ |
| 3.4 | session key 7 天过期 | TTL 到期后 autoRenew 失败 + 触发 re-grant 提示 | ☐ |
| 3.5 | PerOpDeducter intent 打包 | originalUserOp + intent 同 bundle 上链 atomic | ☐ |
| 3.6 | scope 越权拒绝 | 故意改 callData 为非 payFor → 链上 _enforceGuard 拒 | ☐ |
| 3.7 | hot wallet 紧急撤销演练 | 模拟泄露 → admin 暂停 → 攻击窗口 < 5 分钟 | ☐ |
| 3.8 | 与 AirAccount 联合 e2e | AirAccount 团队签字 | ☐ |
| 3.9 | per-call max + per-day cap | SM.chargeForOp 拒超额请求 | ☐ |

### 10.4 Phase 4 验收（跨社区互通）

| # | 验收项 | 验收方式 | 状态 |
|---|--------|---------|------|
| 4.1 | SM multi-token 支持 | 同一 user 用 community A 的 xPNTs 订阅 | ☐ |
| 4.2 | OpenPNTs 跨社区规范对齐 | OpenPNTs 团队签字 | ☐ |
| 4.3 | 多链部署 | 至少 2 链 SM 部署 + bundler 跨链查询 | ☐ |
| 4.4 | 跨社区订阅 e2e | 用户 community A xPNTs 付 community B bundler 订阅 | ☐ |

---

## 11 · 输出物清单

### 11.1 合约（新增，本仓库）

- `contracts/SubscriptionManager.sol` — 订阅核心合约
- `contracts/SubscriptionManager.t.sol` — foundry 单测
- `contracts/script/DeploySubscriptionManager.s.sol` — 部署脚本

### 11.2 bundler 代码（新增）

```
src/auth/
├── apiKey.ts
├── apiKeyMiddleware.ts
├── apiKeyAdmin.ts
└── types.ts

src/subscription/
├── subscriptionCache.ts
├── settlement.ts
├── sessionKeyClient.ts
├── intentBuilder.ts
├── autoRenewWorker.ts
├── perOpDeducter.ts
├── prepaidLedger.ts
└── types.ts
```

### 11.3 bundler 代码（修改）

- `src/cli/config/options.ts` — 加 §2/§3/§4/§5 全部 CLI flags
- `src/rpc/methods/eth_sendUserOperation.ts` — 入口接订阅命中判定（§1.1 ④）
- `src/rpc/methods/boost_sendUserOperation.ts` — 同上
- `src/rpc/server.ts` — 注册 apiKeyHook
- `src/mempool/mempool.ts` — intent + originalOp linked-pair 出队（§5.4.3）
- `src/utils/metrics.ts` — 加订阅相关 metric（subscription_hit_total / autoRenew_total / chargeForOp_total）

### 11.4 文档

新增：
- `docs/SUBSCRIPTION_DESIGN.md` — 本文件
- `docs/RUNBOOK_API_KEY.md` — Phase 1 运营 SOP（issue / revoke / rotate / 客户支持）
- `docs/SUBSCRIPTION_CONTRACT_SPEC.md` — SM 合约 ABI + 事件 + 升级策略
- `docs/SESSION_KEY_INTEGRATION.md` — bundler 与 AirAccount session key 的集成规范（与 AirAccount 团队共享）
- `docs/SUBSCRIPTION_TIER_PRICING.md` — tier 定价 / 配额 / 升级路径（商务团队维护）
- `docs/SUBSCRIPTION_SECURITY.md` — §7 安全分析独立成文
- `docs/RUNBOOK_AUTO_RENEW.md` — Phase 3 运营 SOP（hot wallet 管理 / 紧急撤销 / 用户 re-grant 推送）

更新：
- `docs/CHAIN_CONFIG.md` — 加各链 SubscriptionManager 部署地址
- `docs/FORK_DELTA.md` — 加 M4 增量条目

### 11.5 SDK / 示例

- `examples/subscription-curl/` — curl 示例：subscribe / get-status / cancel
- `examples/subscription-permissionless/` — permissionless.js 集成订阅 + session key grant
- `examples/auto-renew-grant/` — 用户授权 session key 给 bundler 的最小示例
- `docs/SUBSCRIPTION_INTEGRATION.md` — 客户端 SDK 集成指南

### 11.6 运维

- `monitoring/grafana-dashboard-subscription.json` — Grafana dashboard（订阅命中率 / autoRenew 成功率 / hot wallet 余额）
- `monitoring/alert-rules-subscription.yaml` — Prometheus 告警规则（autoRenew 失败率 > 阈值 / hot wallet 余额 < 警戒）
- `scripts/reconciliation.ts` — 周期对账脚本（链上 SM quota vs 链下 cache）

### 11.7 不动

- 任何 SP v5 合约改动（仅复用 view 接口）
- 任何 AirAccount 合约改动（仅复用 SessionKeyValidator）
- 任何 xPNTs 合约改动（仅依赖既有 addAutoApprovedSpender + transferFrom firewall）
- M1/M2/M3 已交付的 bundler 核心通路（fast-lane / X402 / 监控）—— 订阅是新增层，不改既有层

---

## 12 · 风险与缓解表

| 风险 | 影响 | 缓解 | 责任方 |
|------|------|------|------|
| API key 泄露 | 客户配额被烧 | (a) per-key rate limit + 异常 RPS webhook；(b) 一键 revoke + rotate；(c) 客户使用文档强调 secret 存 vault | 运营 |
| SubscriptionManager 合约 bug 吞用户预存 | 资金损失 | (a) 第三方审计；(b) 无 proxy 升级（部署即 immutable）；(c) admin pausable + 紧急 emergencyWithdraw 给 user | 合约团队 |
| bundler hot wallet 私钥泄露 | 攻击者扣空所有授权 user 的 aPNTs | (a) KMS / HSM 管理；(b) SM per-call + per-day cap；(c) admin 一键暂停 hot wallet；(d) hot wallet 与其他 wallet 隔离；(e) 推 P256 session 替代 ECDSA session | 运营 + 合约 |
| AirAccount SessionKey 协议变更 | bundler 构造的 sig 失效 | (a) 与 AirAccount 团队定 ABI 兼容性承诺；(b) bundler 加 signature version 字段，旧 / 新两版并存灰度 | AirAccount + bundler |
| session key 7 天上限被用户嫌烦 | 用户不开自动续订 → 订阅模型崩溃 | (a) SDK 推 P256 session（passkey 一键签）；(b) SDK 在 D-1 推 push notification；(c) 推动 AirAccount 评估提高上限到 30 天（改合约常量） | bundler + AirAccount |
| 跨社区互通 (Phase 4) 协议争议 | OpenPNTs 规范未对齐 | Phase 4 不阻塞 Phase 1-3 上线；Phase 4 协议先 RFC 6 个月 | OpenPNTs + AAStar |
| SubscriptionManager 升级需求 | 早期 tier 配置 / 业务规则改不动 | tier config 用 admin function 可改（不动合约逻辑）；业务规则改动需重新部署 + 用户迁移工具 | 合约 + 运营 |
| 链上 quota 与链下 cache 不一致 | 用户被超扣 / 少扣 | (a) 周期对账脚本；(b) cache invalidation 监听事件；(c) settlement 失败重试；(d) 最坏 case 链上为准 | bundler |
| chargeForOp 报价不透明 | 用户无法验证 bundler 计费 | (a) 报价用 M3 §A.1 X402 同样 quote 格式（公开、可对账）；(b) bundler 在 RPC 响应里返回本笔扣的 aPNTs；(c) 周期 dashboard 公开总收入 | bundler |
| 多 bundler 抢同一 user session | nonce 冲突 / replay | session key 只 grant 给一个 bundler；多 bundler 抢用户由 SDK 决定授权对象；不共享 hot wallet 私钥 | SDK + bundler |
| 与 SP v5 信用系统语义混淆 | 用户搞不清扣的是 paymaster 费还是 bundler 费 | (a) 文档清晰区分两类费；(b) bundler 在响应日志里分别标 `paymaster_fee` / `bundler_subscription_fee`；(c) dashboard 分两栏展示 | 文档 + bundler |
| Free tier 被 Sybil 滥刷 | 配额被无门槛账户吃光 | (a) 资格门槛 SBT/Agent NFT；(b) Free tier 配额低（50/月）使攻击不经济；(c) 监控异常注册速率 | 合约 + 监控 |
| autoRenew 在用户睡觉时失败导致服务中断 | 用户体验差 | (a) D-3 / D-1 / D-0 三次 push notification；(b) 失败后 24h grace period（订阅过期但仍可用，给 user 时间续）；(c) 失败 fallback 到 X402 + 推送提示 | bundler + SDK |

---

## 13 · 附录

### 13.1 名词表

- **bundler**：本仓库 UltraRelay-AAStar，ERC-4337 bundler
- **fast-lane**：M2 trusted-paymasters 绿色通道
- **X402**：M3 §A.1 HTTP 402 一次性收费协议
- **订阅 (subscription)**：本文 Layer 2 链上订阅
- **API key**：本文 Layer 1 HTTP 鉴权
- **session key**：AirAccount algId 0x08 时间限制代签密钥
- **intent UserOp**：bundler 用 session key 签的代扣 op，与原 op 同 bundle 上链
- **quota**：订阅 tier 内的月度 op 数
- **prepaidBalance**：用户在 SubscriptionManager 中预存的 aPNTs 余额
- **hot wallet**：bundler 持有的、用作 sessionKey 的 EOA 私钥；与 executor / utility wallet 隔离
- **tier**：订阅等级（None / Free / Basic / Pro / Enterprise）

### 13.2 关键 file:line 索引

| 引用 | 文件 | 行 |
|-----|------|---|
| SessionKeyValidator dispatcher | [SessionKeyValidator.sol](file:///Users/jason/Dev/aastar/airaccount-contract/src/validators/SessionKeyValidator.sol) | L99-L106 |
| ECDSA session sig 105-byte 布局 | [SessionKeyValidator.sol](file:///Users/jason/Dev/aastar/airaccount-contract/src/validators/SessionKeyValidator.sol) | L97 (注释) + L255-L269 (验证) |
| P256 session sig 148-byte 布局 | [SessionKeyValidator.sol](file:///Users/jason/Dev/aastar/airaccount-contract/src/validators/SessionKeyValidator.sol) | L98 (注释) + L319-L340 |
| MAX_SESSION_DURATION = 7 days | [SessionKeyValidator.sol](file:///Users/jason/Dev/aastar/airaccount-contract/src/validators/SessionKeyValidator.sol) | L38 |
| grantSession (off-chain owner sig) | [SessionKeyValidator.sol](file:///Users/jason/Dev/aastar/airaccount-contract/src/validators/SessionKeyValidator.sol) | L111-L127 |
| revokeSession + nonce++ | [SessionKeyValidator.sol](file:///Users/jason/Dev/aastar/airaccount-contract/src/validators/SessionKeyValidator.sol) | L146-L153 |
| isSessionActive view | [SessionKeyValidator.sol](file:///Users/jason/Dev/aastar/airaccount-contract/src/validators/SessionKeyValidator.sol) | L156-L159 |
| _validateECDSASession 拒绝条件 | [SessionKeyValidator.sol](file:///Users/jason/Dev/aastar/airaccount-contract/src/validators/SessionKeyValidator.sol) | L260-L266 |
| scope 由 _enforceGuard 运行时强制 | [SessionKeyValidator.sol](file:///Users/jason/Dev/aastar/airaccount-contract/src/validators/SessionKeyValidator.sol) | L21-L23 (注释) |
| xPNTs autoApprovedSpenders mapping | [xPNTsToken.sol](file:///Users/jason/Dev/aastar/SuperPaymaster/contracts/src/tokens/xPNTsToken.sol) | L49 |
| xPNTs allowance() 重写返回 max | [xPNTsToken.sol](file:///Users/jason/Dev/aastar/SuperPaymaster/contracts/src/tokens/xPNTsToken.sol) | L241-L251 |
| xPNTs transferFrom firewall (to == msg.sender or SP) | [xPNTsToken.sol](file:///Users/jason/Dev/aastar/SuperPaymaster/contracts/src/tokens/xPNTsToken.sol) | L262-L277 |
| xPNTs MAX_SINGLE_TX_LIMIT = 5000 ether | [xPNTsToken.sol](file:///Users/jason/Dev/aastar/SuperPaymaster/contracts/src/tokens/xPNTsToken.sol) | L76 |
| xPNTs addAutoApprovedSpender | [xPNTsToken.sol](file:///Users/jason/Dev/aastar/SuperPaymaster/contracts/src/tokens/xPNTsToken.sol) | L446-L453 |
| xPNTs burnFromWithOpHash (replay protection) | [xPNTsToken.sol](file:///Users/jason/Dev/aastar/SuperPaymaster/contracts/src/tokens/xPNTsToken.sol) | L298-L319 |
| xPNTs recordDebt (信用记录) | [xPNTsToken.sol](file:///Users/jason/Dev/aastar/SuperPaymaster/contracts/src/tokens/xPNTsToken.sol) | L330-L343 |
| SP v3 validatePaymasterUserOp 入口 | [SuperPaymaster.sol](file:///Users/jason/Dev/aastar/SuperPaymaster/contracts/src/paymasters/superpaymaster/v3/SuperPaymaster.sol) | L725 |
| SP v3 isEligibleForSponsorship (SBT or Agent) | [SuperPaymaster.sol](file:///Users/jason/Dev/aastar/SuperPaymaster/contracts/src/paymasters/superpaymaster/v3/SuperPaymaster.sol) | L752 + L1010-L1012 |
| SP v3 isRegisteredAgent | [SuperPaymaster.sol](file:///Users/jason/Dev/aastar/SuperPaymaster/contracts/src/paymasters/superpaymaster/v3/SuperPaymaster.sol) | L1015-L1023 |
| SP v3 minTxInterval 限频 | [SuperPaymaster.sol](file:///Users/jason/Dev/aastar/SuperPaymaster/contracts/src/paymasters/superpaymaster/v3/SuperPaymaster.sol) | L766-L772 |
| SP v3 postOp burnFromWithOpHash + recordDebt fallback | [SuperPaymaster.sol](file:///Users/jason/Dev/aastar/SuperPaymaster/contracts/src/paymasters/superpaymaster/v3/SuperPaymaster.sol) | L869-L874 |
| AAStar INTERFACES SP v5 信用 / Agent / SBT | [INTERFACES.md](file:///Users/jason/Dev/Brood/orgs/aastar/INTERFACES.md) | L51-L62 |
| AAStar PROFILE 三模块定位 | [PROFILE.md](file:///Users/jason/Dev/Brood/orgs/aastar/PROFILE.md) | L49-L54 |

### 13.3 与 M1/M2/M3 的位置交叉引用

| 概念 | M1 引 | M2 引 | M3 引 | 本文引 |
|-----|-------|-------|-------|--------|
| HTTP rate limit (per-IP) | §4.1 | — | — | §2.4.6 (与 per-key 限流串行) |
| trusted-paymasters fast-lane | — | §1-§3 | §A.1 互斥规则 | §6.2 优先级最高 |
| paymasterProfiles 插件骨架 | — | §2 | — | (无关)，订阅是新轴 |
| X402 一次性收费 | — | — | §A.1 | §6.2 兜底，§5.2 对比 |
| xPNTs 预存账本（链下） | — | — | §A.2 | §3.4.6 对比，§8.1 复用 token |
| ETH PrepaidGas 合约 | — | — | §A.3 | (无关)，订阅用 aPNTs / xPNTs |
| 监控告警 webhook | — | — | §B.1 | §7 风控全部接 |
| 多实例水平扩展 | (Redis store) | — | §D.2 | §3.4.4 cache 一致性 |
| Operator attestation | — | — | §C.2 | (无关)，订阅信任在 session key |
| EIP-7702 | (PR #13) | — | §C.1 | (无关) |
| 跨链 / 多链 | — | — | §D.1 | §9.4 Phase 4 |

---

**文档结束**。下次评审入口：`docs/SUBSCRIPTION_DESIGN.md` §0 文档定位。
