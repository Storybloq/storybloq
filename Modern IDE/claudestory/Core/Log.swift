import Foundation
import os

// MARK: - LogLevel

enum LogLevel: Int, Comparable, Sendable {
    case debug = 0
    case info = 1
    case warning = 2
    case error = 3

    static func < (lhs: LogLevel, rhs: LogLevel) -> Bool {
        lhs.rawValue < rhs.rawValue
    }
}

// MARK: - Log

/// Simple print-based logging with levels. Set `Log.level` to enable.
///
/// - `nil` (default): all logging disabled, zero cost via @autoclosure
/// - `.debug`: see everything
/// - `.warning`: only warnings and errors
/// - `.error`: only errors
///
/// Usage:
/// ```
/// Log.level = .debug  // enable in debug builds
/// Log.debug("details", tag: "CLIRunner")
/// Log.error("failed to parse", tag: "CLIParser")
/// ```
enum Log {
    /// Minimum level to output. Set to nil to disable all logging.
    /// Thread-safe: guarded by unfair lock for concurrent reads from async contexts.
    private static let _level = OSAllocatedUnfairLock<LogLevel?>(initialState: nil)

    static var level: LogLevel? {
        get { _level.withLock { $0 } }
        set { _level.withLock { $0 = newValue } }
    }

    static func debug(_ message: @autoclosure () -> String, tag: String = "") {
        log(.debug, message, tag: tag)
    }

    static func info(_ message: @autoclosure () -> String, tag: String = "") {
        log(.info, message, tag: tag)
    }

    static func warning(_ message: @autoclosure () -> String, tag: String = "") {
        log(.warning, message, tag: tag)
    }

    static func error(_ message: @autoclosure () -> String, tag: String = "") {
        log(.error, message, tag: tag)
    }

    private static func log(_ lvl: LogLevel, _ message: () -> String, tag: String) {
        guard let threshold = level, lvl >= threshold else { return }
        let prefix = tag.isEmpty ? "[\(lvl)]" : "[\(lvl)][\(tag)]"
        print("\(prefix) \(message())")
    }
}
