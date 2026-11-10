import { lstatSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync, type PathLike } from "node:fs";
import { symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Windows without Developer Mode or an elevated token cannot create real
 * symlinks, but it can always create a directory junction. A junction still
 * reports `lstat().isSymbolicLink() === true` and realpath-resolves to its
 * target, so the escape checks under test behave exactly the same.
 *
 * A test that only needs a filesystem link to a directory should use
 * `linkDirectory`; a test that must exercise a real *file* symlink cannot be
 * reproduced on such a machine and should skip on `supportsFileSymlinks()`.
 */
const DIRECTORY_LINK_TYPE: "junction" | "dir" = process.platform === "win32" ? "junction" : "dir";

export class SymlinkUnsupportedError extends Error {
  constructor(cause: unknown) {
    super(`symlinks are not permitted on this machine: ${String(cause)}`);
    this.name = "SymlinkUnsupportedError";
  }
}

function unsupported(error: unknown): boolean {
  let code: unknown;
  try { code = (error as NodeJS.ErrnoException | null)?.code; } catch { return false; }
  return code === "EPERM" || code === "EACCES" || code === "ENOSYS";
}

/** Link a directory without needing symlink privileges on Windows. */
export function linkDirectorySync(target: PathLike, path: PathLike): void {
  try { symlinkSync(target, path, DIRECTORY_LINK_TYPE); }
  catch (error) { throw unsupported(error) ? new SymlinkUnsupportedError(error) : error; }
}

/** Link a directory without needing symlink privileges on Windows. */
export async function linkDirectory(target: PathLike, path: PathLike): Promise<void> {
  try { await symlink(target, path, DIRECTORY_LINK_TYPE); }
  catch (error) { throw unsupported(error) ? new SymlinkUnsupportedError(error) : error; }
}

/** Link a file. Windows requires SeCreateSymbolicLinkPrivilege for this. */
export function linkFileSync(target: PathLike, path: PathLike): void {
  try { symlinkSync(target, path); }
  catch (error) { throw unsupported(error) ? new SymlinkUnsupportedError(error) : error; }
}

/** Link a file. Windows requires SeCreateSymbolicLinkPrivilege for this. */
export async function linkFile(target: PathLike, path: PathLike): Promise<void> {
  try { await symlink(target, path); }
  catch (error) { throw unsupported(error) ? new SymlinkUnsupportedError(error) : error; }
}

/**
 * Remove a link without recursing into it. `rmSync(link, {recursive:true})`
 * follows a Windows junction and can fail with EPERM, so a link is unlinked
 * like a file and a real directory is removed recursively.
 */
export function removeLinkSync(path: PathLike): void {
  let link = false;
  try { link = lstatSync(path).isSymbolicLink(); } catch { return; }
  if (link) { unlinkSync(path); return; }
  rmSync(path, { recursive: true, force: true });
}

let probed = false, supported = false;
/** Whether a real file symlink can be created here (a directory junction is not enough). */
export function supportsFileSymlinks(): boolean {
  if (probed) return supported;
  probed = true;
  const root = mkdtempSync(join(tmpdir(), "craft-symlink-probe-"));
  try {
    const file = join(root, "target.txt");
    writeFileSync(file, "probe");
    symlinkSync(file, join(root, "link.txt"));
    supported = true;
  } catch { supported = false; }
  finally { rmSync(root, { recursive: true, force: true }); }
  return supported;
}
