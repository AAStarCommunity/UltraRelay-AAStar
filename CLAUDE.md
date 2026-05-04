# CLAUDE.md

## Mycelium Protocol 生态上下文

@/Users/jason/Dev/Brood/protocol/MISSION.md
@/Users/jason/Dev/Brood/orgs/aastar/PROFILE.md
@/Users/jason/Dev/Brood/orgs/aastar/INTERFACES.md

## Project Overview

This repository is the **AAStar fork of Ultra Relay**, itself a ZeroDev fork of [Pimlico's Alto](https://github.com/Pimlico/alto) — a TypeScript ERC-4337 bundler supporting EntryPoint v0.6 / v0.7 / v0.8 with chain-specific optimizations.

Important fork-specific behavior (do not regress these):
- **Relayer-without-paymaster**: zeroed `maxFeePerGas` / `maxPriorityFeePerGas` in a UserOperation are accepted and the bundler sponsors gas (ZeroDev modification).
- **AAStar additions** (see recent commits): `/wallets` HTTP endpoint that returns bundler executor addresses, RPC basic-auth on the public/wallet client transports, optional `authorizationList` on `estimateGas` when `--rpc-gas-estimate` is on, and `block-tag-support` flag controlling whether `getLogs` uses a block tag.

The packaged binary is still named `alto` for compatibility — invoke via `./alto` (which runs `src/esm/cli/alto.js`).

## Key Commands

### Development
```bash
# Install dependencies
pnpm install

# Build everything (including smart contracts)
pnpm run build

# Run in development mode with auto-reload
pnpm run dev

# Start the bundler
pnpm start

# Run tests (delegates to pnpm --filter e2e run test; e2e workspace lives at test/e2e/)
pnpm test
pnpm run test:ci          # CI mode (single run, no watch)
pnpm run test:spec        # ERC-4337 bundler-spec-tests via test/spec-tests/run-spec-tests.sh

# Run a single e2e test (note the directory is test/e2e, NOT e2e)
cd test/e2e && pnpm test -t "test name"

# Lint and format
pnpm run lint             # biome check .
pnpm run lint:fix         # biome check --apply
pnpm run format           # biome format --write
```

Local stack helper: `scripts/run-local-instance.sh` boots an Anvil node, deploys EntryPoints, and starts the bundler. See `scripts/README.md`.

Minimal manual run (matches README example — needs at least one EntryPoint, an executor key, a utility key, and an RPC URL):
```bash
./alto \
  --entrypoints "0x5ff1...2789,0x0000...a032" \
  --executor-private-keys "..." \
  --utility-private-key "..." \
  --min-balance "0" \
  --rpc-url "http://localhost:8545" \
  --network-name "local"
# ./alto help  → list every flag (defined in src/cli/config/options.ts)
```

### Smart Contract Commands
Foundry project lives in `contracts/` and outputs ABIs/bytecode into `src/contracts/`. Each EntryPoint version pins its own solc/EVM version, so use the specific scripts (NOT a generic `build:contracts-v06`):
```bash
pnpm run build:contracts                          # build everything
pnpm run build:contracts:PimlicoSimulations
pnpm run build:contracts:EPFilterOpsOverride06    # solc 0.8.17 / london
pnpm run build:contracts:EPFilterOpsOverride07    # solc 0.8.23 / paris
pnpm run build:contracts:EPFilterOpsOverride08    # solc 0.8.28 / cancun
pnpm run build:contracts:EPGasEstimationOverride06
pnpm run build:contracts:EPSimulations07
pnpm run build:contracts:EPSimulations08
```
`pnpm run prepare` runs `build:contracts` then `build`, so a fresh checkout only needs `pnpm install`.

## Architecture Overview

### Core Modules
- **`src/cli/`**: CLI entry, option parsing, dependency wiring (`alto.ts` → `handler.ts` → `setupServer.ts`); `customTransport.ts` adds the basic-auth-aware viem transport.
- **`src/rpc/`**: Fastify JSON-RPC server (`server.ts`) and dispatcher (`rpcHandler.ts`).
  - `methods/`: one file per RPC method (`eth_*`, `pimlico_*`, `debug_bundler_*`, `boost_sendUserOperation`); register in `methods/index.ts`.
  - `validation/`: `SafeValidator` (ERC-4337 safe-mode, tracer-based) and `UnsafeValidator`, plus per-version `BundlerCollectorTracerV0{6,7}` and `TracerResultParserV0{6,7}`.
  - `estimation/`: gas estimation pipelines used by `eth_estimateUserOperationGas`.
- **`src/executor/`**: Bundle building and submission.
  - `executorManager.ts` / `bundleManager.ts` / `executor.ts`: orchestration and submission strategy.
  - `senderManager/`: pool of executor wallets keyed by `--executor-private-keys`.
  - `filterOpsAndEstimateGas.ts`: pre-flight via the `EntryPointFilterOpsOverride0{6,7,8}` contracts.
  - `utilityWalletMonitor.ts`: warns/refills the utility wallet.
- **`src/mempool/`**: `mempool.ts` (in-memory userOp pool), `reputationManager.ts` (ERC-7562 reputation), `monitoring.ts`.
- **`src/store/`**: Pluggable storage. `createStore.ts` picks between `createMemoryOutstandingStore` / `createRedisOutstandingStore` based on `--redis-*` flags; `createMempoolStore` and `createRedisStore` back the persistent state.
- **`src/handlers/`**: Chain-specific gas oracles (`gasPriceManager.ts` default; `arbitrumGasPriceManager`, `optimismManager`, `mantleGasPriceManager`) plus `eventManager.ts`.
- **`src/receiptCache/`**: Caches `eth_getTransactionReceipt` lookups.
- **`src/types/`**: Zod schemas (`schemas.ts` is the single source of truth for RPC types), branded types, interfaces.
- **`src/utils/`**: Shared utilities (BigInt math, viem error walking, log helpers).
- **`contracts/`**: Foundry project producing the EntryPoint override + simulation contracts consumed by the bundler.

### Key Design Patterns
1. **Multi-version Support**: v0.6 / v0.7 / v0.8 logic is split into per-version files (look for `*V06`, `*V07`, `*V08` suffixes) — when changing one version, audit the other two.
2. **Chain Abstraction**: Chain-specific logic stays inside `src/handlers/`, registered via the gas price manager factory.
3. **Storage Flexibility**: All store consumers depend on the `Store` interface; in-memory and Redis implementations must stay behaviorally identical.
4. **Executor Strategies**: Supports different bundle submission strategies (e.g. conditional, Flashbots) selected at startup.
5. **Comprehensive Validation**: Simulation, reputation, paymaster checks, and tracer-based opcode rule enforcement layered behind the validator interface.

### Important Files
- `src/cli/config/options.ts` — full CLI flag definitions (the source of truth; `./alto help` is generated from it).
- `src/cli/config/bundler.ts` — bundler-mode option groups.
- `src/cli/setupServer.ts` — wires every dependency together; start here when tracing how a flag becomes runtime behavior.
- `src/executor/executorManager.ts` / `executor.ts` — bundle submission lifecycle.
- `src/mempool/mempool.ts` — userOp pool semantics.
- `src/rpc/server.ts` — Fastify server, including the `/wallets` HTTP route.
- `src/rpc/rpcHandler.ts` — JSON-RPC dispatch.
- `src/rpc/validation/{Safe,Unsafe}Validator.ts` — validation entry points.
- `src/types/schemas.ts` — Zod schemas for all RPC payloads.

## Technical Stack
- **Runtime**: Node.js 18+ with ESM modules
- **Language**: TypeScript 5.x with strict mode
- **Web Framework**: Fastify for HTTP/WebSocket
- **Smart Contracts**: Solidity with Foundry toolchain
- **Storage**: Redis (optional) or in-memory
- **Monitoring**: OpenTelemetry, Prometheus metrics
- **Code Quality**: Biome for linting/formatting
- **Testing**: Vitest for e2e tests
- **Validation**: Zod for runtime type validation
- **Logging**: Pino with custom serializers

## Development Tips
1. The project uses pnpm workspaces - always use `pnpm` instead of `npm` or `yarn`
2. Smart contracts must be built before running the bundler
3. For debugging, enable verbose logging with `--verbose` flag
4. Use `--dangerous-skip-user-operation-validation` only for testing
5. The bundler requires an Ethereum node with `debug_traceCall` support

## Testing Approach
- E2E tests live in `test/e2e/` (Vitest). Configured by `test/e2e/vitest.config.ts`; shared setup in `test/e2e/setup.ts` and `alto-config.json`.
- `test/e2e/deploy-contracts/` holds the EntryPoint deployment fixtures spun up before each run.
- Tests boot a local Anvil instance via `prool` and exercise the bundler over real JSON-RPC.
- Bundler-spec compliance is checked separately by `pnpm run test:spec` (requires a node with `debug_traceCall`, e.g. Geth, and the bundler started with `--environment development --bundleMode manual --safeMode true`).
- Foundry must be installed locally for both flows.

## Common Tasks

### Adding a New Chain Handler
1. Create a new handler in `src/handlers/`
2. Implement the `GasPriceManager` interface
3. Register in the appropriate version's handler factory

### Adding a New RPC Endpoint
1. Add the schema for your new endpoint in `src/types/schemas.ts`:
   - Define the schema using Zod (e.g., `pimlicoNewEndpointSchema`)
   - Add it to both `bundlerRequestSchema` and `bundlerRpcSchema` unions
2. Create a new file in `src/rpc/methods/` following the naming convention (e.g., `pimlico_newEndpoint.ts`)
3. Implement the endpoint handler following the existing pattern using `createMethodHandler`
4. Import and register the handler in `src/rpc/methods/index.ts`
5. The endpoint will be automatically registered with the RPC server

### Modifying RPC Methods
1. Update the method in `src/rpc/methods/`
2. Ensure compatibility across all supported versions
3. Update validation logic if needed

### Working with User Operations
- Validation logic is in `src/rpc/validation/` (Safe vs Unsafe validators, plus per-version tracers/parsers)
- Mempool operations are in `src/mempool/`
- Execution logic is in `src/executor/`

## Code Style and Best Practices

### TypeScript Configuration
- **Strict Mode**: Always enabled with additional checks
- **Module System**: ESM with `@alto/*` aliases for internal imports
- **Target**: ESNext for modern JavaScript features
- **Type Safety**: Never use `any` type - use proper type definitions, `unknown`, or type assertions when needed

### Coding Conventions

#### Naming Conventions
- **Interfaces**: Prefixed with `Interface` (e.g., `InterfaceValidator`)
- **Types**: PascalCase for type definitions
- **Files**: kebab-case for filenames (e.g., `gas-price-manager.ts`)
- **Constants**: UPPER_SNAKE_CASE for constants
- **Functions/Methods**: camelCase
- **UserOperation Naming**: 
  - **Local variables and parameters**: Use `userOp` (e.g., `submittedUserOp`, `validUserOp`, `queuedUserOps`)
  - **Local method names**: Use `userOp` (e.g., `dropUserOps`, `addUserOp`, `getUserOpHash`)
  - **RPC endpoints**: Use full `userOperation` name (e.g., `eth_sendUserOperation`)
  - **Types and interfaces**: Use full `UserOperation` name (e.g., `UserOperationV07`, `PackedUserOperation`)
  - **Zod schemas**: Use full `userOperation` name (e.g., `userOperationSchema`, `userOperationV06Schema`)
  - **Solidity contracts**: Use full `UserOperation` name
  - **Inline comments**: Use full `userOperation` when referring to the concept

#### Import Organization
1. External dependencies
2. Internal type imports (`import type { ... } from "@alto/types"`)
3. Internal module imports (`import { ... } from "@alto/utils"`)
4. Relative imports

#### Function Patterns
```typescript
// Use object destructuring for multiple parameters
async function functionName({
    param1,
    param2
}: {
    param1: Type1
    param2: Type2
}): Promise<ReturnType> {
    // Implementation
}
```

#### Error Handling
- Use custom error classes (e.g., `RpcError`)
- Include specific error codes from enums
- Walk error chains for Viem errors
- Return error tuples for non-throwing operations

#### Logging
- Use structured logging with Pino
- Create child loggers with context
- Convert BigInts to hex strings in logs
- Include relevant data in log objects

### Validation Patterns
- Use Zod schemas for runtime validation
- Transform values in schemas (e.g., `transform((val) => val as Hex)`)
- Create branded types for type safety
- Validate at system boundaries (RPC, storage)

### Testing Guidelines
- Use Vitest with `describe.each` for version testing
- Follow Arrange-Act-Assert pattern
- Use `beforeEach` for test setup
- Test against real blockchain (Anvil) when possible

### Dependency Injection
- Constructor-based injection
- Pass configuration and dependencies as objects
- Use interfaces for testability

### Async Best Practices
- Use `Promise.all` for parallel operations
- Proper error handling in try-catch blocks
- Explicit return types for async functions

### RPC and HTTP Communication
- **Important**: When making RPC calls for methods that are not natively supported by viem, use the viem client's `request` method
- The viem `Client` type provides a `request` method for custom RPC calls: `client.request({ method: 'custom_method', params: [...] })`
- Only use this for non-standard RPC methods (e.g., `debug_traceCall`, custom bundler methods)
- For standard methods, use viem's built-in functions (e.g., `client.getBalance()` instead of `client.request({ method: 'eth_getBalance' })`)

### Module Structure
- Export public API through index files
- Keep version-specific logic in separate directories
- Use factory pattern for creating handlers

### Code Formatting
- **Indentation**: 4 spaces
- **Line Width**: 80 characters
- **Semicolons**: Omitted where possible
- **Trailing Commas**: None
- Run `pnpm run format` before committing

### Utility Functions
When working with BigInt calculations, use the utility functions from `@alto/utils`:
- **scaleBigIntByPercent**: Scale a BigInt by a percentage (e.g., `scaleBigIntByPercent(value, 150n)` for 150%)
- **minBigInt/maxBigInt**: Get min/max of two BigInts
- **roundUpBigInt**: Round up to nearest multiple
- Never use manual percentage calculations like `(value * 150n) / 100n`

### Performance Considerations
- Batch operations when possible
- Use efficient data structures
- Minimize BigInt conversions
- Cache expensive computations

### Security Best Practices
- Never log sensitive data (private keys, etc.)
- Validate all external inputs
- Use checksummed addresses
- Follow ERC-4337 security guidelines
