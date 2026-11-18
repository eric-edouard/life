import Foundation

/// How Life's answers are read: its instants are ISO 8601 with milliseconds, its keys are the models' names.
public enum LifeCodec {
    public static func decode<Value: Decodable>(_ type: Value.Type, from text: String) throws -> Value {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            if let date = (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text))
                ?? (try? Date.ISO8601FormatStyle().parse(text))
            {
                return date
            }
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Not an instant: \(text)"))
        }
        return try decoder.decode(type, from: Data(text.utf8))
    }
}
