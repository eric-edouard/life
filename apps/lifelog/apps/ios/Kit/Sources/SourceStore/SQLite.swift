import Foundation
import SQLite3

public enum SQLValue {
    case null
    case int(Int64)
    case real(Double)
    case text(String)
    case blob(Data)
}

/// A thin, single-connection SQLite handle. Owned by one actor, so it needs no locking.
public final class SQLite {
    private let db: OpaquePointer

    /// `readOnly`: a connection that can't change the file, nor create it.
    public init(path: String, readOnly: Bool = false) throws {
        var handle: OpaquePointer?
        let flags = readOnly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE
        let code = sqlite3_open_v2(path, &handle, flags, nil)
        guard code == SQLITE_OK, let handle else {
            sqlite3_close(handle)
            throw SourceStoreError.sqlite(code: code, message: "open failed")
        }
        db = handle
    }

    deinit { sqlite3_close_v2(db) }

    /// Runs one or more statements without parameters.
    public func execute(_ sql: String) throws {
        try check(sqlite3_exec(db, sql, nil, nil, nil))
    }

    /// Runs one statement and returns the number of rows it changed.
    @discardableResult
    public func run(_ sql: String, _ values: [SQLValue] = []) throws -> Int {
        _ = try query(sql, values) { _ in () }
        return Int(sqlite3_changes(db))
    }

    public func query<T>(_ sql: String, _ values: [SQLValue] = [], row: (Row) throws -> T) throws -> [T] {
        var statement: OpaquePointer?
        try check(sqlite3_prepare_v2(db, sql, -1, &statement, nil))
        guard let statement else { return [] }
        defer { sqlite3_finalize(statement) }
        // SQLITE_TRANSIENT: SQLite copies bound text and blobs before this call returns.
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (offset, value) in values.enumerated() {
            let position = Int32(offset + 1)
            let code: Int32
            switch value {
            case .null: code = sqlite3_bind_null(statement, position)
            case .int(let int): code = sqlite3_bind_int64(statement, position, int)
            case .real(let real): code = sqlite3_bind_double(statement, position, real)
            case .text(let text): code = sqlite3_bind_text(statement, position, text, -1, transient)
            case .blob(let blob) where blob.isEmpty: code = sqlite3_bind_zeroblob(statement, position, 0)
            case .blob(let blob):
                code = blob.withUnsafeBytes {
                    sqlite3_bind_blob(statement, position, $0.baseAddress, Int32($0.count), transient)
                }
            }
            try check(code)
        }
        var rows: [T] = []
        while true {
            let code = sqlite3_step(statement)
            if code == SQLITE_DONE { return rows }
            guard code == SQLITE_ROW else { throw error(code) }
            rows.append(try row(Row(statement: statement)))
        }
    }

    public func transaction<T>(_ body: () throws -> T) throws -> T {
        try execute("BEGIN IMMEDIATE")
        do {
            let result = try body()
            try execute("COMMIT")
            return result
        } catch {
            try? execute("ROLLBACK")
            throw error
        }
    }

    /// The schema version the file's migrations reached (`PRAGMA user_version`); 0 for a new file.
    public func userVersion() throws -> Int {
        try query("PRAGMA user_version") { Int($0.int(0)) }.first ?? 0
    }

    /// Makes every commit durable, then runs the forward-only `migrations` the file hasn't had, each in one transaction
    /// with its version, so an interrupted one runs again whole. A file a newer app wrote throws `tooNew(version)`.
    /// `steps`: Swift a migration runs after its SQL, in its transaction, by its index in `migrations`.
    public func migrate(
        _ migrations: [String], tooNew: (Int) -> any Error, steps: [Int: () throws -> Void] = [:]
    ) throws {
        let version = try userVersion()
        guard version <= migrations.count else { throw tooNew(version) }
        try execute(
            """
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = FULL;
            PRAGMA fullfsync = ON;
            PRAGMA checkpoint_fullfsync = ON;
            """
        )
        for (index, sql) in migrations.enumerated().dropFirst(version) {
            try transaction {
                try execute(sql)
                try steps[index]?()
                try execute("PRAGMA user_version = \(index + 1)")
            }
        }
    }

    private func check(_ code: Int32) throws {
        guard code == SQLITE_OK else { throw error(code) }
    }

    private func error(_ code: Int32) -> SourceStoreError {
        .sqlite(code: code, message: String(cString: sqlite3_errmsg(db)))
    }
}

public struct Row {
    let statement: OpaquePointer

    public func isNull(_ column: Int32) -> Bool { sqlite3_column_type(statement, column) == SQLITE_NULL }
    public func int(_ column: Int32) -> Int64 { sqlite3_column_int64(statement, column) }
    func real(_ column: Int32) -> Double { sqlite3_column_double(statement, column) }
    public func text(_ column: Int32) -> String {
        sqlite3_column_text(statement, column).map { String(cString: $0) } ?? ""
    }
    public func blob(_ column: Int32) -> Data {
        guard let bytes = sqlite3_column_blob(statement, column) else { return Data() }
        return Data(bytes: bytes, count: Int(sqlite3_column_bytes(statement, column)))
    }
}
