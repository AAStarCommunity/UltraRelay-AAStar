import { type Address, getAddress, isAddress } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import { beforeEach, describe, expect, inject, test } from "vitest"
import altoConfig from "../alto-config.json" with { type: "json" }
import { beforeEachCleanUp } from "../src/utils/index.js"

// Endpoint contract (src/rpc/server.ts getWallets, post upstream PR #17):
//   GET /wallets -> {
//     wallets: Address[],            // executor addresses
//     chainId: number,
//     utilityWalletAddress: Address, // utility/sponsor wallet
//     refillingWallets: Address[]    // refilling wallet pool
//   }

type WalletsResponse = {
    wallets: Address[]
    chainId: number
    utilityWalletAddress: Address
    refillingWallets: Address[]
}

const altoRpc = inject("altoRpc")
const anvilRpc = inject("anvilRpc")

// Derive expected executor addresses from the same private keys the bundler
// is configured with (test/e2e/alto-config.json).
const expectedExecutorAddresses = altoConfig["executor-private-keys"]
    .split(",")
    .map((pk) => privateKeyToAccount(pk.trim() as `0x${string}`).address)

const fetchWallets = async (): Promise<{
    status: number
    body: WalletsResponse
}> => {
    const response = await fetch(`${altoRpc}/wallets`)
    const body = (await response.json()) as WalletsResponse
    return { status: response.status, body }
}

describe("GET /wallets", () => {
    beforeEach(async () => {
        await beforeEachCleanUp({ anvilRpc, altoRpc })
    })

    test("returns 200 with wallets, chainId, utilityWalletAddress, refillingWallets", async () => {
        const { status, body } = await fetchWallets()

        expect(status).toBe(200)
        expect(body).toHaveProperty("wallets")
        expect(body).toHaveProperty("chainId")
        expect(body).toHaveProperty("utilityWalletAddress")
        expect(body).toHaveProperty("refillingWallets")

        expect(Array.isArray(body.wallets)).toBe(true)
        expect(body.wallets.length).toBeGreaterThan(0)
        for (const wallet of body.wallets) {
            expect(isAddress(wallet)).toBe(true)
        }

        expect(body.chainId).toBe(foundry.id)
        expect(isAddress(body.utilityWalletAddress)).toBe(true)
        expect(Array.isArray(body.refillingWallets)).toBe(true)
        for (const wallet of body.refillingWallets) {
            expect(isAddress(wallet)).toBe(true)
        }
    })

    test("returned wallets match addresses derived from configured executor keys", async () => {
        const { body } = await fetchWallets()

        // Order is implementation-defined; compare as sets (lower-cased so a
        // mismatch in EIP-55 casing surfaces in the format test below).
        const returned = new Set(
            body.wallets.map((address) => address.toLowerCase())
        )
        const expected = new Set(
            expectedExecutorAddresses.map((address) => address.toLowerCase())
        )

        expect(returned).toEqual(expected)
        expect(body.wallets).toHaveLength(expectedExecutorAddresses.length)
    })

    test("each returned address is in EIP-55 checksum format", async () => {
        const { body } = await fetchWallets()

        const allAddresses = [
            ...body.wallets,
            body.utilityWalletAddress,
            ...body.refillingWallets
        ]
        for (const wallet of allAddresses) {
            // viem.getAddress throws on non-checksummed input; for already
            // valid input it returns the canonical checksummed form, which
            // must be byte-equal to what the endpoint returned.
            expect(getAddress(wallet)).toBe(wallet)
        }
    })
})
