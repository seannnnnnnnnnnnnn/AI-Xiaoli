# AI小力本机转写最小测试

这个目录只测试 macOS 本机能力：

1. 麦克风录音到本地 WAV。
2. `SFSpeechURLRecognitionRequest` 调用系统语音识别。
3. 输出 JSON 诊断。

不接云端转写，不调用 LLM，不依赖 Electron。

## 编译

```bash
xcrun swiftc -O mac-speech-smoke.swift \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist \
  -Xlinker ../scripts/xiaoli-speech-info.plist \
  -framework Speech -framework AVFoundation \
  -o /tmp/xiaoli-speech-smoke
```

## 录音测试

```bash
/tmp/xiaoli-speech-smoke --locale zh-CN --seconds 8 --out-dir /tmp
```

输出 `event=done` 且有 `transcript` 才说明本机“录音 -> 系统转写”链路成立。
