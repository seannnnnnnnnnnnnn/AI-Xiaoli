import AVFoundation
import Foundation
import Speech

final class SpeechSession {
  private let recognizer: SFSpeechRecognizer
  private let recordingURL: URL
  private let debugDirectory: URL?
  private let recordingBaseName: String
  private var recorder: AVAudioRecorder?
  private var peakPower = -160.0
  private var averagePower = -160.0
  private var meterTimer: DispatchSourceTimer?

  init(localeIdentifier: String, debugDirectoryPath: String?) throws {
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier)) ?? SFSpeechRecognizer() else {
      throw NSError(domain: "AIXiaoliSpeech", code: 1, userInfo: [NSLocalizedDescriptionKey: "当前系统不可用语音识别。"])
    }
    self.recognizer = recognizer
    self.recordingBaseName = "xiaoli-speech-\(UUID().uuidString)"
    self.recordingURL = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("\(recordingBaseName).wav")
    if let debugDirectoryPath, !debugDirectoryPath.isEmpty {
      self.debugDirectory = URL(fileURLWithPath: debugDirectoryPath, isDirectory: true)
    } else {
      self.debugDirectory = nil
    }
  }

  func start() throws {
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatLinearPCM,
      AVSampleRateKey: 16000.0,
      AVNumberOfChannelsKey: 1,
      AVLinearPCMBitDepthKey: 16,
      AVLinearPCMIsFloatKey: false,
      AVLinearPCMIsBigEndianKey: false
    ]
    let recorder = try AVAudioRecorder(url: recordingURL, settings: settings)
    recorder.isMeteringEnabled = true
    recorder.prepareToRecord()
    guard recorder.record() else {
      throw NSError(domain: "AIXiaoliSpeech", code: 2, userInfo: [NSLocalizedDescriptionKey: "无法启动麦克风录音。"])
    }
    self.recorder = recorder
    startMetering()
    printJSON([
      "event": "ready",
      "inputDevice": AVCaptureDevice.default(for: .audio)?.localizedName ?? "unknown",
      "recordingPath": recordingURL.path
    ])
  }

  private func startMetering() {
    let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
    timer.schedule(deadline: .now(), repeating: .milliseconds(100))
    timer.setEventHandler { [weak self] in
      guard let self, let recorder = self.recorder, recorder.isRecording else { return }
      recorder.updateMeters()
      self.peakPower = max(self.peakPower, Double(recorder.peakPower(forChannel: 0)))
      self.averagePower = max(self.averagePower, Double(recorder.averagePower(forChannel: 0)))
    }
    timer.resume()
    meterTimer = timer
  }

  private func fileSize(_ url: URL) -> Int64 {
    let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
    return attributes?[.size] as? Int64 ?? 0
  }

  private func preserveDebugAudioIfNeeded(transcript: String) -> String {
    guard transcript.isEmpty, let debugDirectory else { return "" }
    do {
      try FileManager.default.createDirectory(at: debugDirectory, withIntermediateDirectories: true)
      guard fileSize(recordingURL) > 0 else { return "" }
      let destinationURL = debugDirectory.appendingPathComponent("failed-\(recordingBaseName)-\(Int(Date().timeIntervalSince1970)).wav")
      try? FileManager.default.removeItem(at: destinationURL)
      try FileManager.default.copyItem(at: recordingURL, to: destinationURL)
      return destinationURL.path
    } catch {
      return ""
    }
  }

  private func transcribeRecording() -> (String, String) {
    let request = SFSpeechURLRecognitionRequest(url: recordingURL)
    request.shouldReportPartialResults = true
    if #available(macOS 13.0, *) {
      request.addsPunctuation = true
    }

    let semaphore = DispatchSemaphore(value: 0)
    var transcript = ""
    var recognitionError = ""
    let task = recognizer.recognitionTask(with: request) { result, error in
      if let result {
        let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty {
          transcript = text
          printJSON(["event": "partial", "transcript": text, "isFinal": result.isFinal])
        }
        if result.isFinal {
          semaphore.signal()
        }
      }
      if let error {
        recognitionError = error.localizedDescription
        semaphore.signal()
      }
    }

    if semaphore.wait(timeout: .now() + 90.0) == .timedOut {
      task.cancel()
      return (transcript, transcript.isEmpty ? "本机语音识别超时。" : "")
    }
    return (transcript, transcript.isEmpty ? recognitionError : "")
  }

  func stopAndWait() {
    meterTimer?.cancel()
    meterTimer = nil
    recorder?.updateMeters()
    if let recorder {
      peakPower = max(peakPower, Double(recorder.peakPower(forChannel: 0)))
      averagePower = max(averagePower, Double(recorder.averagePower(forChannel: 0)))
    }
    recorder?.stop()
    recorder = nil

    let bytes = fileSize(recordingURL)
    printJSON([
      "event": "diagnostic",
      "stage": "recorded",
      "recordingBytes": bytes,
      "peakPower": peakPower,
      "averagePower": averagePower,
      "recognizerAvailable": recognizer.isAvailable
    ])

    let (transcript, recognitionError) = transcribeRecording()
    let debugAudioPath = preserveDebugAudioIfNeeded(transcript: transcript)
    printJSON([
      "event": "final",
      "transcript": transcript,
      "recognitionError": recognitionError,
      "recordingBytes": bytes,
      "peakPower": peakPower,
      "averagePower": averagePower,
      "recognizerAvailable": recognizer.isAvailable,
      "debugAudioPath": debugAudioPath
    ])
    try? FileManager.default.removeItem(at: recordingURL)
  }
}

func printJSON(_ object: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: object, options: []),
     let line = String(data: data, encoding: .utf8) {
    print(line)
    fflush(stdout)
  }
}

func fail(_ message: String) -> Never {
  printJSON(["event": "error", "message": message])
  exit(1)
}

func waitUntil(timeout: TimeInterval, _ condition: @escaping () -> Bool) -> Bool {
  let deadline = Date().addingTimeInterval(timeout)
  while !condition() && Date() < deadline {
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
  }
  return condition()
}

func requestPermissions() {
  var speechStatus: SFSpeechRecognizerAuthorizationStatus?
  var microphoneGranted: Bool?

  SFSpeechRecognizer.requestAuthorization { status in
    speechStatus = status
  }
  AVCaptureDevice.requestAccess(for: .audio) { granted in
    microphoneGranted = granted
  }

  _ = waitUntil(timeout: 20) { speechStatus != nil && microphoneGranted != nil }

  guard speechStatus == .authorized else {
    fail("macOS 语音识别权限未开启。请在系统设置里允许 AI小力 使用语音识别。")
  }
  guard microphoneGranted == true else {
    fail("麦克风权限未开启。请在系统设置里允许 AI小力 使用麦克风。")
  }
}

let localeIndex = CommandLine.arguments.firstIndex(of: "--locale")
let localeIdentifier = localeIndex.flatMap { index -> String? in
  let next = CommandLine.arguments.index(after: index)
  return next < CommandLine.arguments.endIndex ? CommandLine.arguments[next] : nil
} ?? "zh-CN"

let debugDirIndex = CommandLine.arguments.firstIndex(of: "--debug-dir")
let debugDirectoryPath = debugDirIndex.flatMap { index -> String? in
  let next = CommandLine.arguments.index(after: index)
  return next < CommandLine.arguments.endIndex ? CommandLine.arguments[next] : nil
}

requestPermissions()

do {
  let session = try SpeechSession(localeIdentifier: localeIdentifier, debugDirectoryPath: debugDirectoryPath)
  try session.start()
  DispatchQueue.global(qos: .userInitiated).async {
    _ = readLine()
    session.stopAndWait()
    exit(0)
  }
  RunLoop.main.run()
} catch {
  fail(error.localizedDescription)
}
