const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const MASCOT_ROOT = path.resolve(__dirname, "..");
const WORKSPACE_ROOT = path.resolve(MASCOT_ROOT, "..");
const OUT_DIR = path.join(WORKSPACE_ROOT, "dist", "mascot");
const APP_NAME = "AI小力";
const LEGACY_APP_NAME = "AIXiaoliMascot";
const ICON_PATH = path.join(MASCOT_ROOT, "assets", "app-icon.icns");
const SPEECH_HELPER_SOURCE = path.join(MASCOT_ROOT, "scripts", "xiaoli-speech.swift");
const SPEECH_HELPER_INFO = path.join(MASCOT_ROOT, "scripts", "xiaoli-speech-info.plist");
const SPEECH_HELPER_PATH = path.join(MASCOT_ROOT, "native", "xiaoli-speech");
const ELECTRON_VERSION = require("electron/package.json").version;
const TARGETS = [
  { platform: "darwin", arch: "arm64" },
  { platform: "darwin", arch: "x64" }
];

async function loadPackager() {
  const moduleRef = await import("@electron/packager");
  return moduleRef.packager || moduleRef.default;
}

function speechHelperCompileArgs(outputPath, target) {
  const args = [
    "swiftc",
    "-O"
  ];
  if (target) {
    args.push("-target", target);
  }
  args.push(SPEECH_HELPER_SOURCE);
  if (fs.existsSync(SPEECH_HELPER_INFO)) {
    args.push(
      "-Xlinker",
      "-sectcreate",
      "-Xlinker",
      "__TEXT",
      "-Xlinker",
      "__info_plist",
      "-Xlinker",
      SPEECH_HELPER_INFO
    );
  }
  args.push(
    "-framework",
    "Speech",
    "-framework",
    "AVFoundation",
    "-o",
    outputPath
  );
  return args;
}

function compileNativeSpeechHelper() {
  if (process.platform !== "darwin" || !fs.existsSync(SPEECH_HELPER_SOURCE)) return;
  fs.mkdirSync(path.dirname(SPEECH_HELPER_PATH), { recursive: true });
  const tempDir = path.join(MASCOT_ROOT, "native", ".build");
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });
  const arm64Path = path.join(tempDir, "xiaoli-speech-arm64");
  const x64Path = path.join(tempDir, "xiaoli-speech-x64");
  try {
    execFileSync("xcrun", speechHelperCompileArgs(arm64Path, "arm64-apple-macos13.0"), { stdio: "inherit" });
    execFileSync("xcrun", speechHelperCompileArgs(x64Path, "x86_64-apple-macos13.0"), { stdio: "inherit" });
    execFileSync("lipo", ["-create", arm64Path, x64Path, "-output", SPEECH_HELPER_PATH], { stdio: "inherit" });
  } catch {
    execFileSync("xcrun", speechHelperCompileArgs(SPEECH_HELPER_PATH), { stdio: "inherit" });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  fs.chmodSync(SPEECH_HELPER_PATH, 0o755);
}

function signPackagedApp(appPath) {
  if (process.platform !== "darwin") return;
  const appBundle = appPath.endsWith(".app")
    ? appPath
    : path.join(appPath, `${APP_NAME}.app`);
  if (!fs.existsSync(appBundle)) return;
  execFileSync("xcrun", [
    "codesign",
    "--force",
    "--deep",
    "--sign",
    "-",
    appBundle
  ], { stdio: "inherit" });
  execFileSync("xcrun", [
    "codesign",
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    appBundle
  ], { stdio: "inherit" });
}

async function main() {
  const packager = await loadPackager();
  compileNativeSpeechHelper();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const preservedFolders = [];
  for (const target of TARGETS) {
    const targetDir = path.join(OUT_DIR, `${APP_NAME}-${target.platform}-${target.arch}`);
    const legacyTargetDir = path.join(OUT_DIR, `${LEGACY_APP_NAME}-${target.platform}-${target.arch}`);
    const userFramesDir = fs.existsSync(path.join(targetDir, "xiaoli"))
      ? path.join(targetDir, "xiaoli")
      : path.join(legacyTargetDir, "xiaoli");
    const preservedDir = path.join(OUT_DIR, `.preserved-xiaoli-${target.platform}-${target.arch}`);
    if (fs.existsSync(userFramesDir)) {
      fs.rmSync(preservedDir, { recursive: true, force: true });
      fs.cpSync(userFramesDir, preservedDir, { recursive: true });
      preservedFolders.push({ targetDir, preservedDir });
    }
    fs.rmSync(targetDir, {
      recursive: true,
      force: true
    });
  }

  const builtPaths = [];
  for (const target of TARGETS) {
    const appPaths = await packager({
      dir: MASCOT_ROOT,
      out: OUT_DIR,
      name: APP_NAME,
      platform: target.platform,
      arch: target.arch,
      overwrite: true,
      prune: true,
      asar: {
        unpackDir: "native"
      },
      executableName: APP_NAME,
      electronVersion: ELECTRON_VERSION,
      appBundleId: "ai.xiaoli.mascot",
      appCategoryType: "public.app-category.productivity",
      extendInfo: {
        NSMicrophoneUsageDescription: "AI小力需要使用麦克风记录你主动开启的“刚刚发生了啥”，用于本机转写和总结。",
        NSSpeechRecognitionUsageDescription: "AI小力需要使用 macOS 语音识别把你主动记录的内容转成文字。"
      },
      icon: fs.existsSync(ICON_PATH) ? ICON_PATH.replace(/\.icns$/, "") : undefined
    });
    builtPaths.push(...appPaths);
  }

  for (const { targetDir, preservedDir } of preservedFolders) {
    if (!fs.existsSync(preservedDir)) continue;
    fs.cpSync(preservedDir, path.join(targetDir, "xiaoli"), { recursive: true });
    fs.rmSync(preservedDir, { recursive: true, force: true });
  }

  for (const appPath of builtPaths) {
    signPackagedApp(appPath);
  }

  console.log("AI小力 package finished:");
  for (const appPath of builtPaths) {
    console.log(`- ${appPath}`);
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
