import { createWalletClient, http, publicActions } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { pino } from 'pino';
import * as dotenv from 'dotenv';

dotenv.config();

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * Recognizable stub address for DRY_RUN mode. Trailing "dEaD" makes it
 * obvious in logs that no real wallet is in use. Never appears on-chain.
 */
export const DRY_RUN_ADDRESS = '0x000000000000000000000000000000000000dEaD' as const;

/**
 * Build a stub wallet for DRY_RUN mode.
 *
 * Active only when DRY_RUN=true AND no PRIVATE_KEY is set. Production
 * safety is preserved: no key + DRY_RUN unset still throws as before.
 *
 * Shape matches the real return ({ client, account }) so call sites in
 * run.ts / dashboard.ts / OrderSigner work unchanged.
 *
 * - account.address returns DRY_RUN_ADDRESS
 * - account / client signing methods throw "DRY_RUN — signing disabled"
 * - client read-only chain queries return 0n stubs
 */
function makeDryRunWallet() {
    const throwSigning = (): never => {
        throw new Error('DRY_RUN — signing disabled (no PRIVATE_KEY in environment)');
    };

    const account = new Proxy({} as any, {
        get(_t, prop) {
            if (prop === 'address') return DRY_RUN_ADDRESS;
            if (prop === 'type') return 'local';
            if (prop === 'source') return 'dry-run';
            if (prop === 'publicKey') return '0x';
            // Any other property — including signMessage, signTypedData,
            // signTransaction — resolves to a function that throws.
            return throwSigning;
        },
    });

    const client = new Proxy({} as any, {
        get(_t, prop) {
            if (prop === 'account') return account;
            if (prop === 'chain') return base;
            if (prop === 'transport') return undefined;
            // Read-only chain queries: return harmless stubs so balance
            // checks etc. don't crash the bot.
            if (prop === 'getBalance') return async () => 0n;
            if (prop === 'readContract') return async () => 0n;
            if (prop === 'getBlockNumber') return async () => 0n;
            if (prop === 'getChainId') return async () => base.id;
            // Anything else (write methods, signing): throw.
            return throwSigning;
        },
    });

    return { client, account };
}

function getRealWallet(privateKey: string) {
    if (!privateKey.startsWith('0x')) {
        privateKey = `0x${privateKey}`;
    }
    if (!privateKey.startsWith('0x') || privateKey.length !== 66) {
        logger.fatal('Invalid PRIVATE_KEY format. Must be 0x-prefixed 32-byte hex string.');
        throw new Error('Invalid PRIVATE_KEY format');
    }

    const account = privateKeyToAccount(privateKey as `0x${string}`);

    const client = createWalletClient({
        account,
        chain: base,
        transport: http(),
    }).extend(publicActions);

    logger.info({ address: account.address }, 'Wallet initialized');

    return { client, account };
}

export function getWallet(): ReturnType<typeof getRealWallet> {
    const privateKey = process.env.PRIVATE_KEY;

    if (!privateKey) {
        if (process.env.DRY_RUN === 'true') {
            logger.warn({ address: DRY_RUN_ADDRESS }, '[wallet] DRY_RUN — returning stub wallet, signing disabled');
            return makeDryRunWallet() as ReturnType<typeof getRealWallet>;
        }
        logger.fatal('PRIVATE_KEY is not set in environment variables');
        throw new Error('PRIVATE_KEY is required');
    }

    return getRealWallet(privateKey);
}
