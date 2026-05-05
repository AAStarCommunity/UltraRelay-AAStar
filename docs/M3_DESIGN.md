# UltraRelay-AAStar · M3 产品设计

> **里程碑定位**：M3 = "**对外开放 + 收费 + 运维成熟**"。M2 完成绿色通道（trusted-paymasters 白名单 + fast-lane 协议核心 + EIP-7702 完整实战）后，bundler 在内部生态闭环已经跑通；M3 把 bundler 升级为**面向公网开放、可计费、可观测、可水平扩展的生产级服务**。具体覆盖四大块：(A) 对外收费通道（X402 / xPNTs 预存 / ETH 预存）；(B) 运维基础设施成熟化（监控告警 webhook / Prometheus + Grafana / 上游同步自动化 / RPC 成本治理）；(C) 协议演进（Operator attestation / postOp gas 精算）；(D) 横向扩展（多链 / 多实例 / 灰度部署）。
>
> **不在 M3**：bundler 内置 paymaster 业务逻辑（永远不在 bundler，由 SuperPaymaster 负责）；UserOp 级别的链上隐私保护；自研聚合器 / mev-share 集成；非 EVM 链支持；自营算力托管控制面（Web 控制台、计费 dashboard 全功能版）。
>
> **当前状态**：M1 已交付协议核心 + 公网最低安全门槛 + 上游同步治理铺路；M2 已交付 trusted-paymasters 白名单、fast-lane 通道、operator attestation 协议位（占位）。M3 是把"开放收费"和"生产高可用"两条腿同时补齐——任何一条腿先上都会被另一条腿卡住（开放了但运维没成熟会被打挂；运维成熟了但收费没接通无法验证 SLA 与商业模式）。
>
> **依赖前提**：
> - M1 全部验收完毕（协议合规 + rate limit + 上游同步治理）
> - M2 全部验收完毕（trusted-paymasters 白名单 + fast-lane）
> - SuperPaymaster v3 在目标链已部署且 postOp 计费稳定
> - xPNTs 社区 token 在目标链已部署且 community owner 配合调用 `addAutoApprovedSpender(bundlerAddr)`

---

## 0 · M3 验收顺序

M3 范围广，按"先收费通道再运维再协议演进再横向扩展"四阶段推进。每阶段必须前置阶段完成且无回归。

1. **阶段 A：收费通道**（A.1 → A.2 → A.3 → A.4）
   - 先 X402 协议层（A.1），跑通 HTTP 402 握手回路
   - 再 xPNTs 预存收款（A.2），与 trusted-paymasters 白名单互斥规则验证
   - 备选 ETH 预存（A.3）做 trade-off 评估，按需启用
   - SDK 集成示例（A.4）作为对外接入文档
2. **阶段 B：运维成熟**（B.1 → B.2 → B.3 → B.4 并行可行）
   - B.1 监控告警 webhook（运维硬门槛，先做）
   - B.2 Grafana dashboard 完整化
   - B.3 上游同步自动化（GitHub Action）
   - B.4 RPC 成本治理（getLogs cache + receiptCache 暴露 + 调用计数）
3. **阶段 C：协议演进**（C.1 → C.2）
   - C.1 Operator attestation in paymasterAndData（跨仓库协调，需 SP / AirAccount 团队同步发版）
   - C.2 postOp gas 精算（仅外部 X402 用户受益，明确写"内部 fast-lane 无收益"）
4. **阶段 D：横向扩展**（D.1 → D.2 → D.3）
   - D.1 多链上线（Linea / Scroll / Base，按链入 `docs/CHAIN_CONFIG.md`）
   - D.2 多实例水平扩展（复用 M1 已支持的 Redis 共享 mempool）
   - D.3 灰度 / canary 部署流程

每阶段产出验收报告（写入 `docs/M3_ACCEPTANCE.md`），全部打钩后 M3 签字关闭。

---

## 部分 A · 收费通道

> M3 的核心商业逻辑：bundler 不再只服务白名单内的 SuperPaymaster fast-lane 用户，**对所有非白名单 UserOp 开放收费通道**。收费通道必须满足三个原则：
> 1. **协议标准**：用 Coinbase x402 业界标准，不自创协议
> 2. **互斥**：白名单内（fast-lane）免费 + 不收 X402；白名单外才走 X402——避免双重收费
> 3. **多种支付资产**：xPNTs（生态首选）+ ETH（备选）双通道，用户按场景选

### A.1 X402 收费协议（HTTP 402 Payment Required）

- **业务价值**：bundler 一旦对外开放，必须有标准化的"收费握手"协议——客户端首次提交 → bundler 返回 402 + 明码标价 → 客户端付款 → 重发带支付凭证 → bundler 受理。Coinbase 的 x402 标准已被 OpenAI / Anthropic / 多家 AI agent 服务采用，作为"AI 调链上服务"的支付层事实标准。我们采用 x402 而非自创协议，可以让任何已实现 x402 的 SDK / agent 框架零适配接入。
- **必要性**：
  - 没有 X402，bundler 没法对白名单外的 op 收费——要么白送（utility wallet 烧钱），要么全部拒绝（关闭对外开放）
  - 没有标准化协议，每个客户端都要为我们做特殊适配，等于把生态合作方挡在门外
  - x402 与 HTTP 标准 status code 402 完全兼容，任何 HTTP 客户端都能解析
- **流程**：
  1. 客户端调 `POST /rpc` 提交 `eth_sendUserOperation(userOp, entryPoint)`
  2. bundler 进入收费判定：
     a. 解析 `userOp.paymaster`（v0.7）或 `paymasterAndData`（v0.6）
     b. 若 paymaster ∈ trusted-paymasters 白名单（M2 已加载）→ 走 fast-lane，不收费，跳过 X402
     c. 若 `userOp.paymaster == 0` 且 `boost == false` 且 `maxFeePerGas > 0` → 标准 ERC-4337 流程（用户自付 gas），不收费，跳过 X402
     d. 若 paymaster 为 0 且走 boost 路径 → bundler 垫 ETH，**必须收费**
     e. 若 paymaster 不在白名单 → bundler 不愿意承担其失败风险（reputation 损耗），**必须收费**
  3. **收费场景**触发时，bundler 不立即处理 op，而是返回 HTTP 402：
     ```http
     HTTP/1.1 402 Payment Required
     Content-Type: application/json
     X-Payment-Required: {"version":"x402/1","accepts":[
       {"scheme":"erc20","token":"0x<xPNTsAddr>","amount":"<wei>","recipient":"0x<bundlerAddr>","chainId":10},
       {"scheme":"deposit","mode":"eth","amount":"<wei>","recipient":"0x<PrepaidGasAddr>","chainId":10}
     ],"nonce":"<requestNonce>","expiresAt":<unix>}

     {"jsonrpc":"2.0","error":{"code":-32402,"message":"Payment required","data":{...}},"id":<reqId>}
     ```
  4. 客户端选一种支付方式：
     - **xPNTs 预存**（A.2）：客户端无需现场转账，bundler 内部记账扣余额；客户端在请求 header 带 `X-Payment-Proof: {"scheme":"xpnts-prepaid","account":"0x<sender>"}`
     - **ETH 预存**（A.3）：客户端在 `PrepaidGas.sol` 合约里有余额；带 `X-Payment-Proof: {"scheme":"eth-prepaid","account":"0x<sender>"}`
     - **现场支付**（可选 M3+，本期不做）：客户端先转账，把 tx hash 作为 proof
  5. 客户端**重发原 UserOp** + `X-Payment-Proof` header
  6. bundler 校验 proof：
     - 解析 proof 的 `scheme`
     - xPNTs：查内部预存账本余额 ≥ 报价 `amount` → 扣账本 → 进入 mempool
     - eth-prepaid：查 `PrepaidGas` 合约 `balanceOf(sender) ≥ amount` → 调 `PrepaidGas.charge(sender, amount, opHash)` → 进入 mempool
  7. bundle 上链后：
     - 若 op 成功 → 收费已扣，结束
     - 若 op revert / drop → bundler 退款（xPNTs 回账本；eth-prepaid 调 `PrepaidGas.refund(sender, amount, opHash)`）
- **技术方案**：
  - **新增模块**：`src/billing/`
    - `src/billing/x402.ts` — X402 协议封装：`buildPaymentRequiredResponse(userOp, quotes)` 构造 402 响应；`parsePaymentProof(headers)` 解析 proof；`Quote` 类型（`{ scheme, token?, amount, recipient, chainId }`）
    - `src/billing/pricing.ts` — 报价计算：基于 `userOp.callGasLimit + verificationGasLimit + preVerificationGas` × `gasPrice` × `markup`（默认 1.2x）+ 固定服务费（如 0.001 USD 等值 xPNTs）
    - `src/billing/ledger.ts` — 内部预存账本（xPNTs / ETH 双通道），后端用 Redis（M1 已支持）持久化；接口 `getBalance(account, asset)` / `charge(account, asset, amount, opHash)` / `refund(account, asset, amount, opHash)` / `topup(account, asset, amount, source)`；charge/refund 用 `opHash` 做幂等
    - `src/billing/index.ts` — `enforceX402({ userOp, headers, trustedPaymasters }): Promise<{ allow: true } | { allow: false, response: X402Response }>`
  - **挂载点**：`src/rpc/methods/eth_sendUserOperation.ts` 和 `boost_sendUserOperation.ts` 的入口，在 mempool 校验**之前**调 `enforceX402`；返回 `allow: false` 时 RPC 直接抛带 `httpStatus: 402` 的 RpcError（需要扩展 `RpcError` 支持自定义 httpStatus，或者在 fastify 层用钩子拦截）
  - **CLI 配置**：
    - `--billing-enabled true|false`（默认 false，灰度逐链开）
    - `--billing-markup-bps 2000`（gas 加价 20%）
    - `--billing-service-fee-usd 0.001`（固定服务费等值）
    - `--billing-accepted-assets "xpnts,eth-prepaid"`（逗号分隔）
    - `--billing-quote-ttl-seconds 60`（402 报价有效期）
    - `--billing-prepaid-gas-contract 0x...`（PrepaidGas 合约地址）
  - **互斥规则**：`enforceX402` 第一行就检查 `if (trustedPaymasters.has(userOp.paymaster)) return { allow: true }`——白名单永远优先，永不收费，与 M2 fast-lane 完全互斥
  - **响应规范**：返回 HTTP status 402（不是 200），body 用 JSON-RPC error 格式 `code = -32402`，data 字段放 X402 详情；header `X-Payment-Required` 为 stringify 的 X402 quote 列表（兼容只看 header 的简化客户端）
  - **测试**：
    - 单元：402 响应结构、报价计算、proof 解析、互斥规则
    - 集成：白名单 paymaster → 不返 402；非白名单无 proof → 返 402；带正确 proof → 进 mempool；带过期 proof → 返 402 + `expired` reason
- **验收**：
  - OP-Sepolia 上提交一笔无 paymaster 的 UserOp → 收 402 → 客户端预存 xPNTs → 重发 → 成功上链 → 账本余额正确扣减
  - 白名单 paymaster UserOp 提交 → 不触发 402，直接进 mempool（互斥确认）
  - 标准 ERC-4337（用户自付 gas，不走 boost）UserOp → 不触发 402（仅对"bundler 出 gas"或"bundler 承担 paymaster 风险"的场景收费）

### A.2 xPNTs 预存收款（生态首选）

- **业务价值**：xPNTs 是 AAStar 生态的社区积分代币，用户在社区获得后**无需 approve** 就能被预授权 spender 扣款（`xPNTsToken.sol:241-251` 的 `allowance` 重写返回 `type(uint256).max`）。bundler 接入 xPNTs 收费通道后：
  - 用户体验：不需要单独购买 xPNTs，社区内自然流通的 xPNTs 直接可付 bundler 费
  - 生态闭环：bundler 收来的 xPNTs 可转回 SuperPaymaster 兑换 aPNTs / 反哺社区，资金不出生态
  - 零额外 approve：用户无需对 bundler 单独 approve，体感与"白名单免费"无差异（仅扣点 xPNTs 而已）
- **必要性**：
  - 没有 xPNTs 通道，外部用户只能用 ETH 付费——破坏 AAStar"用户全程不接触 ETH"的核心叙事
  - xPNTs 的预授权机制（autoApprovedSpenders）+ 防火墙（transferFrom 只允许 to=msg.sender 或 to=SuperPaymaster）天然适合 bundler 收款：bundler 把自己加为 spender 后，只能把用户 xPNTs 转给自己（`to == msg.sender == bundler`），合约层杜绝越权
- **流程**：
  1. **预备**（一次性，per community per chain）：
     a. 社区 owner 对每个 xPNTsToken 调 `addAutoApprovedSpender(bundlerCollectorAddr)`（`xPNTsToken.sol:446-453`）
     b. bundlerCollectorAddr 是 bundler 配置里的"收款地址"（与 executor wallet 区分，防止收款混入运营资金）
     c. 这一步**必须由社区 owner 主动配合**——bundler 没有调用权限。运营层需要建立"接入清单"治理（哪些社区接入了 xPNTs 收费、bundler 在哪些 token 上是 autoApprovedSpender）
  2. **客户端预存**：
     a. 客户端首次接入时调 bundler 的 `pimlico_topupXPNTs(account, token, amount)` 端点（M3 新增），bundler 返回需要的转账信息
     b. 客户端用户 wallet 手动转 xPNTs 给 `bundlerCollectorAddr`（不走 bundler，是直接的 ERC20 transfer）；或者通过 SuperPaymaster 走 SponsorTransfer 路径
     c. bundler 监听 xPNTsToken 的 `Transfer(from, to=bundlerCollectorAddr, value)` 事件，识别后入账到内部账本 `ledger.topup(account, "xpnts:<token>", value, "transfer:<txHash>")`
     d. 客户端 query `pimlico_getXPNTsBalance(account, token)` 查余额
  3. **扣款**（每笔 op）：
     a. X402 报价命中 xPNTs（A.1 步骤 6）→ bundler 在 mempool 接收前调 `ledger.charge(account, "xpnts:<token>", amount, opHash)`
     b. 账本扣减 → 进 mempool
     c. **链下扣账，链上不发 transferFrom**——这是预存模型的核心，避免每笔 op 多发一次 ERC20 tx 烧 gas
     d. 周期（如每日）批量结算：bundler 把当日所有用户的"已扣 xPNTs"调 `xPNTsToken.transferFrom(user, bundlerCollectorAddr, totalAmount)` 一次性上链
       - 单笔 ≤ 5000 ether（`MAX_SINGLE_TX_LIMIT`，约 $100）；超过则拆多笔
       - 每笔 transferFrom 走的是 `to == msg.sender == bundlerCollectorAddr`，触发 `xPNTsToken.sol:262-277` 的防火墙允许路径
       - 注意：`autoApprovedSpenders` 路径的 transferFrom 限制 `to ∈ {msg.sender, SUPERPAYMASTER_ADDRESS}`，bundler 必须用自己的 collector 地址作为 `to`
- **技术方案**：
  - **新增模块**：
    - `src/billing/xpnts/collector.ts` — xPNTs 转账事件监听 + 入账（用现有 `eventManager` 基础设施扩展，每个 xPNTsToken 一个 watcher）
    - `src/billing/xpnts/settler.ts` — 周期结算 cron，批量调 transferFrom 上链（用 utility wallet 签）
  - **配置**：
    - `--xpnts-collector-address 0x...`（收款地址，必须 ≠ executor wallet，建议独立 EOA）
    - `--xpnts-tokens "10:0xtok1,10:0xtok2"`（chain:token 列表）
    - `--xpnts-settlement-interval-seconds 86400`（默认每日结算一次）
    - `--xpnts-settlement-batch-size 50`（一次结算最多多少用户）
  - **互斥与防双重收费**（**关键**）：
    - **trusted-paymasters 白名单内的 paymaster**（M2 加）→ 不触发 X402 → 不扣 xPNTs → 仅 SuperPaymaster v3 内部按其逻辑扣 aPNTs/xPNTs 一次
    - **白名单外**（如外部 paymaster 或无 paymaster）→ 触发 X402 → 扣 xPNTs（bundler 收）+ 若挂了外部 paymaster，paymaster 自己也会扣一次（按它的合约逻辑）
    - **必须**在文档和 SDK 里**显式声明**：白名单 paymaster 与 X402 互斥；外部 paymaster 用户需要自己确认 paymaster 不会重复收费
    - 实现保证：`enforceX402` 第一行硬编码 `if (trustedPaymasters.has(paymaster)) return allow`——这一规则纳入 M3 验收 checklist
  - **退款逻辑**：
    - op revert / drop 后调 `ledger.refund(account, "xpnts:<token>", amount, opHash)` 把扣的 xPNTs 还回账本
    - opHash 作为幂等 key，防止退款被重复
  - **失败兜底**：
    - 结算 transferFrom 失败（用户 xPNTs 余额已转走 → 余额不足）→ 标记 user 为"欠费"，加入黑名单短期不接其 op；运维收 webhook 告警人工处理
- **验收**：
  - 社区 owner 调 `addAutoApprovedSpender(bundlerCollector)` 后，bundler 能识别并允许接收该 token 收费
  - 用户预存 100 xPNTs → bundler 账本显示 100 → 提交一笔 op 报价 5 xPNTs → 扣后账本显示 95
  - 周期结算 → 链上 `xPNTsToken.balanceOf(bundlerCollector)` 增加；用户 xPNTsToken 余额减少；与账本扣减总额相符
  - 单笔超过 5000 ether 自动拆分；不会触发 `SingleTxLimitExceeded`
  - 白名单 paymaster UserOp 不触发 xPNTs 扣款（互斥规则）

### A.3 ETH 预存模式（备选）

- **业务价值**：xPNTs 通道需要每个社区 owner 配合调 `addAutoApprovedSpender`，存在跨社区配置成本和治理成本（社区 owner 不配合 → 该社区用户无法用 xPNTs 付费）。ETH 预存提供一条"零生态依赖"的备用通道：客户端往 bundler 部署的 `PrepaidGas.sol` 合约预存 ETH，bundler 内部账本扣账。适用场景：
  - 非 AAStar 生态的外部 SDK / agent 框架接入
  - 新部署的链上 xPNTs 还没有社区铺开
  - 紧急通道：xPNTs 结算系统出故障时的兜底
- **必要性**：
  - 生态外用户没有 xPNTs，只有 ETH
  - 给 bundler 一条不依赖 SuperPaymaster / xPNTs 治理的独立收款通路，降低单点依赖风险
  - **trade-off 必须明示**：要部署额外合约（`PrepaidGas.sol`，独立审计）+ 要写 SDK 配合（客户端预存调用）+ 用户体验差（需要先持有 ETH 并转账，破坏"用户不接触 ETH"叙事）。所以 A.3 是**备选不是首选**——默认关闭，按需开启。
- **流程**：
  1. **合约部署**：M3 一次性部署 `PrepaidGas.sol`（在 UltraRelay-AAStar 仓库，参考 SuperPaymaster 的合约组织方式或新建 `contracts/` 目录），每条目标链一份
  2. **客户端预存**：
     a. 客户端调 `PrepaidGas.deposit{value: amount}()`（直接转 ETH 进合约，记到 `balances[msg.sender]`）
     b. bundler 监听 `Deposited(account, amount)` 事件，入账到 `ledger.topup(account, "eth", amount, "deposit:<txHash>")`
  3. **扣款**：
     a. X402 报价命中 `eth-prepaid` → bundler 调 `ledger.charge(account, "eth", amount, opHash)`
     b. **链下扣账**，与 xPNTs 同模式
     c. 周期（如每日）批量结算：bundler 调 `PrepaidGas.batchCharge(accounts[], amounts[], opHashes[])` 一次性上链；ETH 从合约的用户余额转到 bundler 收款地址
  4. **客户端提现**：用户随时调 `PrepaidGas.withdraw(amount)` 取回未扣的余额（合约内 `balances[msg.sender] - pendingCharges[msg.sender] >= amount` 才允许）
- **技术方案**：
  - **新增合约**：`contracts/PrepaidGas.sol`
    - `mapping(address => uint256) public balances`
    - `mapping(address => uint256) public pendingCharges`（防止用户在 bundler 链下扣账后立即 withdraw 偷跑）
    - `deposit() payable`：增加 balance + emit `Deposited`
    - `withdraw(amount)`：要求 `balances[msg.sender] - pendingCharges[msg.sender] >= amount`
    - `lockCharge(address user, uint256 amount, bytes32 opHash) onlyBundler`：链下扣账后，bundler 调此函数把待扣金额标 pending（防 withdraw 攻击）
    - `unlockCharge(address user, uint256 amount, bytes32 opHash) onlyBundler`：op revert 退款时撤销 pending
    - `batchSettle(bytes32[] opHashes) onlyBundler`：把对应 pending 转为实际扣款，从 balance 减 + 转 ETH 给 collector
    - `setBundler(address) onlyOwner`：bundler 角色可热更换
    - 简单可审计，无升级代理（一次性部署，不需要也不要 upgradeable）
  - **合约审计**：M3 必须有第三方审计（即便代码量小），收费合约一旦有 bug 会直接吞用户预存 ETH
  - **新增模块**：
    - `src/billing/eth/collector.ts` — `PrepaidGas` Deposited 事件监听 + 入账
    - `src/billing/eth/settler.ts` — 周期 batchSettle 调用
    - `src/billing/eth/lock.ts` — 链下扣账后异步调 `lockCharge` 防 withdraw 偷跑
  - **配置**：
    - `--billing-prepaid-gas-contract 0x...`（每链一份，与 chainId 关联）
    - `--billing-eth-enabled true|false`（默认 false，按链开）
    - `--billing-eth-settlement-interval-seconds 86400`
    - `--billing-eth-collector-address 0x...`
  - **trade-off 明示文档**：`docs/BILLING_ETH_VS_XPNTS.md`（M3 产出）列两通道对比表（部署成本 / SDK 复杂度 / 用户体验 / 治理依赖 / 风控）
- **验收**：
  - PrepaidGas 合约部署 + 第三方审计报告归档
  - 客户端 deposit 1 ETH → bundler 账本显示 1 ETH
  - 提交一笔报价 0.001 ETH 的 op → 账本扣 → lockCharge 成功 → 不能 withdraw 已 pending 部分
  - 周期 settle → 链上 collector 收到 ETH，pendingCharges 清零
  - op revert → unlockCharge 退账，用户可全额 withdraw

### A.4 X402 SDK 集成示例（curl + permissionless.js）

- **业务价值**：协议规范有了不等于客户端会用——必须有可复制的接入示例，否则生态合作方接入成本高、问题多。我们提供 (a) 最小 curl 脚本演示协议握手 (b) permissionless.js 适配示例（permissionless.js 是 ERC-4337 SDK 事实标准），这两份就能覆盖 90% 接入场景。
- **必要性**：
  - 让首次接入的开发者 1 小时内跑通"提交 op → 收 402 → 预存 → 重发 → 上链"全流程
  - 暴露设计中没考虑到的边缘 case（如 nonce 顺序、超时重试、并发预存）
- **流程**：
  1. 写两份 example 项目：`examples/x402-curl/` 和 `examples/x402-permissionless/`
  2. curl 版本：纯 shell + jq，演示协议层；包含 (a) 提交 op (b) 解析 402 (c) 预存（直接 ERC20 transfer 或 PrepaidGas.deposit）(d) 重发带 X-Payment-Proof (e) 查询 receipt
  3. permissionless.js 版本：TypeScript，演示如何把 X402 拦截器接到 viem-style transport；包含自动预存触发和重试逻辑
  4. 各配 `README.md` 说明依赖、配置、运行步骤
  5. 把 examples 链接到主仓 `README.md` 和 `docs/M3_DESIGN.md` 的接入章节
- **技术方案**：
  - **examples/x402-curl/**：
    - `submit.sh` — 调 `eth_sendUserOperation`，捕获 402 响应
    - `parse-402.sh` — 提取 `X-Payment-Required` 报价
    - `topup-xpnts.sh` — 调链 ERC20 transfer（用 cast / foundry）
    - `topup-eth.sh` — 调 PrepaidGas.deposit（用 cast）
    - `resubmit.sh` — 带 `X-Payment-Proof` 重发
    - `Makefile` 串起来
  - **examples/x402-permissionless/**：
    - `package.json` 依赖 `permissionless`、`viem`
    - `src/x402-transport.ts` — 实现 `customTransport` 包装，自动捕获 402 → 触发预存 → 重发；提供 `createX402Transport({ topupCallback, paymentProofProvider })` 工厂
    - `src/example.ts` — 完整 e2e：deploy account → send userOp → 自动走 X402
    - `README.md` 含 quickstart
  - **文档**：
    - `docs/X402_INTEGRATION.md`（M3 产出）— 协议规范、报价语义、错误码、SDK 适配指南
- **验收**：
  - 两份 example 在 OP-Sepolia 跑通（含完整步骤截图 / 日志）
  - 第三方开发者按 README 1 小时内能跑通（找一个 AirAccount/SP 团队同事做用户测试）
  - 协议错误（过期 proof、余额不足、reused opHash）的客户端处理路径都有示例

---

## 部分 B · 运维成熟

> M2 完成时 bundler 已经"协议合规、对内闭环"，但运维基础设施仍停留在"日志 + Prometheus 端点存在"的最低水位。M3 把它升级到"出问题 5 分钟内有人收到告警、Grafana dashboard 一眼看到健康度、上游同步无人值守、RPC 成本可观测可治理"的生产高可用水准。

### B.1 监控告警 webhook（Slack / Discord / PagerDuty）

- **业务价值**：M1 的 `utilityWalletMonitor` 只在日志里告警——日志没人主动看，等到余额耗尽 bundler 停摆才发现就太晚了。webhook 推到 IM / on-call 系统能让运维"分钟级响应"。同时把"bundler 异常退出"、"RPC 失败率"、"bundle revert 率"三类高优事件也接入。
- **必要性**：
  - 公网开放 + 收费 → SLA 敏感度直线上升 → 必须有秒级 / 分钟级告警链路
  - utility wallet 余额耗尽 → bundler 全部 boost / fast-lane op 立即停摆 → 用户感知度 100% → 必须 P0 告警
  - bundler 进程 crash 自重启失败 → 完全不可用 → 必须 P0 告警
  - RPC 失败率突增 → 上游 provider 故障或限流 → 必须 P1 告警以便切备用 RPC
  - bundle revert 率突增 → 可能是新链协议 bug 或恶意 op 风暴 → 必须 P1 告警
- **流程**：
  1. **告警源接入**：bundler 内部新增 `AlertManager` 中央告警分发器；现有的 `utilityWalletMonitor` 和新增的健康检查模块向其上报事件
  2. **事件类型与级别**：
     - P0：utility/executor wallet 余额 < 阈值；bundler 进程退出；RPC 100% 失败连续 N 秒
     - P1：bundle revert rate > 阈值（默认 5%）持续 N 分钟；RPC 失败率 > 阈值（默认 10%）；x402 收款延迟 > 阈值
     - P2：mempool size > 阈值；wallet balance < 警戒线但未到 P0
  3. **路由**：bundler 启动时按配置把不同级别推到不同 webhook（P0 → PagerDuty；P1 → Slack #ops；P2 → Slack #ops-low）
  4. **抑制**：同一 alertKey 在 cooldown 时间内（默认 5 分钟）不重复推送，避免告警风暴
  5. **resolved 通知**：告警条件恢复后推送一条 `[RESOLVED]` 消息（Slack / Discord 支持）
- **技术方案**：
  - **新增模块**：`src/monitoring/alertManager.ts`
    - `interface Alert { key: string, level: "P0"|"P1"|"P2", title: string, body: object, source: string }`
    - `class AlertManager { fire(alert: Alert): Promise<void>; resolve(alertKey: string): Promise<void> }`
    - 内部维护 `Map<alertKey, lastFiredAt>` 做 cooldown
  - **Channel adapters**：`src/monitoring/channels/`
    - `slack.ts` — POST 到 Slack Incoming Webhook URL，body 用 attachments 格式（红/黄/绿色块按级别）
    - `discord.ts` — POST 到 Discord webhook URL（content + embed）
    - `pagerduty.ts` — Events API v2，触发 incident（dedup_key = alertKey 自动 dedup）
    - 每个 adapter 接 `{ url, ...auth }` 配置，统一接口 `send(alert)`
  - **集成点**：
    - `src/executor/utilityWalletMonitor.ts` — 现有日志告警旁加 `alertManager.fire(...)`
    - `src/executor/executorManager.ts` — bundle revert 统计 + 阈值触发
    - `src/cli/createServer.ts`（或 entry）— `process.on('uncaughtException' | 'unhandledRejection' | 'SIGTERM')` 触发 P0 告警
    - RPC 失败统计：在 viem transport 包装层加成功/失败计数器，per-method 累加，周期 evaluator 触发告警
  - **配置**：
    - `--alert-slack-webhook https://hooks.slack.com/...`
    - `--alert-discord-webhook https://discord.com/api/webhooks/...`
    - `--alert-pagerduty-routing-key xxx`
    - `--alert-channels "p0:pagerduty,slack;p1:slack;p2:slack"`
    - `--alert-cooldown-seconds 300`
    - `--alert-bundle-revert-threshold-bps 500`（5%）
    - `--alert-rpc-failure-threshold-bps 1000`（10%）
    - `--alert-rpc-failure-window-seconds 60`
    - `--alert-min-balance-eth 0.1`
- **验收**：
  - 触发 utility wallet 低余额告警 → Slack / Discord 收到消息（含 wallet 地址、当前余额、阈值）
  - kill bundler 进程 → PagerDuty 收到 incident
  - cooldown 验证：连续 10 次低余额事件 → 5 分钟内只推 1 条
  - resolved 验证：充值后再 fire 不重复，转入 resolved 状态推 1 条恢复通知
  - 配置不同 webhook URL 不同级别 → 路由分流正确

### B.2 Prometheus metrics 完整化 + Grafana dashboard

- **业务价值**：M1 已有 `/metrics` 端点但暴露的指标不全；现在 M3 要把"运营关心的所有维度"补齐，并做一个开箱即用的 Grafana dashboard 模板，运维 / 商务 / 产品都能用同一份 dashboard 看到 (a) bundler 健康度 (b) 商业指标（X402 收入）(c) 资产指标（钱包余额）。
- **必要性**：
  - 没有完整 metrics 就没有 SLO/SLA 度量基础；告警阈值（B.1）的设定都靠 metrics 历史数据
  - Grafana dashboard 是非工程师（商务、产品、合规）了解 bundler 状态的唯一可读窗口
  - 多 bundler 实例（D.2）部署后必须有汇总视图
- **流程**：
  1. **指标盘点**：列出全部需暴露指标，分四类
     - 协议指标：mempool size、bundle 提交速率、failure rate、reputation drop count、validation reject count
     - 资产指标：wallet balance（per executor wallet、per chainId）、xPNTs collector balance（per token）、PrepaidGas contract TVL
     - 商业指标：paymaster usage（按 paymaster 地址聚合 op count + gas 总消耗）、fast-lane 命中率（fast-lane vs 标准 vs X402 比例）、X402 收费总额（per asset、per chain）、X402 退款总额、X402 拒付次数
     - RPC 治理指标：RPC call 计数（按 method + provider）、RPC 失败率、getLogs cache 命中率、receiptCache 命中率
  2. **实现**：用 prom-client（已有依赖）扩展 metric，按 Prometheus 命名规范加 namespace `alto_` 前缀
  3. **Grafana dashboard**：建一份 JSON dashboard 模板，按角色分 row（健康 / 资产 / 商业 / RPC）；提交到 `monitoring/grafana-dashboard.json`
  4. **告警规则模板**：在 `monitoring/alert-rules.yaml` 提供示例 PromQL 告警表达式（与 B.1 webhook 配对）
- **技术方案**：
  - **新增 / 扩展模块**：
    - `src/utils/metrics.ts`（已有，扩展）— 加新 metric 注册：
      - `alto_billing_x402_charged_total{asset, chain}` — Counter
      - `alto_billing_x402_refunded_total{asset, chain}` — Counter
      - `alto_billing_x402_402_responses_total{reason}` — Counter
      - `alto_billing_xpnts_settlement_total{token, chain}` — Counter
      - `alto_billing_ledger_balance{account, asset}` — Gauge（仅大额账户暴露，避免 cardinality 爆炸；需阈值过滤）
      - `alto_paymaster_usage_total{paymaster, chain}` — Counter
      - `alto_paymaster_gas_total{paymaster, chain}` — Counter
      - `alto_lane_hits_total{lane="fast"|"standard"|"x402"|"boost"}` — Counter
      - `alto_rpc_calls_total{method, provider, status}` — Counter
      - `alto_rpc_cache_hits_total{cache="getLogs"|"receipt"}` — Counter
      - `alto_rpc_cache_misses_total{cache="getLogs"|"receipt"}` — Counter
      - `alto_wallet_balance_eth{wallet_role, address, chain}` — Gauge
      - `alto_xpnts_collector_balance{token, chain}` — Gauge
      - `alto_prepaid_gas_tvl{chain}` — Gauge
    - 注意 cardinality：account / userOpHash / sender 这种高 cardinality label 不进 metrics（只进日志）
  - **Grafana dashboard JSON**：
    - 4 row：Health / Assets / Business / RPC
    - 每 panel 配默认时间窗（1h / 6h / 24h / 7d）
    - 多链切换：dashboard 顶部加 `chain` 变量，所有 panel 用 `chain=$chain` 过滤
    - 多实例切换：加 `instance` 变量
  - **配置**：
    - 现有 `/metrics` 端点不变；只是暴露的 metric 数量增加
    - 新增 `--metrics-account-balance-threshold 100`（账本余额超过此值才暴露，控 cardinality）
- **验收**：
  - prom2json `/metrics` 输出包含全部新 metric，无 cardinality 爆炸（label 组合数 < 10000）
  - Grafana 导入 `monitoring/grafana-dashboard.json` 后 4 row 全部出图
  - 模拟一笔 X402 收费 → `alto_billing_x402_charged_total` +1
  - 多实例部署后 dashboard 切换 instance 变量正确分流

### B.3 上游同步自动化（GitHub Action）

- **业务价值**：M1 的上游同步是手动月度流程（`docs/UPSTREAM_SYNC.md`），依赖人记得做、依赖人有空做。自动化后：定时跑 `git fetch upstream && git merge upstream/main → 创建 PR`，CI 跑通后人审 merge。降低漂移风险，把"是否要 merge 上游"从"决策"变成"review PR"。
- **必要性**：
  - fork 治理基线——M1 已经定下"持续跟住上游"的目标，但手动流程随团队规模会失效
  - 上游 ZeroDev / Pimlico 修 bug 越快接入越好（特别是安全 fix）
- **流程**：
  1. **GitHub Action workflow**：`.github/workflows/upstream-sync.yml`
     - cron 每周日 02:00 UTC 触发（也支持 workflow_dispatch 手动）
     - checkout 仓库 + 配 upstream remote（用 secret token）
     - `git fetch upstream`
     - 检查 `git log main..upstream/main` 是否有新 commit；若无则跳过
     - 在 `chore/upstream-sync-YYYYMMDD` 分支上 `git merge upstream/main`
     - 若 merge 冲突 → 把冲突标记 commit 后开 PR；PR description 列冲突文件清单 + 提示 reviewer 按 `docs/FORK_DELTA.md` 解决
     - 若 merge 干净 → 直接开 PR
     - PR 自动加 label `upstream-sync`、reviewer 默认配运维 owner
     - PR description 包含 upstream commit 列表（commit hash + 标题）
  2. **CI 集成**：PR 触发现有 CI（lint / build / unit test / e2e）
  3. **人审 merge**：reviewer 看 CI 全绿 + 逐 commit 看 upstream 变更后 squash merge 到 `aastar-dev`（**不**自动 merge——上游有可能引入业务行为变化，必须人审）
  4. **冲突解决依据**：仍参照 `docs/FORK_DELTA.md`（M1 产出，M3 持续维护）
- **技术方案**：
  - **新增文件**：`.github/workflows/upstream-sync.yml`
    ```yaml
    name: Upstream Sync
    on:
      schedule:
        - cron: "0 2 * * 0"  # 每周日 02:00 UTC
      workflow_dispatch:
    jobs:
      sync:
        runs-on: ubuntu-latest
        steps:
          - uses: actions/checkout@v4
            with:
              fetch-depth: 0
              token: ${{ secrets.UPSTREAM_SYNC_TOKEN }}
          - name: Configure git
            run: |
              git config user.name "upstream-sync-bot"
              git config user.email "ops@aastar.io"
          - name: Add upstream
            run: git remote add upstream https://github.com/zerodevapp/ultra-relay.git
          - name: Fetch upstream
            run: git fetch upstream
          - name: Check for new commits
            id: check
            run: |
              count=$(git rev-list --count main..upstream/main)
              echo "new_commits=$count" >> $GITHUB_OUTPUT
          - name: Create sync branch
            if: steps.check.outputs.new_commits != '0'
            run: |
              date=$(date +%Y%m%d)
              git checkout -b chore/upstream-sync-$date main
              git merge upstream/main || true
              git push origin chore/upstream-sync-$date
          - name: Open PR
            if: steps.check.outputs.new_commits != '0'
            uses: peter-evans/create-pull-request@v6
            with:
              base: aastar-dev
              title: "chore: upstream sync $(date +%Y-%m-%d)"
              body: |
                Automated upstream sync. ${{ steps.check.outputs.new_commits }} new commits.
                Resolve conflicts per docs/FORK_DELTA.md.
              labels: upstream-sync
              reviewers: <ops-owner-github-handle>
    ```
  - **Secret**：`UPSTREAM_SYNC_TOKEN` — fine-grained PAT，权限 `contents:write` + `pull-requests:write` on this repo
  - **文档更新**：`docs/UPSTREAM_SYNC.md` 加"自动化部分"章节描述 workflow 行为；`docs/FORK_DELTA.md` 维护增量清单不变
- **验收**：
  - workflow_dispatch 手动触发能跑通（在 upstream 没新 commit 时正确跳过；有时正确开 PR）
  - 故意制造一个冲突场景 → PR 开出 + body 标注冲突文件
  - PR 触发 CI 全套通过
  - reviewer 流程跑一次（即便上游没新东西也走 sandbox 演练）

### B.4 RPC 成本治理

- **业务价值**：bundler 是重 RPC 调用的服务（estimateGas / call / getLogs / getTransactionReceipt 全都频繁）。付费 RPC provider（Alchemy / QuickNode）按调用量计费，月成本随业务量线性涨。M3 加 (a) getLogs LRU cache 削减重复调用 (b) receiptCache TTL/容量参数化暴露 (c) 按 method 统计 RPC call，可观测可治理。每条都直接降本或提供降本依据。
- **必要性**：
  - getLogs 是最贵的调用（按 block 范围扫，没 cache 会被反复调）
  - receipt query 在重发轮询场景下有重复（pimlico_getUserOperationStatus + eth_getUserOperationReceipt 共享底层 receipt）
  - 没 RPC call 计数 → 涨账时无法定位到底是哪个 method 烧的
- **流程**：
  1. **getLogs LRU cache**：
     - 加内存 LRU cache，key = `${address}:${fromBlock}-${toBlock}:${topic0}:${topicHash}`
     - TTL 可配（默认 30 秒——logs 在 confirmed block 上不会变）
     - cache size 上限可配（默认 1000 条）
     - 仅对 confirmed block range（`toBlock <= latest - confirmations`）才 cache；包含 latest 的范围不 cache
     - hit / miss 暴露到 metrics（B.2 已加）
  2. **receiptCache 参数化**：
     - 现有 receipt cache（如已存在）的 TTL / 容量从硬编码改为 CLI flag
     - 加 metrics
  3. **RPC call 计数**：
     - viem transport 包装层加 hook：每次 call 前后记录 `{method, provider, status, durationMs}`
     - 增量到 `alto_rpc_calls_total{method, provider, status}` Counter
     - 周期 dump 到日志（每分钟一次，方便 grep）
- **技术方案**：
  - **新增 / 扩展模块**：
    - `src/utils/getLogsCache.ts`（新增）— 用 `lru-cache` 包：
      ```ts
      import LRU from "lru-cache"
      export interface GetLogsCacheConfig { maxSize: number, ttlMs: number, confirmations: number }
      export class GetLogsCache {
          private cache: LRU<string, Log[]>
          constructor(config: GetLogsCacheConfig) { ... }
          async get({ address, fromBlock, toBlock, topics, latestBlock, fetcher }): Promise<Log[]> {
              if (toBlock > latestBlock - this.config.confirmations) {
                  return fetcher() // not cacheable
              }
              const key = this.makeKey({ address, fromBlock, toBlock, topics })
              const cached = this.cache.get(key)
              if (cached) {
                  metrics.cacheHits.inc({ cache: "getLogs" })
                  return cached
              }
              metrics.cacheMisses.inc({ cache: "getLogs" })
              const fresh = await fetcher()
              this.cache.set(key, fresh)
              return fresh
          }
      }
      ```
    - `src/handlers/eventManager.ts`（扩展）— 替换直接 `client.getLogs()` 为 `getLogsCache.get(...)`
    - `src/cli/customTransport.ts`（扩展）— 在 `request` hook 加计数：
      ```ts
      const start = Date.now()
      try {
          const result = await innerRequest(args)
          metrics.rpcCalls.inc({ method: args.method, provider: providerLabel, status: "ok" })
          metrics.rpcDuration.observe({ method: args.method, provider: providerLabel }, Date.now() - start)
          return result
      } catch (e) {
          metrics.rpcCalls.inc({ method: args.method, provider: providerLabel, status: "error" })
          throw e
      }
      ```
  - **配置**：
    - `--get-logs-cache-enabled true|false`（默认 true）
    - `--get-logs-cache-ttl-ms 30000`
    - `--get-logs-cache-max-size 1000`
    - `--get-logs-cache-confirmations 10`（确认数以下不 cache）
    - `--receipt-cache-ttl-ms`（已有 → 保留）
    - `--receipt-cache-max-size`（已有 → 保留）
    - `--rpc-call-log-interval-seconds 60`（周期日志 dump 频率，0 = 不 dump）
- **验收**：
  - 同样 getLogs 查询 100 次 → cache hit 率 > 95%（仅 confirmed range）
  - 包含 latest 的查询每次 cache miss（不 cache 行为正确）
  - `alto_rpc_calls_total` metric 按 method / provider / status 正确分桶
  - Grafana dashboard RPC row 出图
  - cache 满时 LRU evict 行为正常

---

## 部分 C · 协议演进

> M1 / M2 实现的是 ERC-4337 标准能力 + 业务定制；M3 加入下一代账户抽象演进所需的协议位（Operator attestation 信任链、postOp 精算）。这部分对内主要是协议合规升级，对外则提升与 AirAccount / SuperPaymaster 协同效率。
>
> **注**：EIP-7702 完整实战 已迁移到 M2 §4（业务上 fast-lane 需要支持 EOA-as-sender 路径，故前置）。

### C.1 Operator attestation in `paymasterAndData`

- **业务价值**：M2 fast-lane 方案 A 已经允许 trusted-paymasters 白名单内的 op 跳过部分 validation，但信任的边界仍是 paymaster 合约——若 paymaster 合约被攻击或私钥泄露，整个白名单失效。M3 加入"Operator attestation"信任层：在 `paymasterAndData` 末尾追加 `[operatorSig(65)]` 字段，由 operator（与 paymaster 协作的运营方，如 SuperPaymaster operator）私钥签 op 摘要。bundler 持公钥白名单，对每笔 fast-lane op 用 `ecrecover` 校验一次（无需上链 / 无 gas 消耗）。这把信任链从"合约层"延伸到"运营层"——即使 paymaster 私钥泄露，operator 私钥仍能拦下未授权 op。
- **必要性**：
  - 防御纵深：paymaster 合约 + operator 签名双因子，任一层被攻破不导致灾难
  - 跨主体信任：bundler / paymaster / operator 可能是不同主体（M3 后期可能 SuperPaymaster 由社区运营、operator 由 AAStar 核心团队签），attestation 是"主体间信任"的协议位
  - 这是 M2 方案 A 之上的最强信任链路，但**跨仓库协调成本大**——需要 SuperPaymaster + AirAccount 团队协同发版本，需要协议升级文档
- **流程**：
  1. **协议规范**（M3 跨仓库产出 `docs/OPERATOR_ATTESTATION_SPEC.md`，与 SP / AirAccount 评审）：
     - `paymasterAndData` 末尾追加 `[operatorSig(65)]`
     - 摘要：`keccak256(abi.encode(chainId, entryPoint, userOpHash, paymaster, validUntil))`（与 SuperPaymaster 现有 paymaster signature 摘要解耦——不复用，避免冲突）
     - 签名格式：EIP-191 personal_sign（更易兼容硬件钱包）
     - validUntil 复用 paymaster 现有字段
  2. **SuperPaymaster 侧改动**（**不在本仓库**，需协调）：
     - SP 构造 `paymasterAndData` 时在末尾 append operator signature
     - 现有 paymaster validation 不变（兼容旧版本不带 operator sig 的 op）
     - 接口加 `setOperatorSig(bytes)` 配 SP SDK 用
  3. **bundler 侧改动**（本仓库）：
     - 加载 operator 公钥白名单（CLI flag）
     - fast-lane 校验路径：解析 `paymasterAndData`，提取末尾 65 字节 → ecrecover → 检查 recovered address ∈ operator allowlist
     - 校验失败 → 拒绝走 fast-lane，降级到标准 validation 路径（不直接 reject，给一次容错机会）
     - 加 metric `alto_operator_attestation_total{result="ok"|"invalid"|"missing"}`
  4. **AirAccount 侧改动**（**不在本仓库**，需协调）：
     - SDK 在构造 op 时调 SP 后端拿 operator 签名一并塞进 `paymasterAndData`
- **技术方案**：
  - **新增模块**：`src/validator/operatorAttestation.ts`
    ```ts
    export interface OperatorAttestationConfig {
        enabled: boolean
        operatorAllowlist: Address[]
        digestVersion: "v1"
    }
    export function verifyOperatorAttestation({
        userOp,
        chainId,
        entryPoint,
        userOpHash,
        config
    }): { ok: boolean, recovered?: Address, reason?: string } {
        const paymasterData = extractPaymasterData(userOp)
        if (paymasterData.length < 65) return { ok: false, reason: "missing" }
        const sig = paymasterData.slice(-65)
        const validUntil = extractValidUntil(paymasterData)
        const digest = encodeOperatorDigest({ chainId, entryPoint, userOpHash, paymaster: userOp.paymaster, validUntil })
        const recovered = ecrecover(digest, sig)
        if (!config.operatorAllowlist.includes(recovered)) {
            return { ok: false, reason: "not-in-allowlist", recovered }
        }
        return { ok: true, recovered }
    }
    ```
  - **集成点**：M2 fast-lane 通道入口处调 `verifyOperatorAttestation`；失败则降级走标准路径
  - **配置**：
    - `--operator-attestation-enabled true|false`（默认 false，与 SP / AirAccount 一起灰度开）
    - `--operator-allowlist "0x...,0x..."`（公钥列表）
  - **跨仓库协调清单**（**M3 关键风险项**，明示）：
    - 与 SuperPaymaster 团队对齐 attestation 协议规范、digest 编码、签名 schema
    - 与 AirAccount 团队对齐 SDK 改动、灰度计划
    - 三方联合 e2e 测试
    - 协议升级文档（`docs/OPERATOR_ATTESTATION_SPEC.md`）三仓库共享
    - **协调成本评估**：≥ 2 周，包含规范评审 + 各侧实现 + 联合测试。如果时间不允许，C.1 可推到 M4，M3 只完成本仓库 bundler 侧实现并注入测试 stub
- **验收**：
  - 单元测试：digest 编码与 SP 侧实现 byte-perfect 一致；ecrecover 路径全过
  - 集成测试（mock operator 签名）：fast-lane op 带正确签名 → 通过；无签名或错签名 → 降级走标准路径
  - 三方联合 e2e（OP-Sepolia）：SP 构造 op + operator 签 + bundler 校验 + 上链
  - metric `alto_operator_attestation_total` 正确分桶

### C.2 postOp gas 精算（仅 SuperPaymaster v3 用户）

- **业务价值**：bundler `eth_estimateUserOperationGas` 默认对 paymaster postOp 用通用 buffer（如 50000 gas）。SuperPaymaster v3 的 postOp 逻辑相对复杂（refund 计算 + xPNTs burn / debt record + reputation feedback），通用 buffer 既可能高估（用户多付 xPNTs）也可能低估（OOG）。M3 加"识别 paymaster ∈ SuperPaymaster v3 → 用专用 estimate 替代通用 buffer"，让外部 X402 用户对接 SP v3 时少付 xPNTs。
- **必要性**：
  - **明确收益方**：仅外部 X402 用户有收益（精确度提升 → 用户少付 xPNTs 给 SuperPaymaster）。**内部 fast-lane 用户无此收益**——fast-lane op 不走 paymaster v3 计费，跑的是绿色通道，bundler 直接垫付 ETH 然后链下记账。这点必须在文档里强调，避免误期望。
  - 长期看：postOp 精算降低 paymaster 的 "validation buffer" 系数（SP v3 当前 `VALIDATION_BUFFER_BPS` 高估），整体生态 xPNTs 流转效率提升
- **流程**：
  1. **识别**：bundler 在 estimation 阶段拿到 `userOp.paymaster`，查内置 paymaster profile 表
  2. **profile 表**：表驱动，每个已知 paymaster 一份配置：
     ```ts
     interface PostOpProfile {
         paymasterAddress: Address
         paymasterName: "SuperPaymaster-v3.5" | "SuperPaymaster-v3.6"
         postOpGasEstimate: bigint  // 实测得来的 95% percentile
         comment: string
     }
     ```
  3. **使用**：estimation 时若 paymaster ∈ profile 表 → 用 `profile.postOpGasEstimate` 替换默认 buffer；否则用默认 buffer
  4. **校准**：M3 期间用 e2e + 主网真实数据收集 SP v3 实际 postOp gas 分布，定 95% percentile 写入表
- **技术方案**：
  - **新增模块**：`src/executor/paymasterPostOpProfile.ts`
    ```ts
    export const POST_OP_PROFILES: Record<Address, PostOpProfile> = {
        "0x<sp-v35-addr>": {
            paymasterAddress: "0x<sp-v35-addr>",
            paymasterName: "SuperPaymaster-v3.5",
            postOpGasEstimate: 80000n,  // 95p, measured on OP-Mainnet 2026-04
            comment: "burnFromWithOpHash success path; recordDebt fallback adds ~15k"
        },
        "0x<sp-v36-addr>": { ... }
    }

    export function getPostOpGasEstimate(paymaster: Address | undefined, defaultBuffer: bigint): bigint {
        if (!paymaster) return 0n
        const profile = POST_OP_PROFILES[paymaster.toLowerCase()]
        return profile?.postOpGasEstimate ?? defaultBuffer
    }
    ```
  - **集成点**：`src/rpc/estimation/` 估算路径里替换原 buffer 取值为 `getPostOpGasEstimate`
  - **配置**：
    - `--postop-profile-enabled true|false`（默认 true）
    - `--postop-profile-file ./postop-profiles.json`（覆盖内置表，运维快速调参用）
  - **校准方法**：
    - e2e 跑 100 笔 SP v3 op → 收集 `actualGasCost - validationGasUsed - executionGasUsed` 当 postOp 实际值
    - 取 95p（避免极端 case 导致 OOG）
    - 每季度 review 一次
- **验收**：
  - SP v3 paymaster 的 op estimate 结果中 postOp gas 与默认 buffer 显著不同（验证 profile 生效）
  - 100 笔 e2e 无 OOG 失败（profile 值合理）
  - 文档明确写"仅外部 X402 用户有收益，内部 fast-lane 无影响"
  - profile 表更新流程文档化（`docs/POSTOP_PROFILE_CALIBRATION.md`）

---

## 部分 D · 横向扩展

> M1/M2 把 OP-Sepolia / OP-Mainnet 跑通；M3 把 bundler 推到多链、多实例、灰度部署的真生产架构。这部分的工程量主要在配置矩阵和运维流程，代码改动相对少。

### D.1 多链上线（Linea / Scroll / Base）

- **业务价值**：AAStar 业务覆盖范围超出 OP——Linea / Scroll / Base 是当前 EVM L2 三大候选，每条链都有 AirAccount 部署需求和潜在 paymaster 合作方。bundler 多链支持是"扩生态"的硬门槛。
- **必要性**：
  - 单链 bundler = 单链业务上限
  - 不同 L2 的 RPC 行为差异（gas oracle / block tag / debug_traceCall 支持度 / EIP-7702 支持度）必须在配置层固化，否则每新接一条链都要改代码
- **流程**：
  1. **逐链 spike**：每条新链先做 1-2 周 spike，覆盖
     - RPC provider 选型（Alchemy / QuickNode / Infura 各自支持度）
     - gas oracle 选择（继承 EVM 默认 / OP / 自研 manager）
     - block tag 支持（PR #12 的 flag）
     - EIP-7702 支持度
     - debug_traceCall 支持度（决定 safe-mode 可否开启）
     - 真链一笔 e2e UserOp（含部署 + 提交 + 收据）
  2. **配置矩阵入文档**：每条链一份配置示例 + 推荐参数，写入 `docs/CHAIN_CONFIG.md`
  3. **CI 增量**：e2e suite 加 multi-chain 矩阵（用 anvil fork 各链）
  4. **灰度上线**：新链先 testnet 跑 1 周 → mainnet 灰度（仅运营方自己 SDK 流量）→ 全开
- **技术方案**：
  - **代码改动**：
    - 多数情况无需改代码，靠 CLI flag + chain handler 选择就够（M1 已有 `optimismManager` 的 chainId 路由模式）
    - 若新链需要专用 gas manager（如 Linea 有特殊 priority fee 计算）→ 新增 `src/handlers/lineaGasPriceManager.ts` 等
    - chain handler factory（`src/handlers/index.ts` 或类似）按 chainId 路由
  - **配置矩阵**（写入 `docs/CHAIN_CONFIG.md`）：
    | Chain | chainId | gas oracle | block-tag | debug_traceCall | EIP-7702 | safe-mode |
    |-------|---------|-----------|-----------|-----------------|----------|-----------|
    | OP-Mainnet | 10 | optimism | true | yes | yes | true |
    | OP-Sepolia | 11155420 | optimism | true | yes | yes | true |
    | Linea | 59144 | TBD | TBD | TBD | TBD | TBD |
    | Scroll | 534352 | TBD | TBD | TBD | TBD | TBD |
    | Base | 8453 | TBD（OP-stack 衍生，可能复用 optimism manager） | TBD | TBD | TBD | TBD |
  - **测试**：每条链至少 e2e 跑通：boost 路径 + 标准 ERC-4337 + fast-lane（若该链有部署 SP）+ X402（若该链开了 billing）
- **验收**：
  - Linea / Scroll / Base 三条链 testnet 各 e2e 跑通
  - mainnet 至少一条新链灰度 1 周稳定
  - `docs/CHAIN_CONFIG.md` 全表填满
  - 多链共享 mempool 验证（D.2 配合）

### D.2 多 bundler 实例水平扩展

- **业务价值**：单实例 bundler 是 SPOF（单点故障）+ 容量上限（单进程 RPS / mempool size）。多实例水平扩展提供 (a) 高可用（任一实例挂另一实例顶上）(b) 可扩容量（按 RPS 加实例）(c) 灰度能力（D.3 前提）。
- **必要性**：
  - 公网开放后，业务量增长不可预测，必须有水平扩展能力
  - SLA 承诺（如 99.9%）单实例做不到，多实例 + 健康检查 + 负载均衡才能做到
- **流程**：
  1. **架构**：多 bundler 实例共享 Redis mempool（M1 已支持）+ 各自独立 executor wallet 池（避免 nonce 冲突）+ 共享 utility wallet pool（用 mutex 协调）
  2. **executor wallet 池**：
     - 每实例分配独立 executor wallet 子集，wallet 与 instance 1:1 绑定
     - 通过 deterministic key derivation 从 master mnemonic 派生：`m/44'/60'/<instance_id>'/0/<index>`
     - bundler CLI 接 `--instance-id N --wallet-count M`，自动派生
  3. **utility wallet 协调**（boost 路径用）：
     - 多实例共享一个 utility wallet pool（如 5 个），用 Redis 分布式锁租用
     - 每发一笔 boost tx 前 acquire lock → send → release
     - lock TTL = 30 秒（防 deadlock）
  4. **负载均衡**：
     - HTTP 层用 nginx / ALB 做 round-robin，所有实例的 `/health` 端点喂给 LB
     - WebSocket 用 sticky session（按 client IP hash 路由到固定实例）
  5. **配置同步**：
     - trusted-paymasters 白名单 / operator allowlist / billing 配置等放 config 文件，所有实例 mount 同一份
     - 重新加载用 SIGHUP 信号或 etcd / consul watch（M3 取简单方案：SIGHUP）
- **技术方案**：
  - **代码改动**：
    - 大部分基础设施 M1 已就绪（Redis store / Redis mempool）
    - 新增 `src/executor/utilityWalletLock.ts`：基于 Redis SETNX 实现分布式锁（lock key = `utility-wallet:${address}`、TTL 30s）
    - executor wallet 派生：`src/cli/walletDerivation.ts`，按 instance_id + index BIP-44 派生
  - **配置**：
    - `--instance-id 0`（实例编号，0..N-1）
    - `--instance-count 4`（总实例数）
    - `--executor-wallet-count 10`（每实例 wallet 数）
    - `--utility-wallet-pool-key prefix:utility`（Redis 锁 key 前缀）
  - **运维 runbook**（写入 `docs/MULTI_INSTANCE.md`）：
    - 启动顺序、滚动更新流程、wallet 充值矩阵、健康检查配置
- **验收**：
  - 部署 3 实例共享 Redis → 提交 30 笔 op → 三实例分别处理 ~10 笔 → 全部上链
  - kill 1 实例 → 剩下 2 实例继续正常处理
  - utility wallet lock 验证：3 实例并发 30 笔 boost → 无 nonce 冲突
  - LB 健康检查：故意让 1 实例 `/health` 503 → LB 自动剔除

### D.3 灰度 / canary 部署

- **业务价值**：M3 后业务对 bundler 高度依赖；任何升级（新版本 / 新配置）的 bug 都会直接影响线上用户。灰度部署让我们先把 1% 流量打到新版本 → 观察 metrics 1-2 小时 → 没问题再 10% → 最终 100%。回滚时间 < 5 分钟。
- **必要性**：
  - 没有灰度 → 升级 = 全量风险 → 团队怕升级 → bug fix 上线慢
  - SLA 要求 → 必须有可控回滚机制
- **流程**：
  1. **基础设施**：
     a. CI/CD 把每次 release 部署到 `canary` 实例（独立 1 个实例，不在主流量池）
     b. nginx / ALB 配置 weighted round-robin：99% → 主集群、1% → canary
  2. **观察期**：
     a. canary 上线后 30 分钟自动跑 smoke test（自动化 e2e 一笔 op）
     b. 接下来 1-2 小时人审 Grafana dashboard：error rate / latency p99 / bundle revert rate / X402 收费成功率
  3. **晋升**：
     a. 通过 → 把 canary 配置升级到主集群（rolling update，逐实例替换）
     b. 失败 → 回滚 canary（撤掉权重）+ 故障 review
  4. **回滚**：
     a. 任一时点把 LB 权重改 0% canary → 流量秒级回主集群
     b. canary 实例继续保留 24 小时供事后分析
  5. **流程文档**：`docs/RELEASE_PLAYBOOK.md` 详述每步
- **技术方案**：
  - **代码改动**：无（bundler 本身不感知是否是 canary）
  - **基础设施**：
    - LB 配置（nginx / ALB）支持 weighted backend，文档化配置模板
    - CI/CD（GitHub Actions）增加 deploy-canary job
    - smoke test 脚本：`scripts/canary-smoke-test.sh`，自动跑一笔 op + 检查 receipt
  - **观察指标 SLO**：canary 与主集群同期对比，差异 > 阈值（默认 latency p99 +30% / error rate +1%）则不晋升
  - **配置**：
    - `--canary-mode true|false`（仅影响日志 label，方便 metrics 分流）
    - canary 与主集群共享 Redis mempool（同一池，通过 instance_id 区分日志）
- **验收**：
  - 灰度发布一次新版本 → canary 1% 流量 → 30 分钟 smoke test 通过 → 晋升到 10% → 全开
  - 故意发一个有 bug 的版本 → canary smoke test 失败 → 自动 alert + 不晋升
  - 回滚演练：从 canary 100% 回滚到 0% < 5 分钟
  - `docs/RELEASE_PLAYBOOK.md` 完整可执行

---

## E · 验收检查表（最终签字依据）

| # | Feature | 类型 | 验收方式 | 状态 |
|---|---------|------|---------|------|
| A.1 | X402 协议握手 | 收费 | OP-Sepolia 收 402 + 重发上链 e2e | ☐ |
| A.1 | X402 互斥规则 | 收费 | 白名单 paymaster 不触发 402 | ☐ |
| A.2 | xPNTs 预存入账 | 收费 | Transfer 事件入账 + 余额查询正确 | ☐ |
| A.2 | xPNTs 链下扣账 | 收费 | charge → 账本扣 → opHash 幂等 | ☐ |
| A.2 | xPNTs 周期结算 | 收费 | 链上 transferFrom 成功 + 拆分 5000 ether 上限 | ☐ |
| A.2 | xPNTs 退款 | 收费 | op revert → refund → 账本回滚 | ☐ |
| A.3 | PrepaidGas 合约审计 | 收费 | 第三方审计报告归档 | ☐ |
| A.3 | ETH 预存入账 | 收费 | deposit → 账本入账 | ☐ |
| A.3 | ETH 链下扣账 + lock | 收费 | charge → lockCharge → 不可 withdraw | ☐ |
| A.3 | ETH batchSettle | 收费 | 周期结算上链 ETH 给 collector | ☐ |
| A.4 | curl SDK 示例 | 收费 | OP-Sepolia 跑通 + README 完整 | ☐ |
| A.4 | permissionless.js SDK 示例 | 收费 | OP-Sepolia 跑通 + 第三方用户测试 | ☐ |
| A.4 | docs/X402_INTEGRATION.md | 收费 | 协议规范完整 | ☐ |
| B.1 | Slack/Discord webhook | 运维 | 触发余额告警 → IM 收到 | ☐ |
| B.1 | PagerDuty webhook | 运维 | kill bundler → incident 触发 | ☐ |
| B.1 | 告警 cooldown | 运维 | 连续告警 5 分钟内只推 1 条 | ☐ |
| B.1 | resolved 通知 | 运维 | 恢复后推送 RESOLVED | ☐ |
| B.2 | 完整 metrics | 运维 | prom2json 验证全部新 metric | ☐ |
| B.2 | Grafana dashboard | 运维 | 4 row 全部出图 + 多链/多实例切换 | ☐ |
| B.2 | metrics cardinality | 运维 | label 组合数 < 10000 | ☐ |
| B.3 | upstream-sync workflow | 运维 | workflow_dispatch 触发跑通 | ☐ |
| B.3 | 冲突 PR 流程 | 运维 | 故意制造冲突 → PR body 标注 | ☐ |
| B.4 | getLogs LRU cache | 运维 | hit 率 > 95% on confirmed range | ☐ |
| B.4 | RPC call 计数 | 运维 | metric 按 method/provider 分桶 | ☐ |
| B.4 | receiptCache 参数化 | 运维 | CLI flag 暴露 + 生效 | ☐ |
| C.1 | OPERATOR_ATTESTATION_SPEC | 协议 | 三仓库评审通过 | ☐ |
| C.1 | bundler 校验路径 | 协议 | 单元 + 集成测试覆盖 | ☐ |
| C.1 | 三方联合 e2e | 协议 | OP-Sepolia 跑通 | ☐ |
| C.2 | postop-profile 表 | 协议 | SP v3 estimate 走专用值 | ☐ |
| C.2 | 100 笔 e2e 无 OOG | 协议 | profile 值合理验证 | ☐ |
| C.2 | 校准流程文档 | 协议 | docs/POSTOP_PROFILE_CALIBRATION.md | ☐ |
| D.1 | Linea testnet e2e | 横向 | 真链跑通 | ☐ |
| D.1 | Scroll testnet e2e | 横向 | 真链跑通 | ☐ |
| D.1 | Base testnet e2e | 横向 | 真链跑通 | ☐ |
| D.1 | docs/CHAIN_CONFIG.md | 横向 | 全表填满 | ☐ |
| D.2 | 3 实例共享 mempool | 横向 | 30 笔 op 三实例分担 + 全上链 | ☐ |
| D.2 | utility wallet 分布式锁 | 横向 | 并发 boost 无 nonce 冲突 | ☐ |
| D.2 | 实例故障切换 | 横向 | kill 1 实例继续正常 | ☐ |
| D.3 | canary 灰度发布 | 横向 | 1% → 10% → 100% 全流程 | ☐ |
| D.3 | canary 回滚 | 横向 | < 5 分钟回滚演练 | ☐ |
| D.3 | RELEASE_PLAYBOOK | 横向 | 文档完整可执行 | ☐ |
| F | 主网灰度收费 | 部署 | 真实 X402 op 上链且账本对账成功 | ☐ |
| G | 多链生产部署 | 部署 | 至少 3 链 mainnet 稳定 1 周 | ☐ |

---

## F · M3 输出物清单

代码改动（新增）：
- `src/billing/x402.ts` — X402 协议封装
- `src/billing/pricing.ts` — 报价计算
- `src/billing/ledger.ts` — 内部预存账本（Redis 持久化）
- `src/billing/index.ts` — `enforceX402` 入口
- `src/billing/xpnts/collector.ts` — xPNTs 转账事件监听 + 入账
- `src/billing/xpnts/settler.ts` — 周期结算 cron
- `src/billing/eth/collector.ts` — PrepaidGas Deposited 监听
- `src/billing/eth/settler.ts` — 周期 batchSettle
- `src/billing/eth/lock.ts` — 异步 lockCharge 调用
- `src/monitoring/alertManager.ts` — 中央告警分发器
- `src/monitoring/channels/{slack,discord,pagerduty}.ts` — 三类 webhook adapter
- `src/utils/getLogsCache.ts` — LRU cache
- `src/validator/operatorAttestation.ts` — Operator attestation 校验
- `src/executor/paymasterPostOpProfile.ts` — postOp 精算 profile
- `src/executor/utilityWalletLock.ts` — Redis 分布式锁
- `src/cli/walletDerivation.ts` — 多实例 BIP-44 派生
- `src/handlers/lineaGasPriceManager.ts`（如需要） — 新链 gas manager
- `src/handlers/scrollGasPriceManager.ts`（如需要）

代码改动（扩展）：
- `src/cli/config/options.ts` — 加 M3 全部 CLI flag（billing-* / alert-* / get-logs-cache-* / operator-attestation-* / postop-profile-* / instance-* / canary-mode）
- `src/rpc/methods/eth_sendUserOperation.ts` — 入口接 enforceX402
- `src/rpc/methods/boost_sendUserOperation.ts` — 同上
- `src/rpc/methods/index.ts` — 注册 `pimlico_topupXPNTs` / `pimlico_getXPNTsBalance` / `pimlico_getETHPrepaidBalance` 等查询端点
- `src/rpc/estimation/` — 接 `getPostOpGasEstimate`
- `src/handlers/eventManager.ts` — 替换 getLogs 为 getLogsCache
- `src/cli/customTransport.ts` — 加 RPC call 计数 hook
- `src/utils/metrics.ts` — 注册全部新 metric
- `src/executor/utilityWalletMonitor.ts` — 接 alertManager
- `src/executor/executorManager.ts` — bundle revert 阈值告警

合约（新增）：
- `contracts/PrepaidGas.sol` — ETH 预存合约（含 deposit / withdraw / lockCharge / unlockCharge / batchSettle）

CI/CD：
- `.github/workflows/upstream-sync.yml` — 上游同步自动化
- `.github/workflows/deploy-canary.yml` — canary 部署 job
- `scripts/canary-smoke-test.sh` — 灰度后自动 smoke test

监控配置：
- `monitoring/grafana-dashboard.json` — Grafana dashboard 模板
- `monitoring/alert-rules.yaml` — Prometheus 告警规则示例

文档（新增）：
- `docs/M3_DESIGN.md` — 本文件
- `docs/M3_ACCEPTANCE.md` — 验收检查表（同 §E，独立成文便于打钩归档）
- `docs/X402_INTEGRATION.md` — X402 协议规范、报价语义、错误码、SDK 适配指南
- `docs/BILLING_ETH_VS_XPNTS.md` — xPNTs vs ETH 通道 trade-off 对比
- `docs/OPERATOR_ATTESTATION_SPEC.md` — Operator attestation 协议规范（三仓库共享）
- `docs/POSTOP_PROFILE_CALIBRATION.md` — postOp profile 校准流程
- `docs/MULTI_INSTANCE.md` — 多实例部署 runbook
- `docs/RELEASE_PLAYBOOK.md` — 灰度 / 回滚 playbook
- `docs/UPSTREAM_SYNC.md` — 加自动化章节（更新 M1 文档）

文档（更新）：
- `docs/CHAIN_CONFIG.md` — 加 Linea / Scroll / Base 配置矩阵
- `docs/FORK_DELTA.md` — 持续更新（新增 M3 fork 增量；PR #13 已在 M2 §4 实战验证）

Examples：
- `examples/x402-curl/` — curl + jq 协议握手示例
- `examples/x402-permissionless/` — TypeScript SDK 集成示例

不动：
- ERC-4337 standard / Pimlico 扩展 RPC 方法集（M1 已固定）
- M2 fast-lane / trusted-paymasters 通道核心逻辑
- ZeroDev boost endpoint 协议层（M1 已固定）
- SuperPaymaster 合约（不在本仓库；C.1 协议规范变更需要 SP 团队配合发版本，但本仓库不直接改 SP 合约）
- xPNTsToken 合约（不在本仓库；A.2 仅依赖既有 `addAutoApprovedSpender` / `transferFrom` 接口，不要求合约改动）

---

## G · M3 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| X402 协议规范与生态实现不一致 | SDK 接入失败 | 严格遵循 Coinbase x402/1 spec；examples 用业界 SDK 验证 |
| xPNTs 跨社区接入治理慢 | A.2 上线延迟 | 先在 1-2 个旗舰社区验证；其余按需接入；同时 A.3 ETH 通道做兜底 |
| PrepaidGas 合约 bug 吞用户预存 ETH | 资金风险 | 强制第三方审计；合约不升级（无 proxy）；金额上限保护 |
| Operator attestation 跨仓库协调超期 | C.1 推迟 | M3 内 bundler 侧做完即可，SP/AirAccount 侧推到 M4 不阻塞；本仓库提供 mock-operator e2e 验证逻辑正确性 |
| 多实例 wallet 派生密钥泄露 | 资金被盗 | 用 KMS / HSM 管 master mnemonic；派生 key 只在内存；定期轮换 |
| canary 灰度的 1% 流量打到关键大用户 | 大用户体验受损 | LB 配置基于 IP hash 排除大用户白名单 IP，确保灰度流量都是低敏感度请求 |
| xPNTs 5000 ether 单笔上限触发 | 结算失败 | settler 自动按上限拆分；超大额账户单独走多笔结算 |
| 双重收费（X402 + 外部 paymaster 自己收）| 用户多付 | 文档显式声明；SDK 检测警告；M3+ 可探索"协议级 fee 透明"机制 |
| 上游 sync 引入 breaking change | 大量手工修改 | PR 流程强制人审；CI e2e 全套通过；冲突按 FORK_DELTA.md 决策 |

---

## H · M3 → 后续切换条件

M3 §E 验收表全部打钩 + 至少 3 链 mainnet 稳定运行 1 周 + 至少一笔真实 X402 收费完整对账（上链 + 账本 + 结算）后，M3 关闭。

后续方向（M4 候选，**不在 M3 范围**）：
- 自营 bundler 控制台（Web UI 显示账本、运维操作、对账报表）
- 自动化对账与发票（X402 收入按客户聚合、月度对账单）
- bundler-as-a-service 多租户（不同租户独立 mempool / 独立 wallet pool / 独立计费）
- mev-share / private mempool 集成
- 非 EVM 链探索（Solana / TON 的等效抽象层，需要重新评估架构）
