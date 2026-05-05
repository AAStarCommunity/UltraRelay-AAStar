# UltraRelay-AAStar · M2 产品设计

> **里程碑定位**：在 M1 完成"标准合规 ERC-4337 bundler"之上，给**白名单内的 trusted paymaster**（首发 SuperPaymaster v3）开一条**绿色通道（Fast Lane）**——同样的合规验证、同样的安全门槛，但出队优先 + 立即广播 + 0 priority fee。M2 之后才进入 M3（X402 收费 / attestation / 监控自动化）。
>
> **不在 M2**：
> - **不放宽** ERC-7562 验证规则（safe 模式 tracer 一律照跑，opcode/storage 限制不动）
> - **不收费**——xPNTs / X402 计费链路推到 M3
> - **不协调 SuperPaymaster 加 attestation 字段**——M2 仅"运营白名单 + 合约自身 sponsorship 资格"双闸；attestation/链上信任绑定是 M3 的 C 方案
> - **不放过任何 op**——白名单只决定优先级，不绕过任何 simulation / reputation / paymaster 自身校验
>
> **判定方案（已敲定，本文不再讨论备选）**：方案 A — **仅看 paymaster 地址**。`userOp.paymaster (v0.7) / paymasterAndData[0:20] (v0.6)` ∈ trusted-paymasters 白名单 ⇒ 走 Fast Lane。不看 sender、不看 callData、不看 factory（factory 留作 M2 §6 可选双因子的扩展点）。
>
> **当前状态**：bundler 已具备 boost endpoint（ZeroDev §2.1）和完整 mempool / executor 通路，M2 的工作是 (a) 加 trusted-paymasters 配置；(b) 抽象 paymasterProfiles 插件骨架；(c) 在 RPC 入队 / mempool 出队 / executor 计费 三个点接入 Fast Lane 标记。**全部增量集中在 ≤ 5 个 hook 位置**，不动验证逻辑、不动协议核心。

---

## 0 · M2 验收顺序

1. §1 配置层（CLI flag + 配置文件）—— 配进来能读到，先打印日志验证
2. §2 paymasterProfiles 插件骨架 + SuperPaymaster v3 profile —— 单元测试覆盖判定矩阵
3. §3 三处核心 hook 接入（RPC 入口标记 / mempool 优先队列 / executor fee 策略）
4. §4 EIP-7702 完整实战 —— authorizationList 在 estimate / simulation / handleOps 全链路透传 + OP-Mainnet e2e
5. §5 安全分析复盘 —— 把"为什么不放过任何 op"写到 `docs/SECURITY_M2.md` 作为审计依据
6. §6 (可选) 双因子识别 —— 评估是否纳入 M2，否则推 M3
7. §7 验收（单元 + e2e on OP-Sepolia + 安全测试）
8. §8 验收检查表打钩
9. §9 输出物归档
10. §10 进入 M3 切换条件

---

## 1 · trusted-paymasters 配置

### 1.1 CLI flag `--trusted-paymasters`

- **业务价值**：运营方需要一种"零依赖、最小配置"的方式声明哪些 paymaster 走绿色通道——比如本地开发、单链测试网、灰度 OP-Sepolia 这些场景，命令行传一行 `--trusted-paymasters 0xAddr1,0xAddr2` 就完事，比配文件更轻。这是 M2 落地的最小可用形态（MVP）。
- **必要性**：
  - 没有这个 flag，绿色通道就只能写死在源码里——不可运维、改一次要重新构建镜像
  - 与 ZeroDev 现有 CLI 风格（`--entrypoints "0xv06,0xv07,0xv08"`）一致，避免引入新概念
  - 方案 A（仅看 paymaster 地址）天然只需要一个地址列表，命令行能装下
- **流程**：
  1. bundler 启动时解析 `--trusted-paymasters "0xAddr1,0xAddr2"` 到 `config.trustedPaymasters: Address[]`（空数组 = Fast Lane 关闭）
  2. 启动后日志打印 `{ trustedPaymasterCount: N, addresses: ["0x...", ...] }`
  3. 运行时由 paymasterProfiles 注册器把 CLI 列表合并到内置 profile（CLI 列表优先级高于内置默认）
- **技术方案**：
  - 改动位置：`src/cli/config/options.ts` 加 flag
    - 类型：以逗号分隔的 0x 地址列表，启动时校验 checksum / 长度 / 重复
    - 默认值：`[]`（不传 = Fast Lane 关闭，行为完全等同 M1）
  - 配置注入：`src/createConfig.ts` 把解析结果挂到 `AltoConfig.trustedPaymasters`
  - 校验：地址非法 / 长度不为 20 字节 / 重复 ⇒ 启动 fail-fast，**不静默忽略**（避免运维以为生效了实际没生效）
  - 验收：
    - 单元测试：传 `--trusted-paymasters 0xabc...,0xdef...` 解析得到长度为 2 的数组
    - 单元测试：传非法地址（如 `0x123`）启动 fail-fast
    - e2e：OP-Sepolia 启动带 SuperPaymaster v3 OP-Sepolia 合约地址，`/wallets` 或专用 `/admin/trusted-paymasters`（见 §1.3）endpoint 能查到

### 1.2 配置文件 `--trusted-paymasters-file`

- **业务价值**：生产环境一个 bundler 实例可能要服务多条链（虽然 M2 主推 OP-Sepolia + OP-Mainnet 各一个 bundler，但插件骨架要为多链留口子）。命令行传地址在多链/多 paymaster 场景下不可维护。配置文件按 `chainId` 分组，**同一个 bundler 启动不同 chain 时自动选对应组**——也方便运维做 GitOps（配置进 repo、版本化、PR 评审）。
- **必要性**：
  - 多链场景下配置必须文件化
  - SuperPaymaster v3 在 OP-Sepolia 和 OP-Mainnet 部署的合约地址不同（`docs/CHAIN_CONFIG.md` 已有的"按链推荐配置"延伸）
  - 配置文件比 CLI flag 更利于后续 §1.3 的热更
- **流程**：
  1. bundler 启动时如果传了 `--trusted-paymasters-file ./trusted-paymasters.json`，先读文件
  2. 文件按 chainId 分组：`{ "11155420": [{ address, name, profile }], "10": [...] }`
  3. 启动时按 `config.chainId` 选出当前链的 paymaster 列表
  4. 与 §1.1 CLI flag 合并：CLI 列表追加在文件列表之后，去重以**文件列表为基准**（CLI 是临时 override / 调试通道）
  5. 启动后日志打印 `{ chainId, source: "file+cli", paymasterCount: N, paymasters: [{address, name}] }`
- **技术方案**：
  - 改动位置：`src/cli/config/options.ts` 加 flag；`src/cli/config/loadTrustedPaymasters.ts` 新文件实现解析 + 合并
  - 配置文件 schema（Zod 验证）：
    ```jsonc
    {
      "$schema": "./trusted-paymasters.schema.json",
      "chains": {
        "11155420": [
          {
            "address": "0xSuperPaymasterV3OnOpSepolia",
            "name": "SuperPaymaster v3 (OP-Sepolia)",
            "profile": "superpaymaster-v3",
            "notes": "AAStar 内部 + xPNTs 业务"
          }
        ],
        "10": [
          {
            "address": "0xSuperPaymasterV3OnOpMainnet",
            "name": "SuperPaymaster v3 (OP-Mainnet)",
            "profile": "superpaymaster-v3"
          }
        ]
      }
    }
    ```
  - `profile` 字段必须匹配 §2 注册的 profile id；未知 profile ⇒ 启动 fail-fast
  - 校验：
    - 文件不存在 / JSON parse 失败 ⇒ fail-fast
    - 当前 chainId 在文件中无条目 + CLI 也没传 ⇒ 警告日志 + Fast Lane 关闭（不算错误）
    - 同一 chainId 下重复 address ⇒ fail-fast
  - 验收：
    - 单元测试：覆盖解析、Zod schema 校验、CLI+File 合并去重逻辑
    - 单元测试：未知 chainId 不报错只警告；未知 profile 报错
    - e2e：OP-Sepolia 启动加载文件、`/admin/trusted-paymasters` 返回正确条目

### 1.3 运行时 reload（SIGHUP / admin endpoint，**可选**）

- **业务价值**：上线后想加新 trusted paymaster（如新合作运营方上线新 SuperPaymaster 实例），不能要求 bundler 重启——重启会丢 in-memory mempool、断开所有 WebSocket 连接、影响 SLA。SIGHUP 或 admin endpoint 触发热更是生产通常做法。
- **必要性**：
  - 可选项——M2 MVP 阶段重启可接受（OP-Sepolia 灰度阶段更新频率低）
  - 但插件骨架（§2）必须为热更**留接口**，否则 M3 想加就要大改架构
- **流程**：
  1. **SIGHUP 通道**：bundler 进程收到 SIGHUP ⇒ 重新读配置文件 ⇒ 重新调用 paymasterProfiles 注册器
  2. **admin endpoint 通道**：`POST /admin/reload-trusted-paymasters`（仅 `--admin-enabled true` 启用，并要求 IP 在 `--admin-allowlist` 中）⇒ 同上
  3. 热更**只换白名单和 profile 的 isFastLane / feeOverride 函数**——不动 mempool 已有的 op、不动 executor 已有的 in-flight bundle
  4. 热更日志记录 diff：`{ added: ["0x..."], removed: ["0x..."], unchanged: N }`
- **技术方案**：
  - 改动位置：`src/cli/main.ts` 注册 SIGHUP handler；`src/rpc/server.ts` 加 admin route（受 `--admin-enabled` 保护）
  - 并发安全：reload 写新白名单时用原子替换（新对象赋值给 `config.trustedPaymastersRef`），读侧不加锁——JS 单线程保证
  - **M2 决策**：默认实现 SIGHUP；admin endpoint 推到 M3 与监控告警 webhook 一起做（M3 反正要加 admin 面板）
  - 验收：
    - 单元测试：mock 配置文件，发 SIGHUP，确认白名单更新
    - 灰度测试：OP-Sepolia 部署后 `kill -HUP <pid>` 无中断
    - 在 reload 进行中提交一笔 op，确认无竞态丢失

---

## 2 · paymasterProfiles 插件骨架（hook 数严格 ≤ 5）

### 2.1 接口定义

- **业务价值**：M2 起步只有 SuperPaymaster v3 一个 profile，但**未来必然有第二、第三个** trusted paymaster（合作运营方接入、自家 v4 升级、跨链版本差异）。如果把 SuperPaymaster v3 的逻辑直接 hardcode 进 mempool / executor，下一个 paymaster 接入要再修一遍代码——不可持续。**必须先抽象出插件接口**，再把 SuperPaymaster v3 实现成第一个插件。
- **必要性**：
  - 可扩展性：新增 paymaster 只需写一个 profile 文件 + 配置一行，不动核心代码
  - 测试隔离：profile 单元测试不依赖 mempool / executor
  - hook 数控制：所有插件共享同一组 ≤ 5 个 hook 接入点（见 §2.4），bundler 主流程零侵入
- **流程**：
  1. 定义 `PaymasterProfile` interface
  2. profile 实现方按接口写文件放到 `src/paymasterProfiles/<id>/index.ts`
  3. `src/paymasterProfiles/index.ts` 静态扫描 + 注册
  4. bundler 在 5 个 hook 点查询当前 op 对应的 profile（按 paymaster 地址 lookup）
- **技术方案**：
  - 接口定义（`src/paymasterProfiles/types.ts`）：
    ```typescript
    export interface PaymasterProfile {
        // === 静态身份 ===
        id: string                          // 唯一 id, e.g. "superpaymaster-v3"
        name: string                        // 人类可读名称
        addresses: {                        // 按链 chainId → 合约地址列表
            [chainId: number]: Address[]
        }

        // === 行为 hook（被 bundler 主流程调用）===

        // hook 1: 入口处判定是否走 Fast Lane
        // 输入：完整 UserOp + 当前 chainId
        // 输出：true=走 Fast Lane | false=走标准路径
        // 约束：必须是 pure / 同步——不能发 RPC、不能查链
        isFastLane(args: {
            userOp: UserOperation
            chainId: number
        }): boolean

        // hook 2: 给 executor 提供 fee 策略（仅 Fast Lane op 调用）
        // 输入：当前网络 baseFee
        // 输出：覆盖后的 maxFeePerGas / maxPriorityFeePerGas
        // 默认行为（superpaymaster-v3）：priority=0, max=baseFee+ε
        feeOverride(args: {
            networkBaseFee: bigint
            chainId: number
        }): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }

        // hook 3 (可选): 额外验证（M2 默认 no-op，给 M3 attestation 留口子）
        extraValidation?(args: {
            userOp: UserOperation
            entryPoint: Address
        }): Promise<{ ok: boolean; reason?: string }>
    }
    ```
  - **接口设计原则**：
    - `isFastLane` 必须 pure 同步——避免每笔 op 入队时多一次 RPC
    - `feeOverride` 入参只给 baseFee，不给完整 op——防止 profile 写出"按 sender 区别定价"这种灰色逻辑
    - `extraValidation` 标 optional + 异步——给 M3 留扩展（如 attestation 链上查询），M2 全部 profile 不实现
  - 验收：
    - 单元测试：mock profile 实现，调用 `isFastLane` / `feeOverride` 行为符合预期
    - 类型测试：profile 不实现 `id` / `addresses` / `isFastLane` / `feeOverride` 编译报错

### 2.2 注册机制

- **业务价值**：插件注册要"零运行时依赖、零重启风险"——profile 文件加进去，下次 bundler 启动自动生效。运营方不需要懂 TypeScript 模块系统，新增 profile 走 PR 流程审过即可上线。
- **必要性**：
  - 静态注册比动态扫描更安全（不会 import 未审过的代码）
  - 与 ZeroDev 现有 `src/handlers/` 工厂模式一致
- **流程**：
  1. profile 实现写在 `src/paymasterProfiles/<id>/index.ts`，导出 default `PaymasterProfile` 对象
  2. `src/paymasterProfiles/index.ts` 静态 `import` 所有已知 profile：
     ```typescript
     import superPaymasterV3 from "./superpaymaster-v3"
     export const ALL_PROFILES: PaymasterProfile[] = [superPaymasterV3]
     ```
  3. 启动时构造 `PaymasterProfileRegistry`：按 `address.toLowerCase()` 建索引
  4. 运行时按 `userOp.paymaster` lookup 一次 O(1)
- **技术方案**：
  - 改动位置（新增）：
    - `src/paymasterProfiles/index.ts` —— 静态聚合 + Registry 类
    - `src/paymasterProfiles/types.ts` —— interface
    - `src/paymasterProfiles/superpaymaster-v3/index.ts` —— 第一个 profile
  - Registry 关键方法：
    ```typescript
    class PaymasterProfileRegistry {
        constructor(args: {
            allProfiles: PaymasterProfile[]
            trustedPaymasters: Address[]   // 来自 §1 配置（合并后）
            chainId: number
        })
        // lookup: 仅返回"在白名单 AND 在 profile addresses 中"的 profile
        getProfile(paymasterAddress: Address): PaymasterProfile | null
    }
    ```
  - **关键约束**：profile 在 `addresses[chainId]` 中声明的地址 **AND** 该地址在 §1 trustedPaymasters 白名单中——**两个都满足才走 Fast Lane**。这保证：
    - profile 静态声明的地址是"我们认识的 paymaster"（避免误把陌生 address 当 SuperPaymaster v3 处理）
    - 运营白名单是"我们信任的 paymaster"（运营方决定上线哪些）
  - 验收：
    - 单元测试：mock 多个 profile，注册器按地址正确分发
    - 单元测试：address 在 profile 但不在 trustedPaymasters ⇒ 返回 null
    - 单元测试：address 在 trustedPaymasters 但不在 profile ⇒ 返回 null（可改 warn 日志，因为这种配置很可能是运维笔误）

### 2.3 SuperPaymaster v3 作为首个 profile

- **业务价值**：SuperPaymaster v3 是 AAStar 自家的、链上已经部署的、已经在跑业务的合约。M2 的全部业务收益都来自这一个 profile。把它做对，就是把 M2 做对。
- **必要性**：
  - 验证插件接口是否实用——一个真实 profile 跑通了才说明接口设计合理
  - 给后续 profile 实现做模板
- **流程**：
  1. 在 `src/paymasterProfiles/superpaymaster-v3/index.ts` 写实现：
     - `addresses`：OP-Sepolia + OP-Mainnet 实际部署地址
     - `isFastLane`：方案 A 实现——只要 op 的 paymaster 字段命中本 profile 的 addresses，返回 true
     - `feeOverride`：返回 `{ maxPriorityFeePerGas: 0n, maxFeePerGas: networkBaseFee + ε }`，ε 配置项（默认 100 wei，OP 链 baseFee 极低 + 0 拥塞条件下 ε 实际无影响）
- **技术方案**：
  - profile 文件结构：
    ```typescript
    // src/paymasterProfiles/superpaymaster-v3/index.ts
    import type { PaymasterProfile } from "../types"

    const SUPERPAYMASTER_V3: PaymasterProfile = {
        id: "superpaymaster-v3",
        name: "SuperPaymaster v3 (AAStar)",
        addresses: {
            11155420: ["0x..."],   // OP-Sepolia
            10:        ["0x..."]    // OP-Mainnet
        },
        isFastLane({ userOp, chainId }) {
            // 方案 A: 只看 paymaster 地址
            const paymaster = extractPaymasterAddress(userOp)
            if (!paymaster) return false
            return SUPERPAYMASTER_V3.addresses[chainId]
                ?.some(a => a.toLowerCase() === paymaster.toLowerCase()) ?? false
        },
        feeOverride({ networkBaseFee, chainId }) {
            // 0 priority fee + baseFee + 100 wei 容错
            return {
                maxFeePerGas: networkBaseFee + 100n,
                maxPriorityFeePerGas: 0n
            }
        }
        // extraValidation 不实现 — M2 不放宽不收紧，M3 attestation 时再加
    }
    export default SUPERPAYMASTER_V3
    ```
  - **地址来源**：从 `SuperPaymaster` 项目部署文档拿（同 repo 链 deployments），M2 验收时双重确认 OP-Sepolia 上 `eth_getCode` 非空且 `version()` 返回 `"SuperPaymaster-5.3.0"` 或后续兼容版本
  - **paymaster 地址提取**（共享工具函数 `src/utils/extractPaymaster.ts`）：
    - v0.6: `userOp.paymasterAndData.slice(0, 42)`（前 20 字节）
    - v0.7: `userOp.paymaster`（直接读字段）
    - v0.8: 同 v0.7
    - 空 `paymaster` / 空 `paymasterAndData == "0x"` ⇒ 返回 null（boost / self-pay 路径，**不走 Fast Lane**）
  - 验收：
    - 单元测试：构造 v0.6 / v0.7 UserOp 各一笔，paymaster 命中 → `isFastLane = true`；不命中 → false
    - 单元测试：`paymasterAndData = "0x"` → false
    - e2e on OP-Sepolia：用真实 SuperPaymaster v3 + xPNTs 钱包发一笔，bundler 日志 `{ profile: "superpaymaster-v3", isFastLane: true }`

### 2.4 hook 接入点（严格列出全部 ≤ 5 个）

- **业务价值**：插件接口最大风险是"接入点失控"——profile 一旦能在任意位置插逻辑，bundler 主流程就变成插件的奴隶，未来 merge ZeroDev 上游每次都要小心避让。**M2 一开始就把 hook 数封顶**，每个 hook 文档化、有 owner、未来加新 hook 必须是文档级评审。
- **必要性**：
  - fork 可持续性：hook 越少，merge 上游冲突越小
  - 可审计性：审计员只需看 5 个文件就能判断 fork 行为
  - 防止 profile 滥权：profile 不能在 5 个点之外影响 bundler
- **M2 hook 接入点全清单（共 5 个，写死，超过需 M3 重新评审）**：

  | # | 位置 | 调用的 profile 方法 | 数据流 | M2 实现 |
  |---|------|------------------|-------|--------|
  | H1 | `src/rpc/methods/eth_sendUserOperation.ts:addToMempoolIfValid` 入口 | `registry.getProfile(paymaster)` + `profile.isFastLane()` | 给 mempool entry 贴 `metadata.isFastLane = true` 和 `metadata.profileId` | 调用即可 |
  | H2 | `src/rpc/methods/boost_sendUserOperation.ts` 入口 | 同 H1（boost 路径也允许 Fast Lane，但 boost 路径要求 paymaster 为空，所以默认 `isFastLane = false`） | 同上 | 调用即可（结果总为 false） |
  | H3 | `src/mempool/mempool.ts` 出队循环（`popOutstanding` 之前的优先级判定） | 不调用 profile 方法——**只读 mempool entry 的 `metadata.isFastLane` 标记** | 由 store 暴露 `peekFastLane / popFastLane` 优先消费 | store 改造 + 出队循环加分支 |
  | H4 | `src/executor/executor.ts:calculateGasPrice` | `profile.feeOverride()` —— 仅当当前 bundle **全部** op 都是 Fast Lane 且 profile 一致时调用 | 覆盖 `maxFeePerGas` / `maxPriorityFeePerGas` | 加一个 if 分支 |
  | H5 | `src/executor/executorManager.ts` bundle 创建后立即提交 | 不调用 profile 方法——**只读 bundle metadata 的 `isFastLane` 总标记** | 跳过 batching 等待，直接发 tx | 加一个 if 分支提前出 loop |

  **超出范围的 hook（M2 明确不做）**：
  - simulation 阶段不挂 hook（不放宽 / 不收紧 ERC-7562 验证）
  - reputation manager 不挂 hook（throttled / banned 状态对 Fast Lane 同样生效）
  - postOp 不挂 hook（M2 不收费）
  - dropUserOps 不挂 hook（drop 策略对所有 op 一视同仁）
- **流程**：
  1. bundler 启动构造 Registry
  2. RPC 入队 H1/H2 调 `isFastLane` 打标
  3. mempool H3 按标优先出队
  4. executor H4/H5 按标改 fee + 提前提交
  5. 返回 userOpHash 给客户端，业务侧不感知 Fast Lane 存在（透明加速）
- **技术方案**：
  - 5 个 hook 在代码里加注释 `// HOOK H1: paymasterProfiles isFastLane lookup`，方便 grep + merge 上游时定位
  - 单元测试：每个 hook 写一个测试覆盖"profile 命中 / 未命中"两个分支
  - 验收：
    - grep `HOOK H[1-5]` 全 repo 必须正好 5 个匹配
    - PR 评审：任何新增 `HOOK H[6-9]` 必须文档级评审更新本表

---

## 3 · Fast-lane 三处核心实现

### 3.1 入口标记（H1 / H2）

- **业务价值**：标记必须在**最早的可能位置**贴上，否则后续 mempool / executor 阶段就要重复跑一遍 paymaster 提取 + lookup，浪费 CPU 还可能不一致（如 op 在 mempool 期间配置 reload，前后判定不同）。**入口标记一次定终身**——同一个 op 的 Fast Lane 状态在整个生命周期内不变。
- **必要性**：
  - 性能：mempool 出队、executor 计费各只读一个 boolean，O(1)
  - 一致性：op 不会"中途突然不是 Fast Lane 了"
  - 可观测性：日志里直接带 `isFastLane: true/false`，运维一眼分辨
- **流程**：
  1. RPC `eth_sendUserOperation` / `boost_sendUserOperation` 收到 op
  2. 在 `addToMempoolIfValid` 里、所有验证之后、`mempool.add` 之前：
     ```typescript
     // HOOK H1
     const profile = rpcHandler.paymasterRegistry.getProfile(
         extractPaymasterAddress(userOp)
     )
     const isFastLane = profile?.isFastLane({
         userOp,
         chainId: rpcHandler.config.chainId
     }) ?? false
     ```
  3. 把 `{ isFastLane, profileId }` 作为 `UserOpInfo.metadata` 传给 `mempool.add`
  4. 日志：`{ userOpHash, paymaster, isFastLane, profileId }`
- **技术方案**：
  - 改动位置：
    - `src/rpc/methods/eth_sendUserOperation.ts` —— H1，`addToMempoolIfValid` 加 lookup + 传入 metadata
    - `src/rpc/methods/boost_sendUserOperation.ts` —— H2，同 H1（实际总为 false 因为 boost 要求 paymaster 为空，但**保持代码对称**——避免未来加 boost+paymaster 混合路径时漏改）
    - `src/types/userop.ts` 或类似 —— `UserOpInfo` 增 optional `metadata: { isFastLane?: boolean; profileId?: string }`
    - `src/mempool/mempool.ts:add` —— 透传 metadata 到 store
    - `src/store/createMempoolStore.ts` —— `addOutstanding` 接受 metadata 字段
  - **不动**：验证逻辑、PVG 计算、reputation 校验、nonce 校验
  - 验收：
    - 单元测试：白名单内 paymaster ⇒ metadata.isFastLane === true
    - 单元测试：白名单外 paymaster ⇒ false
    - 单元测试：boost 路径 ⇒ false
    - e2e：日志看到正确标记

### 3.2 mempool 优先级队列（H3）

- **业务价值**：标记打上之后，mempool 出队顺序必须给 Fast Lane op 让路——否则前面有一堆普通 op 排队，Fast Lane op 等的时间和普通 op 一样长，"绿色"两字白叫。
- **必要性**：
  - Fast Lane 的"快"主要来自三件事：(a) 不等 batching；(b) 0 priority fee 不与人争；(c) **优先出队**——三者缺一不可
  - 出队优先 = mempool 数据结构改造 = M2 最大的代码改动点（但仍局限在 store 层 + mempool.ts 单文件）
- **流程**：
  1. bundler 构造下一个 bundle 时，循环 `popOutstanding`：
  2. **改造**：先调 `peekFastLane(entryPoint)` 看有没有 Fast Lane op；有 ⇒ `popFastLane`；无 ⇒ 退化到 `popOutstanding`
  3. **关键约束**：Fast Lane op **不与普通 op 同 bundle 混打**——同 bundle 全部 Fast Lane 或全部普通。理由：feeOverride 只对全 Fast Lane 的 bundle 生效（H4），混合 bundle 的 fee 策略无定义；且 Fast Lane 的"立即广播"语义要求 bundle 不等 batching
  4. Fast Lane bundle 满足以下任一条件即结束（不等 minOpsPerBundle）：
     - 当前 entryPoint 下没有更多 Fast Lane op
     - 达到 maxBundleCount
     - 达到 bundle gas 上限
- **技术方案**：
  - 改动位置：
    - `src/store/index.ts` —— store interface 加 `peekFastLane` / `popFastLane` 方法
    - `src/store/createMemoryOutstandingStore.ts` —— 内存实现：维护两个数组 `outstanding` + `outstandingFastLane`，`addOutstanding` 按 metadata 分流
    - `src/store/createRedisOutstandingStore.ts` —— Redis 实现：同样的双 list，key 带 `:fastlane` 后缀
    - `src/mempool/mempool.ts` —— 出队循环按 §3.2 流程改造（HOOK H3 注释）
  - **关键设计**：
    - Fast Lane 队列内部仍是 FIFO（不按 priority fee 二级排序——Fast Lane op 的 priority fee 都是 0，无意义）
    - Fast Lane bundle 与普通 bundle 各算各的 maxBundleCount——避免一笔 Fast Lane "吃掉" 普通 op 的配额
    - 普通 op 不会"饿死"：bundle creator 在每轮 `popFastLane` 之后下一轮 `popOutstanding` 仍照常进行；Fast Lane 不会无限爆量（受 trusted paymaster 自身合约的 minTxInterval 限制 §5）
  - **删除场景**：op 被 drop（reputation / 超时）⇒ 不论是否 Fast Lane 都从对应队列移除；`removeOutstanding` 接口需要能在两个队列里都找
  - 验收：
    - 单元测试：连续 add 5 普通 + 3 Fast Lane → 出队前 3 笔是 Fast Lane（任意顺序）→ 之后是普通
    - 单元测试：Fast Lane bundle 不与普通 op 混合
    - 单元测试：Fast Lane op 也走 reputation 校验、被 throttled 后从 Fast Lane 队列移除
    - e2e：OP-Sepolia 同时灌 1 笔 Fast Lane + 5 笔普通，Fast Lane 上链 tx index < 任何普通 op

### 3.3 executor fee 策略（H4 / H5）

- **业务价值**：0 priority fee 不只是省钱——是表明"我不与公共 mempool 抢 block 排序"。SuperPaymaster v3 业务里所有 op 的 gas 由 trusted paymaster 自己付，bundler 只需要 baseFee 就够上链；多付 priority fee 等于把 SuperPaymaster 的 aPNTs 储备烧给 block builder——纯亏损。
- **必要性**：
  - 业务必要：Fast Lane 的核心经济价值就是"免争抢"
  - 0 priority fee 在 OP 链（包括 OP-Sepolia / OP-Mainnet）天然可行——OP 出块顺序是 sequencer 时间戳排序，priority fee 不影响排序，0 同样会被打包
  - "立即广播"（H5）= bundler 不等 `bundleInterval` / `minOpsPerBundle` 凑批，bundle 一形成立即 sendTransaction
- **流程**：
  1. mempool 把 Fast Lane op 凑成 bundle 时，bundle 上整体打 `metadata.isFastLane = true`（同 §3.2，bundle 内 op 全是 Fast Lane）
  2. executor `calculateGasPrice` 检查 bundle metadata：
     - Fast Lane bundle ⇒ 调 `profile.feeOverride({ networkBaseFee, chainId })` 拿到 fee
     - 普通 bundle ⇒ 走原有 `bundlerInitialCommission` / `breakEvenGasPrice` 逻辑（M2 完全不动）
  3. executorManager 收到 Fast Lane bundle 后**跳过 batching 等待**（不等下一个 tick），立即 sendTransaction
- **技术方案**：
  - 改动位置：
    - `src/executor/executor.ts:calculateGasPrice` —— H4，加 if 分支：
      ```typescript
      // HOOK H4: Fast Lane fee override
      if (bundle.metadata?.isFastLane && bundle.metadata?.profileId) {
          const profile = this.paymasterRegistry.getById(bundle.metadata.profileId)
          if (profile) {
              return profile.feeOverride({
                  networkBaseFee,
                  chainId: this.config.chainId
              })
          }
          // profile 找不到 — 退化到普通策略 + warn 日志（不应发生，配置错误）
      }
      // ...原有逻辑
      ```
    - `src/executor/executorManager.ts` bundle creation loop —— H5，bundle 出来后查 metadata，是 Fast Lane 立即提交不等下一 tick
  - **关键约束**：
    - feeOverride 返回的 maxFeePerGas 仍要 ≥ networkBaseFee（OP 链节点会拒绝低于 baseFee 的 tx）——profile 实现里加保底 ε
    - resubmissionAttempts 累计后 fee 加价逻辑（原有 `bundle.submissionAttempts > 0` 分支）**对 Fast Lane 同样生效**：第一次 submit 用 feeOverride 的 fee，underpriced retry 时按原有 retry 倍数加价（避免 baseFee 突涨时 Fast Lane tx 卡住）
    - resubmit 时如果加价后超出 SuperPaymaster v3 的 `maxRate` 校验上限（合约里的 paymasterAndData rate commitment）⇒ tx 上链会被合约拒——这是 paymaster 合约自身保护，bundler 不需要预判
  - **不动**：
    - Arbitrum 分支（`chainType === "arbitrum"`，§3.3 §3.4 流程对 OP 链已足够）
    - legacyTransactions 分支（OP 是 EIP-1559，不走 legacy）
  - 验收：
    - 单元测试：Fast Lane bundle ⇒ `calculateGasPrice` 返回 priority=0
    - 单元测试：普通 bundle ⇒ `calculateGasPrice` 返回原逻辑结果
    - 单元测试：resubmit 第 1 次 ⇒ feeOverride * 120% (resubmissionMultiplier)
    - e2e on OP-Sepolia：实测 tx 链上 `effectiveGasPrice == baseFee`（可允许 +ε），`maxPriorityFeePerGas == 0`

---

## 4 · EIP-7702 完整实战

### 4.1 业务价值

- AirAccount 演进路径明确将 EIP-7702（Pectra 升级，OP-Mainnet 已支持）作为**EOA → smart wallet 平滑过渡**的核心通道：用户原生 EOA 通过 `SET_CODE_TX_TYPE = 0x04` + `authorizationList` **临时挂载** AirAccount implementation 代码，单笔 tx 内拥有 smart wallet 能力，tx 结束后 EOA 身份不变（authorization 不持久化）
- 对 M2 fast-lane 的直接业务价值：拓宽 sender 来源——白名单内 SuperPaymaster v3 paymaster 不仅能 sponsor 已部署 AirAccount sender，还能 sponsor 任意 EOA + EIP-7702 authorization 路径的 sender
- 对运营方的业务价值：拥抱"AirAccount 用户" + "原生 EOA 用户"两类客户群，无需要求 EOA 用户先部署合约钱包

### 4.2 必要性

- **fast-lane 业务必须前置考虑 EIP-7702 sender 路径**：M2 §3 入口标记（H1）、mempool 出队（H3）、executor fee 策略（H4）均不感知 sender 类型，但**`authorizationList` 字段必须正确透传到 estimate / simulation / handleOps 全链路**——否则 EIP-7702 op 在 fast-lane 路径上 estimate 通过但 simulation 失败、或 simulation 通过但 handleOps 上链失败
- bundler 在 PR #13 已经把 `authorizationList` 透传进 `eth_estimateGas` 的通路打通（`--rpc-gas-estimate` 模式），但**只覆盖 estimate 单元测试，没跑过端到端**——M2 必须补齐 simulation 路径 + handleOps 提交路径，并在 OP-Mainnet 真链上做 fast-lane EIP-7702 e2e
- 不在 M2 做 = M3 / 后续要把"fast-lane 通路"和"EIP-7702 通路"分两次集成，会引入回归风险（fast-lane mempool / executor 变更后 EIP-7702 路径需要重测）

### 4.3 流程

1. **客户端构造**：
   - sender = EOA 地址
   - `authorizationList: [{ chainId, address: <AirAccount-impl-addr>, nonce, signature }]`（v0.7 schema 扩展位）
   - paymaster = SuperPaymaster v3 (在 §1 trusted-paymasters 白名单内)
2. **bundler `eth_sendUserOperation` 入口**：
   - §3.1 H1 标记 `metadata.isFastLane = true`（paymaster 命中白名单）
   - schema 校验：`authorizationList` 字段格式正确
3. **estimate 路径**（PR #13 已实现）：
   - `eth_estimateUserOperationGas` 调 `eth_estimateGas` 时，`authorizationList` 透传给 RPC provider
4. **simulation 路径**（M2 补齐）：
   - validation 阶段调 `debug_traceCall` 时，`authorizationList` 必须随 call 参数一同传递
   - safe-mode tracer 对 EIP-7702 sender 同样跑 ERC-7562 opcode/storage 限制——authorization 临时挂的 wallet code 同样受约束
5. **mempool 出队 + bundle 构造**（§3.2/§3.3 不变）：
   - Fast-lane bundle 包含 EIP-7702 op 时，bundle metadata 透传 `authorizationList` 到 executor
6. **handleOps tx 提交**（M2 补齐）：
   - executor `sendTransaction` 必须用 `SET_CODE_TX_TYPE = 0x04`，tx 携带 `authorizationList`
   - executor wallet 用 viem `writeContract` / `sendTransaction` 时显式带 `authorizationList` 参数
7. **上链验证**：
   - 区块浏览器显示 tx type = 0x04
   - UserOp 执行成功（authorization 在 handleOps 期间临时生效，EOA 在 tx 后仍是 EOA）

### 4.4 技术方案

- **代码基础**（已有）：
  - PR #13 已实现 estimate 路径透传：`src/executor/filterOpsAndEstimateGas.ts:116-134`（`--rpc-gas-estimate` 模式下 `authorizationList` 注入 `estimateGas` call）
  - viem >= 2.18 已原生支持 `sendTransaction({ authorizationList })`
- **M2 补齐项**：
  - **simulation 路径**：`src/rpc/validation/SafeValidator.ts` / `UnsafeValidator.ts` 调 `debug_traceCall` 时检查是否带 `authorizationList` 字段；缺失则在含 `authorizationList` 的 op 上**fail-fast 而非静默忽略**
  - **handleOps 路径**：`src/executor/executor.ts:sendBundle`（或等价位置）调 `sendTransaction` 时显式透传 `bundle.authorizationList`（按 bundle 所含 op 聚合）
  - **bundle 聚合规则**：fast-lane bundle 内若有 EIP-7702 op，bundle 整体走 SET_CODE_TX；同 bundle 内**不混 EIP-7702 op 和非 EIP-7702 op**（约束类似 §3.2 fast-lane / 普通不混合）
- **配置**：
  - `--eip7702-enabled true|false`（默认 true，按链关——OP-Mainnet/OP-Sepolia 默认开）
  - 与 `--rpc-gas-estimate` 配合：rpc-gas-estimate 模式下 PR #13 路径生效；非 rpc-gas-estimate 模式 M2 也要保证 simulation/handleOps 路径透传
- **e2e 验收**：
  - 测试位置：`e2e/m2-eip7702.test.ts`（新增）
  - 真实场景：在 OP-Mainnet（fork 或灰度）跑一笔 fast-lane EIP-7702 UserOp
    - sender = 测试 EOA
    - authorization 指向已部署的 AirAccount implementation
    - paymaster = SuperPaymaster v3 OP-Mainnet 地址（白名单内）
    - 期望：bundler 日志 `{ isFastLane: true, profileId: "superpaymaster-v3", eip7702: true }`；上链 tx type = 0x04；UserOpEvent success = true
  - 边界 case：
    - authorizationList 缺失 → bundler 仅按普通 v0.7 op 处理（不影响普通路径）
    - authorization signature 无效 → simulation reject，op drop，不上链
    - RPC provider 不支持 `authorizationList` 字段 → bundler 启动 fail-fast 提示用户切支持的 provider（Alchemy / QuickNode 已支持）
  - 联合验收：与 AirAccount 团队共同执行——他们提供 wallet implementation 部署地址和测试 EOA 私钥；我们跑 bundler 端

---

## 5 · 安全分析

### 5.1 安全三层（M2 信任模型）

- **业务价值**：把"为什么允许某些 op 走 Fast Lane 是安全的"写成可审计的论证。审计员、运营方、合作 paymaster 团队、未来的我们自己——任何人质疑 Fast Lane 安全性时，能直接指向本节回答。
- **必要性**：
  - Fast Lane 是 fork 引入的非标准能力，必须有显式安全模型
  - 没有这一节，下一个 reviewer 会自然怀疑"是不是放宽了 ERC-4337 的某项保护"
- **三层防御**（M2 实际启用的全部安全机制，按顺序触发）：

  **第一层：运营白名单（链下）**
  - 只有 §1 trusted-paymasters 配置中的地址才走 Fast Lane
  - 白名单变更走 PR + 配置文件版本化 + reload 日志审计
  - 信任假设：运营方知道自己白名单了什么 paymaster；新增 paymaster 必经过运营方 KYC（如 SuperPaymaster v3 是 AAStar 自家合约，本身就是受信主体）

  **第二层：标准 ERC-4337 simulation（链上 + 链下 tracer）**
  - **完全不放宽**：safe 模式 ERC-7562 tracer 一律照跑（opcode 限制、storage 访问限制、外部合约调用限制）
  - paymaster 合约里任何违规（GAS opcode、SELFDESTRUCT、跨账户 storage 写）—— Fast Lane op 同样被拒
  - reputation manager 同样生效：throttled / banned 的 paymaster 即使在白名单里也按 reputation 处理（不出队）
  - PVG 校验、nonce 校验、签名校验—— Fast Lane op 同样跑

  **第三层：SuperPaymaster 合约自身的 sponsorship 资格门槛（链上）**
  - SuperPaymaster v3 在 `validatePaymasterUserOp`（[SuperPaymaster.sol:725](../../SuperPaymaster/contracts/src/paymasters/superpaymaster/v3/SuperPaymaster.sol#L725)）里强制：
    - **operator 配置门槛**：`operators[operator].isConfigured` 必须 true（[行 737](../../SuperPaymaster/contracts/src/paymasters/superpaymaster/v3/SuperPaymaster.sol#L737)）
    - **operator 未暂停**：`!config.isPaused`（[行 747](../../SuperPaymaster/contracts/src/paymasters/superpaymaster/v3/SuperPaymaster.sol#L747)）
    - **用户资格双通道**：`isEligibleForSponsorship(userOp.sender)` —— 必须是 SBT 持有者 OR 注册 ERC-8004 Agent（[行 752, 1010-1012](../../SuperPaymaster/contracts/src/paymasters/superpaymaster/v3/SuperPaymaster.sol#L752)）
    - **用户未被屏蔽**：`!userState.isBlocked`（[行 760](../../SuperPaymaster/contracts/src/paymasters/superpaymaster/v3/SuperPaymaster.sol#L760)）
    - **rate limit**：`config.minTxInterval` 强制（[行 766-772](../../SuperPaymaster/contracts/src/paymasters/superpaymaster/v3/SuperPaymaster.sol#L766)，靠 `validAfter` 实现）
    - **operator aPNTs 余额充足**：覆盖 maxCost + 协议费 + 10% 验证 buffer（[行 794](../../SuperPaymaster/contracts/src/paymasters/superpaymaster/v3/SuperPaymaster.sol#L794)）
  - **bundler 不重复检查这些**——合约自己拒，bundler 看到 simulation revert 直接 drop op 即可
- **流程**：
  1. op 进来 → §3.1 入口标记是否 Fast Lane（第一层：白名单决定优先级）
  2. op 走标准 simulation（第二层：ERC-7562 tracer 一律跑）
  3. simulation 调 SuperPaymaster.validatePaymasterUserOp（第三层：合约自身资格门槛）
  4. 三层全过 → 入 mempool（Fast Lane 队列或普通队列）
  5. 出队、打包、上链
- **技术方案**：
  - **不写新代码** —— 三层防御全部已存在
  - 文档化：本节内容独立成 `docs/SECURITY_M2.md`，作为审计入口
  - 验收：见 §7.3

### 5.2 不放宽 ERC-7562 验证规则

- **业务价值**：保持 bundler 协议合规——bundler-spec-tests 全套照过，eth-infinitism 任何审计能直接通过。
- **必要性**：
  - 一旦放宽，bundler 就脱离"标准 ERC-4337 bundler"身份，无法宣称合规
  - 放宽 ERC-7562 等于把 paymaster 合约的安全责任转嫁给运营方人工审核——风险面失控
- **流程 / 技术方案**：
  - safe 模式 tracer ([src/rpc/validation/SafeValidator.ts](../src/rpc/validation/SafeValidator.ts)) 对所有 op 一视同仁，**不区分 Fast Lane / 普通**
  - **关键依据**：SuperPaymaster v3.6 已在合约层面规避了 ERC-4337 banned opcode 问题：
    - 注释见 [SuperPaymaster.sol:702](../../SuperPaymaster/contracts/src/paymasters/superpaymaster/v3/SuperPaymaster.sol#L702)：`V3.6 FIX: Remove TIMESTAMP check here to avoid Banned Opcode AA33. Staleness is enforced via validUntil signal in validatePaymasterUserOp`
    - 即 SuperPaymaster v3.6 自己已经把"价格陈旧检查"从 validation 阶段移除，改用 `_packValidationData` 的 `validUntil` 信号让 EntryPoint 处理——这正好是 ERC-4337 标准做法
  - 因此 SuperPaymaster v3 走 Fast Lane **不需要任何 tracer 例外**，bundler 一行验证规则不动
  - 验收：spec-tests 在加了 §1-§3 改动后仍 100% 通过（M1 §6 验收表第 1.6 项的延续）

### 5.3 Sybil / DDoS 在 M2 上下文

- **业务价值**：Fast Lane 听起来像"快通道 = 容易被滥用 = Sybil 攻击放大器"——本节正面回应，说明 M2 的反 Sybil / DDoS 机制依然完整。
- **必要性**：审计 / 红队的标准质疑点
- **威胁模型 + 缓解**：

  | 威胁 | M2 是否有放大风险 | 缓解措施 |
  |------|----------------|---------|
  | 恶意用户对 Fast Lane 灌大量 op | 不放大 | (a) Fast Lane 标记本身不绕过任何验证；(b) SuperPaymaster v3 的 `minTxInterval` 限制每用户每秒最多 1 笔（[行 766](../../SuperPaymaster/contracts/src/paymasters/superpaymaster/v3/SuperPaymaster.sol#L766)）；(c) `isEligibleForSponsorship` 要求 SBT 或 Agent NFT，新建账号无法立即获得资格（[行 1010](../../SuperPaymaster/contracts/src/paymasters/superpaymaster/v3/SuperPaymaster.sol#L1010)）|
  | 恶意 paymaster 假冒 SuperPaymaster | 不可能 | profile addresses 里写死 SuperPaymaster v3 实际部署地址；攻击者无法伪造同地址（除非攻破 EOA owner key 重新部署，但那是上游合约层威胁） |
  | bundler 节点被打满 RPC | 不放大（与普通路径相同） | M1 §4.1 加的 `@fastify/rate-limit` 同样作用于 Fast Lane 入口（按 IP 限流） |
  | Fast Lane op 把普通 op 挤到饿死 | 限定不会 | mempool 是双队列、不是优先级权重；普通 op 出队循环正常进行；且 Fast Lane 上限受 SuperPaymaster `aPNTsBalance` 限制（合约层面发不出来更多 op） |
  | bundler 运营方误把恶意地址加进白名单 | 风险存在 | (a) 配置 PR + 多人评审；(b) reload 日志审计；(c) 白名单 paymaster 所有 op 仍走标准 simulation，最坏情况是恶意 paymaster 拒所有 op（DoS 自己），不会污染其他 paymaster |

- **流程 / 技术方案**：
  - **核心论断**：Fast Lane 不放过任何 op——"在白名单 + 通过 simulation + 通过 SuperPaymaster 自身校验"才会被打包；只是**打包顺序**和**fee 策略**不同
  - **第二核心论断**：SuperPaymaster v3 的 SBT / Agent NFT 资格门槛是**主防线**——攻击者要刷 op 必先取得 SBT，那就走另一个反 Sybil 战场（ERC-8004 Agent registry 自身的 reputation 系统）
  - 验收：见 §7.3

---

## 6 · （可选）双因子识别 — trusted-account-implementations

### 6.1 双因子方案

- **业务价值**：方案 A（仅看 paymaster 地址）足够 M2 落地，但理论上有一种边缘场景：恶意 sender 发起带 SuperPaymaster paymaster 的 op，希望蹭 Fast Lane（虽然 SuperPaymaster 合约自己会拒，但 bundler 入口已经把 op 标成 Fast Lane 了，意味着这种 op 短暂占用 Fast Lane 队列资源直到 simulation 拒掉）。**双因子识别**额外检查 sender 是否已知钱包实现（如 AirAccount v7），从源头降噪。
- **必要性**：
  - **M2 不强制**——边缘场景实际影响小（SuperPaymaster simulation 阶段就会把这种 op 拒掉，Fast Lane 队列里待的时间 < 1 秒）
  - 提案纳入 §6 是为了把"未来想法"明确成"已评估、已决定推 M3"，避免下次 review 时重新讨论
- **流程**：
  1. profile 接口扩展（M3 引入）：`trustedAccountImplementations: Hex[]` 字段——已知钱包 implementation 字节码 hash
  2. RPC 入口除了查 paymaster，再查 sender 的 implementation：`eth_getCode(sender)` → keccak256 → 命中列表 ⇒ 双因子通过
  3. 双因子未通过 ⇒ 仍允许走 Fast Lane（向后兼容），但日志 warn `{ reason: "unknown_account_implementation" }`
  4. 严格模式（M3 配置开关）：未通过 ⇒ 退化到普通路径
- **技术方案 / trade-off**：
  - **成本**：每笔 op 多一次 `eth_getCode` RPC 调用——可缓存（sender 部署后 implementation 极少变），但缓存层是新基础设施
  - **收益**：把 Fast Lane "白名单 paymaster" 收紧到 "白名单 paymaster + 已知钱包" 双重交集，攻击面更小
  - **决策**：**M2 不做**。理由：
    - 增加配置面（profile 接口扩展、缓存层、严格模式开关）
    - 实际防御收益小（边缘场景）
    - SuperPaymaster v3 自己已经通过 `isEligibleForSponsorship` 在 sender 维度做了 Sybil 防御（SBT/Agent），双因子是重复防线
  - **何时触发 M3 重新评估**：
    - 出现真实滥用案例（运营方观察到 Fast Lane 队列被恶意 op 短暂占用）
    - 引入第二个 trusted paymaster，且该 paymaster 自身没有 sender 维度防御
- 验收：M2 不验收，仅文档化决策依据

---

## 7 · 验收

### 7.1 单元测试：isFastLane 判定矩阵

- **业务价值**：核心判定函数错一个字符就可能导致全量 op 被错误标记 / 全量错过 Fast Lane。判定矩阵必须穷举。
- **必要性**：M2 最高风险点
- **流程 / 技术方案**：
  - 测试位置：`src/paymasterProfiles/superpaymaster-v3/index.test.ts`
  - 测试矩阵（至少覆盖以下 case，每条期望值明确）：

    | # | userOp paymaster 字段 | chainId | 期望 isFastLane |
    |---|---------------------|---------|---------------|
    | 1 | SuperPaymaster v3 OP-Sepolia 地址 | 11155420 | true |
    | 2 | SuperPaymaster v3 OP-Mainnet 地址 | 10 | true |
    | 3 | SuperPaymaster v3 OP-Sepolia 地址 | 10 | false （地址 / 链不匹配）|
    | 4 | 任意未知 paymaster 地址 | 11155420 | false |
    | 5 | `paymaster = "0x"`（v0.7 空字段） | 11155420 | false |
    | 6 | `paymasterAndData = "0x"`（v0.6 空字段） | 11155420 | false |
    | 7 | SuperPaymaster v3 地址但**不在 §1 白名单**（profile 知道但运营没批） | 11155420 | false （via Registry） |
    | 8 | v0.6 op，paymasterAndData 含 SuperPaymaster v3 地址 + 额外 data | 11155420 | true |
    | 9 | v0.7 op，paymaster 字段大小写不一（checksum 形态 / 全小写） | 11155420 | true（`toLowerCase` 比较）|
    | 10 | v0.8 op | 11155420 | 同 v0.7 行为 |
  - 验收：CI 跑 `pnpm test` profile 测试套件 100% 通过

### 7.2 e2e on OP-Sepolia

- **业务价值**：单元测试无法验证三件事：(a) Fast Lane op 真的优先出队；(b) 链上 tx 真的 priority fee = 0；(c) 立即广播真的发生（不等 batching）。这三条只能在 OP-Sepolia 实测。
- **必要性**：M2 上 OP-Mainnet 的硬性前置条件
- **流程**：
  1. 准备：
     - bundler 配置 `--trusted-paymasters-file ./trusted-paymasters.json`（含 SuperPaymaster v3 OP-Sepolia 地址）
     - bundler `--bundle-mode auto` + `--bundler-interval 5000`（auto 模式 5 秒一打——立即广播会跳过这个等待）
  2. 测试用例 A：**单笔 Fast Lane op**
     - 客户端用真实 SuperPaymaster v3 + xPNTs 钱包（SBT 持有者）发一笔 op
     - 期望：bundler 在 < 1 秒内 sendTransaction（不等 5 秒 interval）
     - 链上验证：tx 的 `maxPriorityFeePerGas == 0`、`effectiveGasPrice ≈ baseFee`
     - 日志验证：`{ isFastLane: true, profileId: "superpaymaster-v3" }`
  3. 测试用例 B：**Fast Lane vs 普通混合提交**
     - 同时灌：5 笔普通 op + 1 笔 Fast Lane op
     - 期望：Fast Lane op 上链 block number ≤ 任何普通 op 上链 block
     - 期望：两个 bundle，Fast Lane bundle 在前
  4. 测试用例 C：**resubmit 场景**
     - 提交 1 笔 Fast Lane op，模拟 baseFee 突涨（在 anvil fork 上手动调）
     - 期望：bundler retry 时 maxFeePerGas 加 20%，仍保持 priority=0
- **技术方案**：
  - 测试代码：`e2e/m2-fast-lane.test.ts`（新文件）
  - 使用 viem 客户端 + 真实 OP-Sepolia RPC
  - 使用一个预部署的 SuperPaymaster v3 OP-Sepolia 实例 + 一个测试 SBT 持有者钱包
- 验收：三个测试用例全部通过 + 至少 24h 灰度无误判

### 7.3 安全测试

- **业务价值**：Fast Lane 不破坏 §5 三层防御的证据
- **必要性**：审计依据
- **流程 / 技术方案**：
  - 测试 1：**白名单外 paymaster 走标准路径**
    - 配置：`--trusted-paymasters 0xAddrA`
    - 提交：`paymaster = 0xAddrB` 的 op
    - 期望：bundler 日志 `isFastLane: false`，op 走原有 mempool 普通队列
  - 测试 2：**恶意 op 被 SuperPaymaster 拒绝时 bundler 不重试**
    - 提交：sender 不是 SBT 持有者的 op（`isEligibleForSponsorship == false`）
    - 期望：simulation 阶段 SuperPaymaster.validatePaymasterUserOp 返回 sigFailed
    - 期望：bundler `dropUserOps` 调用、日志 `{ reason: "AA34 signature error", paymaster: "0x..." }`
    - 期望：op **不进 Fast Lane 队列**也不进普通队列、不重试
  - 测试 3：**reputation throttled paymaster 即使在白名单也被限流**
    - 用 debug 接口手动把 SuperPaymaster paymaster 的 reputation 设为 throttled
    - 提交多笔 Fast Lane op
    - 期望：mempool 出队按 throttled limit 限流（最多 `throttledEntityBundleCount = 4` 笔）
  - 测试 4：**ERC-7562 tracer 对 Fast Lane op 同样生效**
    - 部署一个故意违规的测试 paymaster（如在 validation 中 SLOAD 别人 storage），加进白名单
    - 提交 op
    - 期望：safe 模式下 tracer 拒绝，op drop
  - 验收：4 个测试用例全部通过

---

## 8 · 验收检查表（最终签字依据）

| # | Feature | 类型 | 验收方式 | 状态 |
|---|---------|------|---------|------|
| 1.1 | `--trusted-paymasters` CLI flag | 配置 | 单元测试 + 启动日志 | ☐ |
| 1.2 | `--trusted-paymasters-file` 配置文件 | 配置 | 单元测试 + Zod schema 校验 + 多链 e2e | ☐ |
| 1.3 | SIGHUP 热更（admin endpoint 推 M3） | 配置 | 单元测试 + `kill -HUP` 灰度 | ☐ |
| 2.1 | `PaymasterProfile` interface 定义 | 插件 | 类型检查 + 接口文档化 | ☐ |
| 2.2 | profile 注册器（双重交集逻辑） | 插件 | 单元测试覆盖三种 case | ☐ |
| 2.3 | SuperPaymaster v3 profile 实现 | 插件 | 单元测试 §7.1 矩阵 100% 通过 | ☐ |
| 2.4 | hook 接入点严格 5 个 | 插件 | `grep -c "HOOK H[1-5]"` 全 repo == 5 | ☐ |
| 3.1 | RPC 入口标记 H1/H2 | 核心 | 单元测试 + 日志 metadata.isFastLane | ☐ |
| 3.2 | mempool 双队列 H3 + 不混合 bundle | 核心 | 单元测试出队顺序 + e2e | ☐ |
| 3.3 | executor feeOverride H4 + 立即广播 H5 | 核心 | 单元测试 + e2e 链上验证 priority=0 | ☐ |
| 4.1 | EIP-7702 业务价值与必要性文档化 | 协议 | 文档评审通过 | ☐ |
| 4.2 | EIP-7702 estimate 路径透传（PR #13） | 协议 | 已合并 + 单元测试覆盖 | ☐ |
| 4.3 | EIP-7702 simulation 路径透传 | 协议 | `debug_traceCall` 带 `authorizationList` 单元测试 | ☐ |
| 4.4 | EIP-7702 handleOps 路径透传 | 协议 | executor `sendTransaction` 带 `authorizationList` + tx type 0x04 | ☐ |
| 4.5 | EIP-7702 fast-lane e2e on OP-Mainnet | 协议 | 真链跑通 + 区块浏览器 type 0x04 + AirAccount 联合验收 | ☐ |
| 5.1 | 三层安全防御文档 (`docs/SECURITY_M2.md`) | 安全 | 审计员 review 通过 | ☐ |
| 5.2 | 不放宽 ERC-7562 验证 | 安全 | spec-tests 在 M2 改动后仍 100% 通过 | ☐ |
| 5.3 | Sybil/DDoS 缓解机制矩阵 | 安全 | 安全测试 §7.3 4 个用例通过 | ☐ |
| 6.1 | 双因子识别评估文档化 | 文档 | 决策记录纳入本文 §6 | ☐ |
| 7.1 | isFastLane 单元测试矩阵 | 测试 | 10 个 case 100% 通过 | ☐ |
| 7.2 | OP-Sepolia e2e 三个用例 | 测试 | 单笔 / 混合 / resubmit 全过 | ☐ |
| 7.3 | 安全测试 4 个用例 | 测试 | 全过 | ☐ |
| J | OP-Sepolia 灰度 1 周 | 部署 | 至少 50 笔 Fast Lane op 上链、0 误判 | ☐ |
| K | OP-Mainnet 上线 | 部署 | 灰度 N 笔 SuperPaymaster v3 + xPNTs op | ☐ |

---

## 9 · M2 输出物清单

### 代码改动

新增：
- `src/paymasterProfiles/types.ts` —— `PaymasterProfile` interface
- `src/paymasterProfiles/index.ts` —— 静态注册聚合 + Registry 类
- `src/paymasterProfiles/superpaymaster-v3/index.ts` —— SuperPaymaster v3 profile
- `src/paymasterProfiles/superpaymaster-v3/index.test.ts` —— §7.1 判定矩阵
- `src/cli/config/loadTrustedPaymasters.ts` —— 配置文件解析 + CLI 合并
- `src/utils/extractPaymaster.ts` —— v0.6/v0.7/v0.8 通用 paymaster 地址提取工具
- `e2e/m2-fast-lane.test.ts` —— §7.2 e2e
- `e2e/m2-security.test.ts` —— §7.3 安全测试
- `e2e/m2-eip7702.test.ts` —— §4 EIP-7702 fast-lane e2e on OP-Mainnet

修改：
- `src/cli/config/options.ts` —— 加 `--trusted-paymasters` / `--trusted-paymasters-file` / `--admin-enabled` / `--fast-lane-fee-tolerance` 系列 flag
- `src/createConfig.ts` —— 注入 `trustedPaymasters` + `paymasterRegistry` 到 `AltoConfig`
- `src/cli/main.ts` —— SIGHUP handler 注册
- `src/rpc/methods/eth_sendUserOperation.ts` —— **HOOK H1**
- `src/rpc/methods/boost_sendUserOperation.ts` —— **HOOK H2**
- `src/types/userop.ts`（或 `UserOpInfo` 定义所在文件） —— `metadata: { isFastLane?, profileId? }` optional
- `src/store/index.ts` —— interface 加 `peekFastLane` / `popFastLane`
- `src/store/createMemoryOutstandingStore.ts` —— 双队列实现
- `src/store/createRedisOutstandingStore.ts` —— Redis 双 list 实现
- `src/store/createMempoolStore.ts` —— `addOutstanding` 透传 metadata
- `src/mempool/mempool.ts` —— **HOOK H3**：出队循环加 Fast Lane 优先 + bundle 不混合
- `src/executor/executor.ts` —— **HOOK H4**：calculateGasPrice 加 Fast Lane 分支
- `src/executor/executorManager.ts` —— **HOOK H5**：Fast Lane bundle 立即广播

### 配置

- `trusted-paymasters.json`（仓库 root 示例文件）—— 含 OP-Sepolia + OP-Mainnet 两条 SuperPaymaster v3 entry，运营方按场景修改
- `trusted-paymasters.schema.json` —— JSON schema for IDE 智能提示

### 文档

新增：
- `docs/M2_DESIGN.md` —— 本文件
- `docs/PAYMASTER_PROFILES.md` —— 插件开发指南（如何写一个新 profile）
- `docs/SECURITY_M2.md` —— §5 安全分析独立成文，作为审计入口

更新：
- `docs/FORK_DELTA.md` —— 增加 M2 增量条目（trusted-paymasters 配置 / paymasterProfiles 插件骨架 / Fast Lane 5 个 hook）
- `docs/CHAIN_CONFIG.md` —— 每条目标链推荐的 trusted-paymasters 地址和 fast-lane-fee-tolerance

不动：
- 所有 M1 章节涉及的代码（rate limit、上游同步治理、协议核心方法）
- `src/rpc/validation/*` —— 不动 ERC-7562 tracer 一行
- `src/mempool/reputationManager.ts` —— reputation 对 Fast Lane 同样生效，不需改
- `src/handlers/*` —— gas oracle 不动
- 任何合约 —— bundler 不出合约改动；SuperPaymaster v3 协调放 M3

---

## 10 · M2 → M3 切换条件

满足以下**全部**条件后，关闭 M2，启动 M3 设计稿：

1. M2 §8 验收检查表全部打钩
2. OP-Sepolia 灰度 ≥ 1 周稳定运行：
   - Fast Lane op 上链 ≥ 50 笔
   - 0 误判事件（普通 op 被错误打 Fast Lane 标 / Fast Lane op 被错误走普通路径）
   - 无安全事件（恶意 paymaster 加白、Fast Lane 路径漏过任何 simulation）
3. OP-Mainnet 灰度 N 笔 SuperPaymaster v3 + xPNTs UserOp 全部成功上链
4. 运营方至少做过一次配置 reload（SIGHUP 验证生产可用）
5. SuperPaymaster v3 团队确认合约层无需为 Fast Lane 做任何修改（M2 没有任何 attestation / signaling 协调，确认这一假设成立）

**M3 预定范围**（此处仅占位提示，正式 M3 设计稿由独立文档定义）：
- X402 收费链路（xPNTs / aPNTs 计费走 SuperPaymaster `settleX402Payment`）
- attestation 方案 C（SuperPaymaster 合约暴露 attestation，bundler 改为链上信任绑定，移除运营白名单依赖）
- 双因子识别（§6 trusted-account-implementations）
- admin endpoint reload（§1.3 推后部分）
- 监控告警 webhook（utility wallet 余额、Fast Lane 队列长度、误判率）
- 上游同步自动化（M1 §4.2 的手动流程升级为 GitHub Actions）

M3 设计文档在 M2 验收完成且生产灰度 1 周后开写。
