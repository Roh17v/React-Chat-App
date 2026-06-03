// @ts-check
/**
 * Unit tests for the Encryption_Layer.
 *
 * Covers task 4.2 — Requirements 10.2, 10.4, 10.6:
 *
 *   - First run / secure-store available: `getOrCreatePassphrase` generates 32
 *     random bytes, hex-encodes them, and forwards the result to
 *     `setEncryptionSecret`. The returned `passphrase` is non-empty so the
 *     immediately following `createConnection(..., encrypted=true,
 *     mode="secret")` call succeeds.
 *
 *   - Subsequent run / key already present: `setEncryptionSecret` is NOT
 *     called and the returned `passphrase` is empty (the plugin holds the
 *     key in its secret store).
 *
 *   - Failure / secure-store unavailable: every failure shape falls through
 *     to `{ mode: "none", passphrase: "" }` AND emits an
 *     `ENCRYPTION_FALLBACK` diagnostic. The DB will be opened unencrypted by
 *     the boot path (Req 10.4).
 *
 *   - `rotate()` and `destroy()` invoke the matching plugin methods.
 *
 *   - `diagnoseAvailability()` returns `{ available: true }` when the secret
 *     store is reachable and `{ available: false, reason }` otherwise. The
 *     non-native runtime is treated as unavailable (Req 10.4).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { createEncryptionLayer } from "./EncryptionLayer.js";

/**
 * Build a fresh sqlite mock with vi spies for every secret-store method.
 *
 * @param {Partial<{
 *   isSecretStored: () => Promise<unknown>,
 *   setEncryptionSecret: (p: string) => Promise<unknown>,
 *   changeEncryptionSecret: (n: string, o: string) => Promise<unknown>,
 *   clearEncryptionSecret: () => Promise<unknown>,
 * }>} [overrides]
 */
function makeSqliteMock(overrides = {}) {
  return {
    isSecretStored: vi.fn(
      overrides.isSecretStored ?? (async () => ({ result: false })),
    ),
    setEncryptionSecret: vi.fn(overrides.setEncryptionSecret ?? (async () => undefined)),
    changeEncryptionSecret: vi.fn(
      overrides.changeEncryptionSecret ?? (async () => undefined),
    ),
    clearEncryptionSecret: vi.fn(overrides.clearEncryptionSecret ?? (async () => undefined)),
  };
}

/** Build a diagnostics double with a `vi.fn()` log spy. */
function makeDiagnosticsMock() {
  return { log: vi.fn() };
}

/**
 * Deterministic 32-byte buffer (0x00..0x1f) for hex assertions.
 */
function fixedRandomBytes(byteLength) {
  const buf = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i += 1) buf[i] = i;
  return buf;
}

const FIXED_HEX_32 = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getOrCreatePassphrase — first run on a native platform with secure store", () => {
  it("generates 32 bytes, hex-encodes them, and calls setEncryptionSecret", async () => {
    const sqlite = makeSqliteMock();
    const diagnostics = makeDiagnosticsMock();
    const layer = createEncryptionLayer({
      sqlite,
      diagnostics,
      isNativePlatform: () => true,
      randomBytes: fixedRandomBytes,
    });

    const result = await layer.getOrCreatePassphrase();

    expect(result).toEqual({ mode: "secure", passphrase: FIXED_HEX_32 });
    expect(sqlite.isSecretStored).toHaveBeenCalledTimes(1);
    expect(sqlite.setEncryptionSecret).toHaveBeenCalledTimes(1);
    expect(sqlite.setEncryptionSecret).toHaveBeenCalledWith(FIXED_HEX_32);
    expect(diagnostics.log).not.toHaveBeenCalled();
  });

  it("uses 32 bytes from the supplied randomness source", async () => {
    const sqlite = makeSqliteMock();
    const randomBytes = vi.fn(fixedRandomBytes);
    const layer = createEncryptionLayer({
      sqlite,
      diagnostics: makeDiagnosticsMock(),
      isNativePlatform: () => true,
      randomBytes,
    });

    await layer.getOrCreatePassphrase();

    expect(randomBytes).toHaveBeenCalledTimes(1);
    expect(randomBytes).toHaveBeenCalledWith(32);
  });

  it("treats a bare-boolean isSecretStored result as equivalent to { result }", async () => {
    const sqlite = makeSqliteMock({ isSecretStored: async () => false });
    const layer = createEncryptionLayer({
      sqlite,
      diagnostics: makeDiagnosticsMock(),
      isNativePlatform: () => true,
      randomBytes: fixedRandomBytes,
    });

    const result = await layer.getOrCreatePassphrase();

    expect(result.mode).toBe("secure");
    expect(sqlite.setEncryptionSecret).toHaveBeenCalledWith(FIXED_HEX_32);
  });
});

describe("getOrCreatePassphrase — subsequent run, key already provisioned", () => {
  it("returns mode='secure' with empty passphrase and does not call setEncryptionSecret", async () => {
    const sqlite = makeSqliteMock({ isSecretStored: async () => ({ result: true }) });
    const diagnostics = makeDiagnosticsMock();
    const layer = createEncryptionLayer({
      sqlite,
      diagnostics,
      isNativePlatform: () => true,
      randomBytes: fixedRandomBytes,
    });

    const result = await layer.getOrCreatePassphrase();

    expect(result).toEqual({ mode: "secure", passphrase: "" });
    expect(sqlite.isSecretStored).toHaveBeenCalledTimes(1);
    expect(sqlite.setEncryptionSecret).not.toHaveBeenCalled();
    expect(diagnostics.log).not.toHaveBeenCalled();
  });
});

describe("getOrCreatePassphrase — secure-store unavailable falls back to mode='none'", () => {
  it("falls back when the platform is not native", async () => {
    const sqlite = makeSqliteMock();
    const diagnostics = makeDiagnosticsMock();
    const layer = createEncryptionLayer({
      sqlite,
      diagnostics,
      isNativePlatform: () => false,
      randomBytes: fixedRandomBytes,
    });

    const result = await layer.getOrCreatePassphrase();

    expect(result).toEqual({ mode: "none", passphrase: "" });
    expect(sqlite.isSecretStored).not.toHaveBeenCalled();
    expect(sqlite.setEncryptionSecret).not.toHaveBeenCalled();
    expect(diagnostics.log).toHaveBeenCalledTimes(1);
    const event = diagnostics.log.mock.calls[0][0];
    expect(event.code).toBe("ENCRYPTION_FALLBACK");
    expect(event.category).toBe("encryption");
    expect(event.outcome).toBe("warn");
    expect(event.meta).toMatchObject({ reason: "PLATFORM_UNSUPPORTED" });
  });

  it("falls back when isSecretStored throws", async () => {
    const sqlite = makeSqliteMock({
      isSecretStored: async () => {
        throw new Error("keystore not initialized");
      },
    });
    const diagnostics = makeDiagnosticsMock();
    const layer = createEncryptionLayer({
      sqlite,
      diagnostics,
      isNativePlatform: () => true,
      randomBytes: fixedRandomBytes,
    });

    const result = await layer.getOrCreatePassphrase();

    expect(result).toEqual({ mode: "none", passphrase: "" });
    expect(sqlite.setEncryptionSecret).not.toHaveBeenCalled();
    expect(diagnostics.log).toHaveBeenCalledTimes(1);
    const event = diagnostics.log.mock.calls[0][0];
    expect(event.code).toBe("ENCRYPTION_FALLBACK");
    expect(event.meta).toMatchObject({
      stage: "isSecretStored",
      reason: "keystore not initialized",
    });
  });

  it("falls back when setEncryptionSecret throws on first run", async () => {
    const sqlite = makeSqliteMock({
      setEncryptionSecret: async () => {
        throw new Error("plugin unsupported");
      },
    });
    const diagnostics = makeDiagnosticsMock();
    const layer = createEncryptionLayer({
      sqlite,
      diagnostics,
      isNativePlatform: () => true,
      randomBytes: fixedRandomBytes,
    });

    const result = await layer.getOrCreatePassphrase();

    expect(result).toEqual({ mode: "none", passphrase: "" });
    expect(sqlite.setEncryptionSecret).toHaveBeenCalledTimes(1);
    expect(diagnostics.log).toHaveBeenCalledTimes(1);
    const event = diagnostics.log.mock.calls[0][0];
    expect(event.code).toBe("ENCRYPTION_FALLBACK");
    expect(event.meta).toMatchObject({
      stage: "setEncryptionSecret",
      reason: "plugin unsupported",
    });
  });

  it("falls back when randomBytes throws", async () => {
    const sqlite = makeSqliteMock();
    const diagnostics = makeDiagnosticsMock();
    const layer = createEncryptionLayer({
      sqlite,
      diagnostics,
      isNativePlatform: () => true,
      randomBytes: () => {
        throw new Error("no entropy");
      },
    });

    const result = await layer.getOrCreatePassphrase();

    expect(result).toEqual({ mode: "none", passphrase: "" });
    expect(sqlite.setEncryptionSecret).not.toHaveBeenCalled();
    expect(diagnostics.log).toHaveBeenCalledTimes(1);
    const event = diagnostics.log.mock.calls[0][0];
    expect(event.code).toBe("ENCRYPTION_FALLBACK");
    expect(event.outcome).toBe("error");
    expect(event.meta).toMatchObject({ stage: "randomBytes", reason: "no entropy" });
  });
});

describe("rotate", () => {
  it("calls changeEncryptionSecret with a freshly generated 32-byte hex passphrase", async () => {
    const sqlite = makeSqliteMock();
    const layer = createEncryptionLayer({
      sqlite,
      diagnostics: makeDiagnosticsMock(),
      isNativePlatform: () => true,
      randomBytes: fixedRandomBytes,
    });

    await layer.rotate();

    expect(sqlite.changeEncryptionSecret).toHaveBeenCalledTimes(1);
    const [newPass, oldPass] = sqlite.changeEncryptionSecret.mock.calls[0];
    expect(newPass).toBe(FIXED_HEX_32);
    expect(typeof oldPass).toBe("string");
  });
});

describe("destroy", () => {
  it("calls clearEncryptionSecret exactly once", async () => {
    const sqlite = makeSqliteMock();
    const layer = createEncryptionLayer({
      sqlite,
      diagnostics: makeDiagnosticsMock(),
      isNativePlatform: () => true,
      randomBytes: fixedRandomBytes,
    });

    await layer.destroy();

    expect(sqlite.clearEncryptionSecret).toHaveBeenCalledTimes(1);
  });

  it("propagates errors from clearEncryptionSecret", async () => {
    const sqlite = makeSqliteMock({
      clearEncryptionSecret: async () => {
        throw new Error("boom");
      },
    });
    const layer = createEncryptionLayer({
      sqlite,
      diagnostics: makeDiagnosticsMock(),
      isNativePlatform: () => true,
      randomBytes: fixedRandomBytes,
    });

    await expect(layer.destroy()).rejects.toThrow("boom");
  });
});

describe("diagnoseAvailability", () => {
  it("returns { available: true } when isSecretStored resolves", async () => {
    const sqlite = makeSqliteMock();
    const layer = createEncryptionLayer({
      sqlite,
      diagnostics: makeDiagnosticsMock(),
      isNativePlatform: () => true,
      randomBytes: fixedRandomBytes,
    });

    const out = await layer.diagnoseAvailability();
    expect(out).toEqual({ available: true });
  });

  it("returns { available: false, reason } when isSecretStored throws", async () => {
    const sqlite = makeSqliteMock({
      isSecretStored: async () => {
        throw new Error("keystore locked");
      },
    });
    const layer = createEncryptionLayer({
      sqlite,
      diagnostics: makeDiagnosticsMock(),
      isNativePlatform: () => true,
      randomBytes: fixedRandomBytes,
    });

    const out = await layer.diagnoseAvailability();
    expect(out).toEqual({ available: false, reason: "keystore locked" });
  });

  it("returns { available: false, reason: 'PLATFORM_UNSUPPORTED' } off-native", async () => {
    const sqlite = makeSqliteMock();
    const layer = createEncryptionLayer({
      sqlite,
      diagnostics: makeDiagnosticsMock(),
      isNativePlatform: () => false,
      randomBytes: fixedRandomBytes,
    });

    const out = await layer.diagnoseAvailability();
    expect(out).toEqual({ available: false, reason: "PLATFORM_UNSUPPORTED" });
    expect(sqlite.isSecretStored).not.toHaveBeenCalled();
  });
});
