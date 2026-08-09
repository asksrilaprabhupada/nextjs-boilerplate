/**
 * A session-persistent shuffled deck for doorway photographs.
 *
 * Every photograph is drawn once before a new cycle starts. The production
 * random source is Web Crypto, with rejection sampling to avoid modulo bias.
 */

export const LOCKSCREEN_DECK_STORAGE_KEY = "lockscreen-photo-deck:v1";

const DECK_SCHEMA_VERSION = 1;
const UINT32_RANGE = 0x1_0000_0000;

export interface LockscreenPhotoDeckState {
  version: typeof DECK_SCHEMA_VERSION;
  libraryKey: string;
  remaining: string[];
  lastShown: string | null;
}

export type LockscreenRandomIndex = (upperExclusive: number) => number;

function uniqueUrls(urls: readonly string[]): string[] {
  return [...new Set(urls.filter((url) => url.length > 0))];
}

export function lockscreenLibraryKey(urls: readonly string[]): string {
  return JSON.stringify([...uniqueUrls(urls)].sort());
}

export function cryptoRandomIndex(upperExclusive: number): number {
  if (!Number.isSafeInteger(upperExclusive) || upperExclusive <= 0 || upperExclusive > UINT32_RANGE) {
    throw new RangeError("Lockscreen random upper bound is invalid");
  }
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Web Crypto is required to randomize lockscreen photographs");
  }

  const rejectionLimit = UINT32_RANGE - (UINT32_RANGE % upperExclusive);
  const value = new Uint32Array(1);
  do {
    globalThis.crypto.getRandomValues(value);
  } while (value[0] >= rejectionLimit);
  return value[0] % upperExclusive;
}

export function shuffleLockscreenPhotos(
  urls: readonly string[],
  randomIndex: LockscreenRandomIndex = cryptoRandomIndex,
): string[] {
  const shuffled = uniqueUrls(urls);
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1);
    if (!Number.isInteger(swapIndex) || swapIndex < 0 || swapIndex > index) {
      throw new RangeError("Lockscreen random source returned an out-of-range index");
    }
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

export function parseLockscreenPhotoDeck(value: string | null): LockscreenPhotoDeckState | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as Partial<LockscreenPhotoDeckState>;
    if (
      candidate.version !== DECK_SCHEMA_VERSION
      || typeof candidate.libraryKey !== "string"
      || !Array.isArray(candidate.remaining)
      || !candidate.remaining.every((url) => typeof url === "string")
      || (candidate.lastShown !== null && typeof candidate.lastShown !== "string")
    ) {
      return null;
    }
    return {
      version: DECK_SCHEMA_VERSION,
      libraryKey: candidate.libraryKey,
      remaining: candidate.remaining,
      lastShown: candidate.lastShown,
    };
  } catch {
    return null;
  }
}

function isUsablePersistedDeck(
  state: LockscreenPhotoDeckState,
  libraryKey: string,
  library: ReadonlySet<string>,
): boolean {
  if (state.libraryKey !== libraryKey) return false;
  if (state.lastShown !== null && !library.has(state.lastShown)) return false;
  if (new Set(state.remaining).size !== state.remaining.length) return false;
  if (!state.remaining.every((url) => library.has(url))) return false;
  return state.lastShown === null || !state.remaining.includes(state.lastShown);
}

export function drawLockscreenPhoto(
  urls: readonly string[],
  persisted: LockscreenPhotoDeckState | null,
  randomIndex: LockscreenRandomIndex = cryptoRandomIndex,
): { photo: string | null; state: LockscreenPhotoDeckState } {
  const normalized = uniqueUrls(urls);
  const libraryKey = lockscreenLibraryKey(normalized);
  const library = new Set(normalized);

  if (normalized.length === 0) {
    return {
      photo: null,
      state: { version: DECK_SCHEMA_VERSION, libraryKey, remaining: [], lastShown: null },
    };
  }

  const persistedIsUsable = persisted !== null && isUsablePersistedDeck(persisted, libraryKey, library);
  // A changed library invalidates the old deck. Retaining only the previous
  // visible URL prevents an immediate repeat when that URL still exists.
  const lastShown = persisted?.lastShown && library.has(persisted.lastShown)
    ? persisted.lastShown
    : null;
  let remaining = persistedIsUsable ? [...persisted.remaining] : [];

  if (remaining.length === 0) {
    remaining = shuffleLockscreenPhotos(normalized, randomIndex);
    if (remaining.length > 1 && remaining[0] === lastShown) {
      const replacementIndex = remaining.findIndex((url) => url !== lastShown);
      [remaining[0], remaining[replacementIndex]] = [remaining[replacementIndex], remaining[0]];
    }
  }

  const [photo, ...rest] = remaining;
  return {
    photo,
    state: {
      version: DECK_SCHEMA_VERSION,
      libraryKey,
      remaining: rest,
      lastShown: photo,
    },
  };
}
