import { describe, expect, it } from "vitest";
import {
  drawLockscreenPhoto,
  lockscreenLibraryKey,
  parseLockscreenPhotoDeck,
  shuffleLockscreenPhotos,
  type LockscreenPhotoDeckState,
} from "@/app/lib/27-lockscreen-photo-deck";

function fixedRandom(...values: number[]) {
  let cursor = 0;
  return (upperExclusive: number) => {
    const value = values[cursor] ?? 0;
    cursor += 1;
    return value % upperExclusive;
  };
}

describe("lockscreen photo deck", () => {
  it("returns no photo for an empty library", () => {
    const result = drawLockscreenPhoto([], null, fixedRandom(0));
    expect(result.photo).toBeNull();
    expect(result.state.remaining).toEqual([]);
  });

  it("handles the unavoidable repeat when only one photo exists", () => {
    const first = drawLockscreenPhoto(["only"], null, fixedRandom(0));
    const second = drawLockscreenPhoto(["only"], first.state, fixedRandom(0));

    expect(first.photo).toBe("only");
    expect(second.photo).toBe("only");
  });

  it("never places adjacent repeats in a two-photo library", () => {
    const shown: string[] = [];
    let persisted: LockscreenPhotoDeckState | null = null;

    for (let draw = 0; draw < 8; draw += 1) {
      const result = drawLockscreenPhoto(["a", "b"], persisted, fixedRandom(0));
      shown.push(result.photo!);
      persisted = result.state;
    }

    expect(shown.every((photo, index) => index === 0 || photo !== shown[index - 1])).toBe(true);
  });

  it("uses the supplied random source for a Fisher-Yates first draw", () => {
    expect(shuffleLockscreenPhotos(["a", "b", "c", "d"], fixedRandom(1, 0, 1))).toEqual([
      "c",
      "d",
      "a",
      "b",
    ]);
  });

  it("shows every photo once per cycle and resumes from serialized session state", () => {
    const library = ["a", "b", "c"];
    let persisted: LockscreenPhotoDeckState | null = null;
    const shown: string[] = [];

    for (let draw = 0; draw < library.length; draw += 1) {
      const result = drawLockscreenPhoto(library, persisted, fixedRandom(0, 0));
      shown.push(result.photo!);
      persisted = parseLockscreenPhotoDeck(JSON.stringify(result.state));
    }

    expect(new Set(shown)).toEqual(new Set(library));
    expect(persisted?.remaining).toEqual([]);
  });

  it("does not repeat the final photo at the next cycle boundary", () => {
    const library = ["a", "b", "c"];
    const persisted: LockscreenPhotoDeckState = {
      version: 1,
      libraryKey: lockscreenLibraryKey(library),
      remaining: [],
      lastShown: "a",
    };

    // This shuffle would put "a" first; the boundary guard swaps it away.
    const result = drawLockscreenPhoto(library, persisted, fixedRandom(1, 1));
    expect(result.photo).not.toBe("a");
  });

  it("invalidates the remaining deck when the photo set changes", () => {
    const oldLibrary = ["a", "b", "c"];
    const persisted: LockscreenPhotoDeckState = {
      version: 1,
      libraryKey: lockscreenLibraryKey(oldLibrary),
      remaining: ["b"],
      lastShown: "a",
    };

    const result = drawLockscreenPhoto(["a", "b", "c", "new"], persisted, fixedRandom(0, 0, 0));
    expect(result.state.libraryKey).not.toBe(persisted.libraryKey);
    expect([result.photo, ...result.state.remaining]).toEqual(expect.arrayContaining(["a", "b", "c", "new"]));
    expect(result.state.remaining).toHaveLength(3);
  });

  it("drops duplicate URLs and rejects malformed persisted state", () => {
    const result = drawLockscreenPhoto(["a", "a", "b"], null, fixedRandom(0));
    expect([result.photo, ...result.state.remaining]).toHaveLength(2);
    expect(parseLockscreenPhotoDeck("not json")).toBeNull();
    expect(parseLockscreenPhotoDeck(JSON.stringify({ version: 1, remaining: [] }))).toBeNull();
  });
});
