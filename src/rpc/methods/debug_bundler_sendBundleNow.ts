import { debugSendBundleNowSchema } from "@alto/types"
import { createMethodHandler } from "../createMethodHandler"

export const debugBundlerSendBundleNowHandler = createMethodHandler({
    method: "debug_bundler_sendBundleNow",
    schema: debugSendBundleNowSchema,
    handler: async ({ rpcHandler }) => {
        rpcHandler.ensureDebugEndpointsAreEnabled("debug_bundler_sendBundleNow")

        const bundles = await rpcHandler.mempool.getBundles(1)

        if (bundles.length === 0 || bundles[0].userOps.length === 0) {
            throw new Error("no userOps in mempool")
        }

        let submitted = false
        for (const bundle of bundles) {
            const txHash =
                await rpcHandler.executorManager.sendBundleToExecutor(bundle)
            if (txHash) {
                submitted = true
            }
        }

        if (!submitted) {
            throw new Error("no tx hash")
        }

        return "ok" as const
    }
})
