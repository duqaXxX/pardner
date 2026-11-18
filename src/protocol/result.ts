export type PlatformError =
  | "bad-input"
  | "no-such-key"
  | "key-exists"
  | "open-failed"
  | "io-failed";

/** A failure is a value: what depends on another party's bytes returns one of these. */
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PlatformError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = (error: PlatformError): Result<never> => ({ ok: false, error });
