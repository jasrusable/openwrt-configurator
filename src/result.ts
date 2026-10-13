// How a step that can fail says so, as a value: the caller must look before it
// can use what came back. Throwing is for bugs; an expected failure (a device
// that cannot be reached, a phase that went wrong) is a Result.

export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

/** A Result's value transformed, its failure passed on. */
export const map = <T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> =>
  result.ok ? ok(fn(result.value)) : result;

/** The value, or what `onError` makes of the failure. */
export const unwrapOr = <T, E>(result: Result<T, E>, onError: (error: E) => T): T =>
  result.ok ? result.value : onError(result.error);

/** What a thrown value says, in words. */
export const messageOf = (thrown: unknown) => String((thrown as Error)?.message ?? thrown);

/**
 * Run `fn`, turning anything it throws into a failure through `onThrow`: the
 * one place an unexpected exception becomes an expected failure.
 */
export const attempt = async <T, E>(fn: () => Promise<T>, onThrow: (thrown: unknown) => E): Promise<Result<T, E>> => {
  try {
    return ok(await fn());
  } catch (thrown) {
    return err(onThrow(thrown));
  }
};
