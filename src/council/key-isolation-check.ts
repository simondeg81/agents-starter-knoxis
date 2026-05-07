import { accessSync, constants } from 'node:fs';

export type AccessFn = (path: string, mode: number) => void;

export class KeyIsolationViolation extends Error {
  constructor(path: string) {
    super(
      'Council is running with too much privilege -- fix file permissions before starting. ' +
      `Readable file: ${path}`
    );
    this.name = 'KeyIsolationViolation';
  }
}

/**
 * Verify the Council process cannot read the wallet private key file.
 *
 * Called at process start. The Council MUST NOT be able to open the
 * trader's signing key -- that is the entire point of running it under
 * a separate Linux user with chmod 700 on the keys directory.
 *
 * Behaviour:
 *  - Access succeeds (file readable)         -> throw KeyIsolationViolation
 *  - EACCES / EPERM (file unreadable)        -> OK, return
 *  - ENOENT (file missing)                   -> OK, return
 *  - Any other I/O error                     -> rethrow (operator visibility)
 */
export function assertKeyIsolation(
  keyPath: string,
  accessFn: AccessFn = (p, m) => accessSync(p, m)
): void {
  try {
    accessFn(keyPath, constants.R_OK);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'ENOENT') {
      return;
    }
    throw err;
  }
  throw new KeyIsolationViolation(keyPath);
}
