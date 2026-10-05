// Path identity across platforms.
//
// - realpath.native resolves symlinks (macOS: /var → /private/var, which is what git
//   reports for checkouts under tmpdir) and, on Windows and macOS, returns the on-disk
//   letter case. The JS realpathSync keeps whatever case it was given.
// - Windows and macOS (APFS/HFS+ by default) are case-insensitive, so compare folded there.
//   A case-sensitive APFS volume is rare; folding can only make two distinct paths that
//   differ by case look equal, which these callers treat as "same checkout".

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const FOLD_CASE = process.platform === "win32" || process.platform === "darwin";

/** Absolute, symlink-free when the path exists, without Windows' `\\?\` prefix. */
export function canonicalPath(p: string): string {
  let r = resolve(p);
  try {
    r = realpathSync.native(r);
  } catch {
    // doesn't exist (yet): keep the resolved form
  }
  return r.replace(/^\\\\\?\\/, "");
}

/** A comparison key: canonical, and case-folded where the filesystem is case-insensitive. */
export const pathKey = (p: string, fold = FOLD_CASE) => (fold ? canonicalPath(p).toLowerCase() : canonicalPath(p));

export const samePath = (a: string, b: string) => pathKey(a) === pathKey(b);
