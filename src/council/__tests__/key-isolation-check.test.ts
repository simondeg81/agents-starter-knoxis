import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertKeyIsolation,
  KeyIsolationViolation,
} from '../key-isolation-check.js';

test('throws KeyIsolationViolation when the key file is readable', () => {
  // Simulate access succeeding -- the privilege violation case.
  const fakeAccess = (_path: string, _mode: number) => {
    /* succeeds */
  };
  assert.throws(
    () => assertKeyIsolation('/fake/key', fakeAccess),
    (err: unknown) => err instanceof KeyIsolationViolation
  );
});

test('returns OK when access throws EACCES (correct isolation)', () => {
  const fakeAccess = (_path: string, _mode: number) => {
    const e = new Error('EACCES') as NodeJS.ErrnoException;
    e.code = 'EACCES';
    throw e;
  };
  assert.doesNotThrow(() => assertKeyIsolation('/fake/key', fakeAccess));
});

test('returns OK when access throws EPERM', () => {
  const fakeAccess = (_path: string, _mode: number) => {
    const e = new Error('EPERM') as NodeJS.ErrnoException;
    e.code = 'EPERM';
    throw e;
  };
  assert.doesNotThrow(() => assertKeyIsolation('/fake/key', fakeAccess));
});

test('returns OK when the key file is missing (ENOENT)', () => {
  const fakeAccess = (_path: string, _mode: number) => {
    const e = new Error('ENOENT') as NodeJS.ErrnoException;
    e.code = 'ENOENT';
    throw e;
  };
  assert.doesNotThrow(() => assertKeyIsolation('/fake/key', fakeAccess));
});

test('rethrows unexpected I/O errors so operators see them', () => {
  const fakeAccess = (_path: string, _mode: number) => {
    const e = new Error('disk on fire') as NodeJS.ErrnoException;
    e.code = 'EIO';
    throw e;
  };
  assert.throws(
    () => assertKeyIsolation('/fake/key', fakeAccess),
    /disk on fire/
  );
});
