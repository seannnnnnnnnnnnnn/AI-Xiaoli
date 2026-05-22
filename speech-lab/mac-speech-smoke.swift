import AVFoundation
import AudioToolbox
import Foundation
import Speech

struct Options {
  var locale = "zh-CN"
  var seconds = 8.0
  var inputPath = ""
  var outDir = NSTemporaryDirectory()
  var jsonlPath = ""
}

func optionValue(_ name: String) -> String? {
  guard let index = CommandLine.arguments.firstIndex(of: name) else { return nil }
  let next = CommandLine.arguments.index(after: index)
  return next < CommandLine.arguments.endIndex ? CommandLine.arguments[next] : nil
}

func parseOptions() -> Options {
  var options = Options()
  options.locale = optionValue("--locale") ?? options.locale
  options.inputPath = optionValue("--input") ?? ""
  options.outDir = optionValue("--out-dir") ?? options.outDir
  options.jsonlPath = optionValue("--jsonl") ?? ""
  if let seconds = Double(optionValue("--seconds") ?? "") {
    options.seconds = max(1.0, min(seconds, 60.0))
  }
  return options
}

let options = parseOptions()

func printJSON(_ object: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: object, options: []),
     let line = String(data: data, encoding: .utf8) {
    print(line)
    fflush(stdout)
    if !options.jsonlPath.isEmpty,
       let output = "\(line)\n".data(using: .utf8),
       let handle = FileHandle(forWritingAtPath: options.jsonlPath) {
      defer { try? handle.close() }
      try? handle.seekToEnd()
      try? handle.write(contentsOf: output)
    } else if !options.jsonlPath.isEmpty {
      try? "\(line)\n".write(toFile: options.jsonlPath, atomically: true, encoding: .utf8)
    }
  }
}

func waitUntil(timeout: TimeInterval, _ condition: @escaping () -> Bool) -> Bool {
  let deadline = Date().addingTimeInterval(timeout)
  while !condition() && Date() < deadline {
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
  }
  return condition()
}

func requestPermissions(needsMicrophone: Bool) throws {
  var speechStatus: SFSpeechRecognizerAuthorizationStatus?
  var microphoneGranted: Bool?

  SFSpeechRecognizer.requestAuthorization { status in
    speechStatus = status
  }
  if needsMicrophone {
    AVCaptureDevice.requestAccess(for: .audio) { granted in
      microphoneGranted = granted
    }
  } else {
    microphoneGranted = true
  }

  _ = waitUntil(timeout: 20) { speechStatus != nil && microphoneGranted != nil }

  guard speechStatus == .authorized else {
    throw NSError(domain: "XiaoliSpeechSmoke", code: 10, userInfo: [
      NSLocalizedDescriptionKey: "macOS Speech permission is not authorized: \(String(describing: speechStatus))."
    ])
  }
  guard microphoneGranted == true else {
    throw NSError(domain: "XiaoliSpeechSmoke", code: 11, userInfo: [
      NSLocalizedDescriptionKey: "Microphone permission is not authorized."
    ])
  }
}

func recordWav(seconds: Double, outDir: String) throws -> URL {
  let directory = URL(fileURLWithPath: outDir, isDirectory: true)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  let url = directory.appendingPathComponent("xiaoli-smoke-\(Int(Date().timeIntervalSince1970)).wav")
  let deviceName = AVCaptureDevice.default(for: .audio)?.localizedName ?? "unknown"
  let settings: [String: Any] = [
    AVFormatIDKey: kAudioFormatLinearPCM,
    AVSampleRateKey: 16000.0,
    AVNumberOfChannelsKey: 1,
    AVLinearPCMBitDepthKey: 16,
    AVLinearPCMIsFloatKey: false,
    AVLinearPCMIsBigEndianKey: false
  ]
  let recorder = try AVAudioRecorder(url: url, settings: settings)
  recorder.isMeteringEnabled = true
  recorder.prepareToRecord()
  guard recorder.record() else {
    throw NSError(domain: "XiaoliSpeechSmoke", code: 20, userInfo: [
      NSLocalizedDescriptionKey: "AVAudioRecorder failed to start."
    ])
  }

  printJSON(["event": "recording", "seconds": seconds, "path": url.path, "inputDevice": deviceName])
  AudioServicesPlaySystemSound(1057)
  let deadline = Date().addingTimeInterval(seconds)
  var peakPower = -160.0
  var averagePower = -160.0
  while Date() < deadline {
    recorder.updateMeters()
    peakPower = max(peakPower, Double(recorder.peakPower(forChannel: 0)))
    averagePower = max(averagePower, Double(recorder.averagePower(forChannel: 0)))
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
  }
  recorder.stop()
  AudioServicesPlaySystemSound(1057)

  let bytes = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int64) ?? 0
  printJSON([
    "event": "recorded",
    "path": url.path,
    "bytes": bytes,
    "inputDevice": deviceName,
    "peakPower": peakPower,
    "averagePower": averagePower
  ])
  return url
}

func transcribe(url: URL, locale: String) throws -> String {
  guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)) ?? SFSpeechRecognizer() else {
    throw NSError(domain: "XiaoliSpeechSmoke", code: 30, userInfo: [
      NSLocalizedDescriptionKey: "SFSpeechRecognizer is unavailable."
    ])
  }
  let request = SFSpeechURLRecognitionRequest(url: url)
  request.shouldReportPartialResults = true
  if #available(macOS 13.0, *) {
    request.addsPunctuation = true
  }

  var finished = false
  var transcript = ""
  var errorMessage = ""
  let task = recognizer.recognitionTask(with: request) { result, error in
    if let result {
      let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
      if !text.isEmpty {
        transcript = text
        printJSON(["event": result.isFinal ? "final_partial" : "partial", "transcript": text])
      }
      if result.isFinal {
        finished = true
      }
    }
    if let error {
      errorMessage = error.localizedDescription
      finished = true
    }
  }

  _ = waitUntil(timeout: 90) { finished }
  if !finished {
    task.cancel()
    throw NSError(domain: "XiaoliSpeechSmoke", code: 31, userInfo: [
      NSLocalizedDescriptionKey: "Speech recognition timed out."
    ])
  }
  if transcript.isEmpty && !errorMessage.isEmpty {
    throw NSError(domain: "XiaoliSpeechSmoke", code: 32, userInfo: [
      NSLocalizedDescriptionKey: errorMessage
    ])
  }
  return transcript
}

do {
  try requestPermissions(needsMicrophone: options.inputPath.isEmpty)
  let audioURL = options.inputPath.isEmpty
    ? try recordWav(seconds: options.seconds, outDir: options.outDir)
    : URL(fileURLWithPath: options.inputPath)
  let transcript = try transcribe(url: audioURL, locale: options.locale)
  printJSON([
    "event": "done",
    "transcript": transcript,
    "path": audioURL.path
  ])
  exit(transcript.isEmpty ? 2 : 0)
} catch {
  printJSON([
    "event": "error",
    "message": error.localizedDescription
  ])
  exit(1)
}
