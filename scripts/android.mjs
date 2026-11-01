import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Keep machine-local SDK paths out of tracked Gradle files and make the MVP build repeatable.
const env = { ...process.env };
env.CARGO_PROFILE_DEV_DEBUG ||= "0";
env.CARGO_INCREMENTAL ||= "0";
env.ANDROID_HOME ||= join(env.LOCALAPPDATA || "", "Android", "Sdk");
if (!existsSync(env.ANDROID_HOME)) throw new Error("未找到 Android SDK，请设置 ANDROID_HOME");
if (!env.NDK_HOME) {
  const directory = join(env.ANDROID_HOME, "ndk");
  const versions = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a,b) => b.localeCompare(a, undefined, { numeric: true }));
  if (!versions.length) throw new Error("未找到 Android NDK");
  env.NDK_HOME = join(directory, versions[0]);
}
const [command = "build", ...args] = process.argv.slice(2);
const cli = fileURLToPath(new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url));
const options = command === "build" ? ["--debug", "--target", "aarch64"] : [];
const child = spawn(process.execPath, [cli, "android", command, ...options, ...args], { env, stdio: ["inherit", "pipe", "pipe"] });
let output = "";
for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
  stream.on("data", (data) => { destination.write(data); output = (output + data.toString()).slice(-30000); });
}
child.on("error", (error) => { console.error(error); process.exit(1); });
child.on("exit", (code) => {
  if (code === 0 || command !== "build" || !output.includes("symbolic link")) process.exit(code ?? 1);
  // Tauri has already compiled Rust and generated its Gradle bindings at this point.
  // Windows without Developer Mode cannot symlink, so package the exact library by copy.
  const root = fileURLToPath(new URL("../", import.meta.url));
  const native = join(root, "src-tauri/target/aarch64-linux-android/debug/libfile_sweeper_lib.so");
  if (!existsSync(native)) process.exit(code ?? 1);
  const android = join(root, "src-tauri/gen/android");
  const destination = join(android, "app/src/main/jniLibs/arm64-v8a");
  mkdirSync(destination, { recursive: true });
  copyFileSync(native, join(destination, "libfile_sweeper_lib.so"));
  console.log("Windows 未启用符号链接权限，使用已编译原生库继续 Gradle 打包。");
  const gradle = spawn("cmd.exe", ["/d", "/c", "gradlew.bat", "assembleArm64Debug", "-x", "rustBuildArm64Debug", "--console=plain"], { cwd: android, env, stdio: "inherit" });
  gradle.on("error", (error) => { console.error(error); process.exit(1); });
  gradle.on("exit", (result) => process.exit(result ?? 1));
});
