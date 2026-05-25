import AVFoundation
import Foundation
import Speech

final class SpeechSession {
  private let maxRecognitionChunkDuration = 50.0
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

  private func audioDurationSeconds(_ url: URL) -> Double {
    guard let file = try? AVAudioFile(forReading: url), file.processingFormat.sampleRate > 0 else {
      return 0
    }
    return Double(file.length) / file.processingFormat.sampleRate
  }

  private func chunkAudioFile(_ sourceURL: URL) throws -> [URL] {
    let file = try AVAudioFile(forReading: sourceURL)
    let sampleRate = file.processingFormat.sampleRate
    guard sampleRate > 0 else { return [sourceURL] }
    let framesPerChunk = AVAudioFramePosition(maxRecognitionChunkDuration * sampleRate)
    guard file.length > framesPerChunk else { return [sourceURL] }

    let directory = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
    var chunks: [URL] = []
    var startFrame: AVAudioFramePosition = 0
    var index = 1
    while startFrame < file.length {
      file.framePosition = startFrame
      let remainingFrames = file.length - startFrame
      let frameCount = min(framesPerChunk, remainingFrames)
      guard let buffer = AVAudioPCMBuffer(
        pcmFormat: file.processingFormat,
        frameCapacity: AVAudioFrameCount(frameCount)
      ) else {
        break
      }
      try file.read(into: buffer, frameCount: AVAudioFrameCount(frameCount))
      let chunkURL = directory.appendingPathComponent("\(recordingBaseName)-chunk-\(index).wav")
      try? FileManager.default.removeItem(at: chunkURL)
      let output = try AVAudioFile(forWriting: chunkURL, settings: file.fileFormat.settings)
      try output.write(from: buffer)
      chunks.append(chunkURL)
      startFrame += AVAudioFramePosition(buffer.frameLength)
      index += 1
      if buffer.frameLength == 0 { break }
    }
    return chunks.isEmpty ? [sourceURL] : chunks
  }

  private func removeTemporaryChunks(_ chunks: [URL], originalURL: URL) {
    for chunk in chunks where chunk.path != originalURL.path {
      try? FileManager.default.removeItem(at: chunk)
    }
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

  private func transcribeAudioURL(_ url: URL, chunkIndex: Int, chunkCount: Int) -> (String, String) {
    let request = SFSpeechURLRecognitionRequest(url: url)
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
          printJSON([
            "event": "partial",
            "transcript": text,
            "isFinal": result.isFinal,
            "chunkIndex": chunkIndex,
            "chunkCount": chunkCount
          ])
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

  private func transcribeAudioFile(_ url: URL) -> (String, String, Int, Double) {
    let durationSeconds = audioDurationSeconds(url)
    var chunks: [URL] = [url]
    var setupErrors: [String] = []
    do {
      chunks = try chunkAudioFile(url)
    } catch {
      setupErrors.append("音频切片失败，已尝试整段识别：\(error.localizedDescription)")
      chunks = [url]
    }
    defer { removeTemporaryChunks(chunks, originalURL: url) }

    var transcripts: [String] = []
    var recognitionErrors: [String] = setupErrors
    for (offset, chunkURL) in chunks.enumerated() {
      let (chunkTranscript, recognitionError) = transcribeAudioURL(
        chunkURL,
        chunkIndex: offset + 1,
        chunkCount: chunks.count
      )
      if !chunkTranscript.isEmpty {
        transcripts.append(chunkTranscript)
      }
      if !recognitionError.isEmpty {
        recognitionErrors.append("第 \(offset + 1) 段：\(recognitionError)")
      }
    }
    return (
      transcripts.joined(separator: " "),
      recognitionErrors.joined(separator: "；"),
      chunks.count,
      durationSeconds
    )
  }

  func transcribeExistingAudio(path: String) {
    let url = URL(fileURLWithPath: path)
    let bytes = fileSize(url)
    let (transcript, recognitionError, chunkCount, durationSeconds) = transcribeAudioFile(url)
    printJSON([
      "event": "final",
      "transcript": transcript,
      "recognitionError": recognitionError,
      "recordingBytes": bytes,
      "recognitionChunks": chunkCount,
      "durationSeconds": durationSeconds,
      "recognizerAvailable": recognizer.isAvailable
    ])
  }

  func printChunkInfo(path: String) throws {
    let url = URL(fileURLWithPath: path)
    let chunks = try chunkAudioFile(url)
    defer { removeTemporaryChunks(chunks, originalURL: url) }
    printJSON([
      "event": "chunkInfo",
      "durationSeconds": audioDurationSeconds(url),
      "recordingBytes": fileSize(url),
      "recognitionChunks": chunks.count,
      "chunkBytes": chunks.map { fileSize($0) }
    ])
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

    let (transcript, recognitionError, chunkCount, durationSeconds) = transcribeAudioFile(recordingURL)
    let debugAudioPath = preserveDebugAudioIfNeeded(transcript: transcript)
    printJSON([
      "event": "final",
      "transcript": transcript,
      "recognitionError": recognitionError,
      "recordingBytes": bytes,
      "peakPower": peakPower,
      "averagePower": averagePower,
      "recognitionChunks": chunkCount,
      "durationSeconds": durationSeconds,
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

func requestPermissions(needsMicrophone: Bool) {
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

let inputIndex = CommandLine.arguments.firstIndex(of: "--input")
let inputPath = inputIndex.flatMap { index -> String? in
  let next = CommandLine.arguments.index(after: index)
  return next < CommandLine.arguments.endIndex ? CommandLine.arguments[next] : nil
}

let chunkInfoIndex = CommandLine.arguments.firstIndex(of: "--chunk-info")
let chunkInfoPath = chunkInfoIndex.flatMap { index -> String? in
  let next = CommandLine.arguments.index(after: index)
  return next < CommandLine.arguments.endIndex ? CommandLine.arguments[next] : nil
}

if let chunkInfoPath, !chunkInfoPath.isEmpty {
  do {
    let session = try SpeechSession(localeIdentifier: localeIdentifier, debugDirectoryPath: nil)
    try session.printChunkInfo(path: chunkInfoPath)
    exit(0)
  } catch {
    fail(error.localizedDescription)
  }
}

requestPermissions(needsMicrophone: inputPath == nil)

do {
  let session = try SpeechSession(localeIdentifier: localeIdentifier, debugDirectoryPath: debugDirectoryPath)
  if let inputPath, !inputPath.isEmpty {
    session.transcribeExistingAudio(path: inputPath)
    exit(0)
  }
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
