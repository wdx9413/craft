import { execFileSync } from "node:child_process";

/**
 * The Java analyzer reports `jdk_unavailable` when javac cannot be spawned, which
 * is honest but makes every JDK-dependent case fail on a machine without a JDK.
 * Those cases skip instead, so a missing toolchain is not reported as a defect.
 */
let probed = false, available = false;
export function jdkAvailable(): boolean {
  if (probed) return available;
  probed = true;
  try { execFileSync("javac", ["-version"], { stdio: "ignore", timeout: 10_000, windowsHide: true }); available = true; }
  catch { available = false; }
  return available;
}
