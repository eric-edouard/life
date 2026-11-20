import Foundation

#if canImport(FoundationModels)
  import FoundationModels
#endif

// life-foundation-model: Apple's on-device model (Foundation Models), for Life's arrival reader
// (apps/server/src/models/foundation-model.ts). Never Private Cloud Compute: `SystemLanguageModel.default` only. It knows
// no prompt: each stdin line is one request `{instructions, fields: [{name, description, anyOf?}], text}`, answered by
// one stdout line, `{reply: {<field>: <string>}, os}` or `{error: refused|unsupported|unavailable|failed, detail}`.

func emit(_ value: [String: Any]) {
  let data = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{}".utf8)
  FileHandle.standardOutput.write(data + Data("\n".utf8))
}

let os = ProcessInfo.processInfo.operatingSystemVersionString

struct Field: Decodable {
  let name: String
  let description: String
  let anyOf: [String]?
}

struct Request: Decodable {
  let instructions: String
  let fields: [Field]
  let text: String
}

#if canImport(FoundationModels)
  @available(macOS 26.0, *)
  func answer(_ r: Request) async -> [String: Any] {
    guard case .available = SystemLanguageModel.default.availability else {
      return ["detail": "\(SystemLanguageModel.default.availability)", "error": "unavailable"]
    }
    do {
      let root = DynamicGenerationSchema(
        name: "Answer",
        properties: r.fields.map { f in
          DynamicGenerationSchema.Property(
            name: f.name, description: f.description,
            schema: f.anyOf.map { DynamicGenerationSchema(name: f.name, anyOf: $0) }
              ?? DynamicGenerationSchema(type: String.self))
        })
      let schema = try GenerationSchema(root: root, dependencies: [])
      let session = LanguageModelSession(model: SystemLanguageModel.default, instructions: r.instructions)
      let content = try await session.respond(
        to: r.text, schema: schema, options: GenerationOptions(temperature: 0)
      ).content
      var reply: [String: String] = [:]
      for f in r.fields {
        reply[f.name] = try content.value(String.self, forProperty: f.name)
      }
      return ["os": os, "reply": reply]
    } catch let e as LanguageModelSession.GenerationError {
      switch e {
      case .guardrailViolation, .refusal: return ["detail": "\(e)", "error": "refused"]
      case .unsupportedLanguageOrLocale: return ["detail": "\(e)", "error": "unsupported"]
      case .assetsUnavailable: return ["detail": "\(e)", "error": "unavailable"]
      default: return ["detail": "\(e)", "error": "failed"]
      }
    } catch {
      return ["detail": "\(error)", "error": "failed"]
    }
  }
#endif

while let line = readLine() {
  guard let r = try? JSONDecoder().decode(Request.self, from: Data(line.utf8)) else {
    emit(["detail": "not a request", "error": "failed"])
    continue
  }
  #if canImport(FoundationModels)
    if #available(macOS 26.0, *) {
      emit(await answer(r))
      continue
    }
  #endif
  emit(["detail": "no Foundation Models on this Mac", "error": "unavailable"])
}
