import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getWallet, DRY_RUN_ADDRESS } from '../wallet.js';

// Well-known anvil/hardhat test private key. Public knowledge, never used
// on real funds. Address derived deterministically by privateKeyToAccount:
// 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDR = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';

describe('getWallet', () => {
    let originalKey: string | undefined;
    let originalDryRun: string | undefined;

    beforeEach(() => {
        originalKey = process.env.PRIVATE_KEY;
        originalDryRun = process.env.DRY_RUN;
        delete process.env.PRIVATE_KEY;
        delete process.env.DRY_RUN;
    });

    afterEach(() => {
        if (originalKey !== undefined) process.env.PRIVATE_KEY = originalKey;
        else delete process.env.PRIVATE_KEY;
        if (originalDryRun !== undefined) process.env.DRY_RUN = originalDryRun;
        else delete process.env.DRY_RUN;
    });

    it('throws when PRIVATE_KEY missing AND DRY_RUN unset (prod safety)', () => {
        expect(() => getWallet()).toThrow('PRIVATE_KEY is required');
    });

    it('throws when PRIVATE_KEY missing AND DRY_RUN=false (prod safety)', () => {
        process.env.DRY_RUN = 'false';
        expect(() => getWallet()).toThrow('PRIVATE_KEY is required');
    });

    it('returns DRY_RUN stub when PRIVATE_KEY missing AND DRY_RUN=true', () => {
        process.env.DRY_RUN = 'true';
        const { client, account } = getWallet();
        expect(account.address).toBe(DRY_RUN_ADDRESS);
        expect(client).toBeDefined();
        expect((client as any).account).toBe(account);
        expect(account.type).toBe('local');
    });

    it('DRY_RUN stub throws on signing methods with clear DRY_RUN message', () => {
        process.env.DRY_RUN = 'true';
        const { client, account } = getWallet();
        const re = /DRY_RUN — signing disabled/;
        expect(() => (account as any).signMessage({ message: 'x' })).toThrow(re);
        expect(() => (account as any).signTypedData({})).toThrow(re);
        expect(() => (account as any).signTransaction({})).toThrow(re);
        expect(() => (client as any).signTransaction({})).toThrow(re);
        expect(() => (client as any).sendTransaction({})).toThrow(re);
        expect(() => (client as any).writeContract({})).toThrow(re);
    });

    it('returns real wallet (not stub) when PRIVATE_KEY is present', () => {
        process.env.PRIVATE_KEY = TEST_KEY;
        const { client, account } = getWallet();
        expect(account.address).not.toBe(DRY_RUN_ADDRESS);
        expect(account.address.toLowerCase()).toBe(TEST_ADDR);
        expect(client).toBeDefined();
        // Real account has a real signMessage function — calling it would
        // succeed; we just check it doesn't throw the DRY_RUN error.
        expect(typeof account.signMessage).toBe('function');
    });
});
