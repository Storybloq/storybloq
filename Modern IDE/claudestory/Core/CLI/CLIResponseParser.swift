import Foundation

// MARK: - CLI Response Envelopes

/// Success envelope: `{ "version": 1, "data": <T> }`
struct CLISuccessEnvelope<T: Decodable>: Decodable {
    let version: Int
    let data: T
}

/// Error detail within the error envelope.
struct CLIErrorDetail: Decodable {
    let code: String
    let message: String
}

/// Error envelope: `{ "version": 1, "error": { "code": "...", "message": "..." } }`
struct CLIErrorEnvelope: Decodable {
    let version: Int
    let error: CLIErrorDetail
}

/// Delete confirmation: `{ "id": "...", "deleted": true }`
struct CLIDeleteConfirmation: Decodable {
    let id: String
    let deleted: Bool
}

/// Handover creation result: `{ "filename": "..." }`
struct CLIHandoverResult: Decodable {
    let filename: String
}

/// Blocker result from add/clear. Confirms the operation touched the intended blocker.
struct CLIBlockerResult: Decodable {
    let name: String
}

// MARK: - StoryWriterError

/// Errors from the StoryWriter layer.
enum StoryWriterError: LocalizedError, Equatable {
    case cliNotFound
    case cliError(code: String, message: String)
    case unexpectedOutput(String)
    case processFailure(exitCode: Int32, stderr: String)

    var errorDescription: String? {
        switch self {
        case .cliNotFound:
            "claudestory CLI not found. Install with: npm install -g @anthropologies/claudestory"
        case .cliError(_, let message):
            message
        case .unexpectedOutput(let detail):
            "Unexpected CLI output: \(detail)"
        case .processFailure(let exitCode, let stderr):
            "CLI process failed (exit \(exitCode)): \(stderr)"
        }
    }
}

// MARK: - CLIResponseParser

/// Parses CLI JSON output into typed results.
enum CLIResponseParser {

    /// Parse a success envelope containing entity of type T.
    static func parse<T: Decodable>(_ type: T.Type, from result: CLIResult) throws -> T {
        if result.exitCode != 0 {
            let error = parseError(from: result)
            Log.error("\(error)", tag: "CLIParser")
            throw error
        }

        guard let data = result.stdout.data(using: .utf8), !data.isEmpty else {
            Log.error("empty stdout", tag: "CLIParser")
            throw StoryWriterError.unexpectedOutput("Empty stdout")
        }

        do {
            let envelope = try JSONDecoder().decode(CLISuccessEnvelope<T>.self, from: data)
            Log.debug("decoded \(T.self) OK", tag: "CLIParser")
            return envelope.data
        } catch {
            Log.error("decode failed for \(T.self): \(error)", tag: "CLIParser")
            throw StoryWriterError.unexpectedOutput(
                "Failed to decode \(T.self): \(error.localizedDescription)"
            )
        }
    }

    /// Parse a delete confirmation and validate the response.
    static func parseDeleteConfirmation(from result: CLIResult) throws {
        if result.exitCode != 0 {
            throw parseError(from: result)
        }
        guard let data = result.stdout.data(using: .utf8), !data.isEmpty else {
            throw StoryWriterError.unexpectedOutput("Empty stdout on delete")
        }
        do {
            let envelope = try JSONDecoder().decode(CLISuccessEnvelope<CLIDeleteConfirmation>.self, from: data)
            guard envelope.data.deleted else {
                throw StoryWriterError.unexpectedOutput("Delete response has deleted=false for \(envelope.data.id)")
            }
        } catch let swError as StoryWriterError {
            throw swError
        } catch {
            throw StoryWriterError.unexpectedOutput("Failed to decode delete confirmation: \(error.localizedDescription)")
        }
    }

    /// Parse a success envelope but discard the data (for void-result operations).
    static func parseSuccess(from result: CLIResult) throws {
        if result.exitCode != 0 {
            throw parseError(from: result)
        }
    }

    /// Extract a StoryWriterError from a failed CLI result.
    private static func parseError(from result: CLIResult) -> StoryWriterError {
        // Try to parse structured error envelope from stdout
        if let data = result.stdout.data(using: .utf8),
           let errorEnv = try? JSONDecoder().decode(CLIErrorEnvelope.self, from: data) {
            return .cliError(code: errorEnv.error.code, message: errorEnv.error.message)
        }
        return .processFailure(exitCode: result.exitCode, stderr: result.stderr)
    }
}
