// @ts-check
/**
 * Encryption_Layer for the offline store.
 *
 * Implements §3.8 of the offline-support design and Requirements 10.1, 10.2,
 * 10.3, 10.4, 10.6.
 *
 * Responsibilities:
 *   - Generate a 256-bit (32-byte) symmetric key on first run and hand it to
 *     the `@capacitor-community/sqlite` plugin's secret store
 *     (`setEncryptionSecret`). The plugin then stores it in the platform-native
 *     keystore (Android `EncryptedSharedPreferences` backed by the Keystore;
 *     iOS Keychain).
 *   - Re-use the existing key on subsequent runs; the plugin reads it back
 *     from the secret store when the DB is opened with `mode="secret"`. The
 *     raw passphrase is therefore not surfaced on subsequent runs (Req 10.3).
 *   - Provide `rotate()` and `destroy()` thin wrappers over the corresponding
 *     plugin APIs.
 *   - Provide `diagnoseAvailability()` that probes whether the secret store
 *     is reachable, used by the boot path to decide between the encrypted
 *     and the unencrypted fallback (Req 10.4).
 *
 * On any secure-store failure (`isSecretStored` throws, `setEncryptionSecret`
 * throws / unsupported, or the platform is not native), `getOrCreatePassphrase`
 * resolves to `{ mode: "none", passphrase: "" }` and logs an
 * `ENCRYPTION_FALLBACK` diagnostic. The boot path is then expected to open the
 * DB with `encrypted=false` and to set `meta.local_encryption = "none"`
 * (Req 10.4). The DB still lives inside the app-private sandbox.
 *
 * The module exposes a factory (`createEncryptionLayer({ sqlite, diagnostics,
 * isNativePlatform, randomBytes })`) so unit tests can inject mocks. Production
 * call sites should use the convenience export `getEncryptionLayer()` which
 * binds to a `new SQLiteConnection(CapacitorSQLite)` and the singleton
 * Diagnostics instance.
 *
 * @module offline/services/EncryptionLayer
 */

import { SQLiteConnection, CapacitorSQLite } from "@capacitor-community/sqlite";
import { Capacitor } from "@capacitor/core";

import { getDiagnostics } from "../utils/Diagnostics.js";

/**
 * Number of bytes in the generated passphrase (32 bytes = 256 bits — see Req
 * 10.2). The plugin's `setEncryptionSecret` accepts a string, so we hex-encode.
 */
const PASSPHRASE_BYTES = 32;

/**
 * @typedef {Object} EncryptionPassphraseResult
 * @property {"secure" | "none"} mode
 *   `"secure"` means the secret store is in use and the DB should be opened
 *   with `encrypted=true, mode="secret"`. `"none"` means the secret store is
 *   unavailable; the DB must be opened unencrypted and `meta.local_encryption`
 *   set to `"none"`.
 * @property {string} passphrase
 *   Non-empty hex string only when this call just generated the key. Empty
 *   string on subsequent runs (the plugin already holds it) and on the
 *   `"none"` fallback. Callers MUST NOT persist or log this value.
 */

/**
 * @typedef {Object} EncryptionAvailability
 * @property {boolean} available
 * @property {string} [reason]
 */

/**
 * @typedef {Object} EncryptionLayer
 * @property {() => Promise<EncryptionPassphraseResult>} getOrCreatePassphrase
 * @property {() => Promise<void>} rotate
 * @property {() => Promise<void>} destroy
 * @property {() => Promise<EncryptionAvailability>} diagnoseAvailability
 */

/**
 * Capacitor SQLite connection surface used by this module. We only depend on
 * the four secret-store methods, which keeps mocking trivial in tests.
 *
 * Each method may resolve either to a primitive `boolean` (older bindings)
 * or to a `{ result?: boolean }` object (current `capSQLiteResult` shape).
 * `unwrapBool` below normalizes both shapes.
 *
 * @typedef {Object} SecretStoreCapableSqlite
 * @property {() => Promise<boolean | { result?: boolean }>} isSecretStored
 * @property {(passphrase: string) => Promise<unknown>} setEncryptionSecret
 * @property {(newPassphrase: string, oldPassphrase: string) => Promise<unknown>} changeEncryptionSecret
 * @property {() => Promise<unknown>} clearEncryptionSecret
 */

/**
 * @typedef {Object} CreateEncryptionLayerOptions
 * @property {SecretStoreCapableSqlite} [sqlite]
 *   SQLite connection to use. Defaults to a fresh
 *   `new SQLiteConnection(CapacitorSQLite)` instance bound to the active
 *   Capacitor plugin. Tests can inject a stub.
 * @property {{ log: (e: { category: string, code: string, outcome: string, meta?: object }) => void }} [diagnostics]
 *   Diagnostics sink. Defaults to {@link getDiagnostics}.
 * @property {() => boolean} [isNativePlatform]
 *   Returns whether the runtime can host the SQLite plugin. Defaults to
 *   `Capacitor.isNativePlatform()`. Web / Node return `false`.
 * @property {(byteLength: number) => Uint8Array} [randomBytes]
 *   Source of cryptographic randomness. Defaults to
 *   `globalThis.crypto.getRandomValues(new Uint8Array(byteLength))`.
 */

/**
 * Hex-encode a byte buffer. Stable, lowercase, no leading `0x`. Independent of
 * Node's `Buffer` so it works inside the WebView too.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i] & 0xff;
    out += (b < 16 ? "0" : "") + b.toString(16);
  }
  return out;
}

/**
 * Default randomness source. Throws if `crypto.getRandomValues` is missing
 * (which would be a packaging bug — every supported runtime ships it).
 *
 * @param {number} byteLength
 * @returns {Uint8Array}
 */
function defaultRandomBytes(byteLength) {
  const cryptoObj =
    typeof globalThis !== "undefined" ? /** @type {Crypto | undefined} */ (globalThis.crypto) : undefined;
  if (!cryptoObj || typeof cryptoObj.getRandomValues !== "function") {
    throw new Error("crypto.getRandomValues is unavailable");
  }
  const buf = new Uint8Array(byteLength);
  cryptoObj.getRandomValues(buf);
  return buf;
}

/**
 * Normalize the SQLite plugin's "boolean-ish" return shape. The plugin returns
 * `{ result: boolean }` from most query methods (see e.g. `isConnection` →
 * `.result`). For older / community-fork builds the same call may resolve to a
 * bare boolean. We treat both as equivalent.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function unwrapBool(value) {
  if (typeof value === "boolean") return value;
  if (value && typeof value === "object" && "result" in value) {
    const r = /** @type {{ result?: unknown }} */ (value).result;
    return Boolean(r);
  }
  return false;
}

/**
 * Convert an unknown thrown value into a short, log-safe reason string. Never
 * exposes the secret-store passphrase or any value passed to a setter.
 *
 * @param {unknown} err
 * @returns {string}
 */
function describeError(err) {
  if (err == null) return "unknown";
  if (typeof err === "string") return err.slice(0, 200);
  if (err instanceof Error) return (err.message || err.name || "error").slice(0, 200);
  try {
    return String(err).slice(0, 200);
  } catch {
    return "unprintable";
  }
}

/**
 * Build an Encryption_Layer bound to the supplied SQLite connection. Tests
 * MUST construct their own instance via this factory with mock dependencies;
 * production callers should prefer {@link getEncryptionLayer}.
 *
 * @param {CreateEncryptionLayerOptions} [options]
 * @returns {EncryptionLayer}
 */
export function createEncryptionLayer(options = {}) {
  const sqlite =
    options.sqlite != null
      ? options.sqlite
      : /** @type {SecretStoreCapableSqlite} */ (
          /** @type {unknown} */ (new SQLiteConnection(CapacitorSQLite))
        );
  const diagnostics =
    options.diagnostics != null ? options.diagnostics : getDiagnostics();
  const isNativePlatform =
    typeof options.isNativePlatform === "function"
      ? options.isNativePlatform
      : () => Capacitor.isNativePlatform();
  const randomBytes =
    typeof options.randomBytes === "function" ? options.randomBytes : defaultRandomBytes;

  /**
   * Probe whether the secret store can answer queries on this device.
   *
   * On non-native platforms (web build / SSR / Node tests) the Capacitor
   * plugin has no implementation and `isSecretStored` would either reject or
   * pretend everything is fine — neither is useful. We short-circuit to
   * `{ available: false, reason: "PLATFORM_UNSUPPORTED" }`.
   *
   * On native platforms we issue an `isSecretStored()` probe. A successful
   * resolution (either `true` or `false`) means the secret store is reachable
   * and reports whether a key has been provisioned. A throw means the secret
   * store is not usable on this device — for example, because the underlying
   * Keystore key has been invalidated by a passcode change, or because the
   * device is missing the hardware-backed prerequisites the plugin depends on.
   * In that case we mark the layer unavailable so the boot path can take the
   * unencrypted fallback (Req 10.4).
   *
   * @returns {Promise<EncryptionAvailability>}
   */
  async function diagnoseAvailability() {
    if (!isNativePlatform()) {
      return { available: false, reason: "PLATFORM_UNSUPPORTED" };
    }
    try {
      // We only care that the call resolves; the boolean inside is consumed
      // by `getOrCreatePassphrase` later.
      await sqlite.isSecretStored();
      return { available: true };
    } catch (err) {
      return { available: false, reason: describeError(err) };
    }
  }

  /**
   * Generate or recover the SQLCipher passphrase. See module-level docstring
   * for the contract.
   *
   * @returns {Promise<EncryptionPassphraseResult>}
   */
  async function getOrCreatePassphrase() {
    if (!isNativePlatform()) {
      diagnostics.log({
        category: "encryption",
        code: "ENCRYPTION_FALLBACK",
        outcome: "warn",
        meta: { reason: "PLATFORM_UNSUPPORTED" },
      });
      return { mode: "none", passphrase: "" };
    }

    let alreadyStored = false;
    try {
      const probe = await sqlite.isSecretStored();
      alreadyStored = unwrapBool(probe);
    } catch (err) {
      diagnostics.log({
        category: "encryption",
        code: "ENCRYPTION_FALLBACK",
        outcome: "warn",
        meta: { stage: "isSecretStored", reason: describeError(err) },
      });
      return { mode: "none", passphrase: "" };
    }

    if (alreadyStored) {
      // Subsequent run: the plugin already owns the key. We deliberately do
      // NOT round-trip the value back here; on the next `createConnection`
      // call the driver passes `mode="secret"` and the plugin reads the key
      // straight from the keystore (§3.8).
      return { mode: "secure", passphrase: "" };
    }

    // First run: generate, hand to the plugin, return the value so the
    // immediately following `createConnection(..., encrypted=true,
    // mode="secret")` succeeds. The plugin caches the passphrase internally
    // for that call.
    let passphraseHex;
    try {
      const bytes = randomBytes(PASSPHRASE_BYTES);
      if (!(bytes instanceof Uint8Array) || bytes.length !== PASSPHRASE_BYTES) {
        throw new Error("randomBytes did not return 32 bytes");
      }
      passphraseHex = bytesToHex(bytes);
    } catch (err) {
      diagnostics.log({
        category: "encryption",
        code: "ENCRYPTION_FALLBACK",
        outcome: "error",
        meta: { stage: "randomBytes", reason: describeError(err) },
      });
      return { mode: "none", passphrase: "" };
    }

    try {
      await sqlite.setEncryptionSecret(passphraseHex);
    } catch (err) {
      diagnostics.log({
        category: "encryption",
        code: "ENCRYPTION_FALLBACK",
        outcome: "warn",
        meta: { stage: "setEncryptionSecret", reason: describeError(err) },
      });
      return { mode: "none", passphrase: "" };
    }

    return { mode: "secure", passphrase: passphraseHex };
  }

  /**
   * Generate a fresh 32-byte key and rekey SQLCipher in place. Only invoked
   * on explicit user action; not part of the v1 UX surface.
   *
   * The new key is generated locally and supplied to the plugin together with
   * the previous one (which the plugin still holds in its secret store). On
   * success the secret store now points at the new key and any future open
   * with `mode="secret"` uses it transparently.
   *
   * @returns {Promise<void>}
   */
  async function rotate() {
    const newBytes = randomBytes(PASSPHRASE_BYTES);
    if (!(newBytes instanceof Uint8Array) || newBytes.length !== PASSPHRASE_BYTES) {
      throw new Error("randomBytes did not return 32 bytes");
    }
    const newHex = bytesToHex(newBytes);
    // The plugin signature is `changeEncryptionSecret(newPassphrase,
    // oldPassphrase)`. The plugin re-reads the old passphrase from its own
    // secret store, so the second argument is ignored on most platforms but
    // we forward an empty string per the published API.
    await sqlite.changeEncryptionSecret(newHex, "");
  }

  /**
   * Drop the persisted key from the secret store. The DB file MUST already be
   * deleted before this is called — see §3.8 wipe sequence and Req 10.6.
   *
   * @returns {Promise<void>}
   */
  async function destroy() {
    await sqlite.clearEncryptionSecret();
  }

  return {
    getOrCreatePassphrase,
    rotate,
    destroy,
    diagnoseAvailability,
  };
}

/** @type {EncryptionLayer | null} */
let singleton = null;

/**
 * Process-wide Encryption_Layer used by the boot path and `OfflineProvider`.
 * Tests must use {@link createEncryptionLayer} directly with their own mocks.
 *
 * @returns {EncryptionLayer}
 */
export function getEncryptionLayer() {
  if (singleton == null) {
    singleton = createEncryptionLayer();
  }
  return singleton;
}

/**
 * Reset the singleton. Exported strictly for test setup.
 *
 * @internal
 */
export function __resetEncryptionLayerSingletonForTests() {
  singleton = null;
}
