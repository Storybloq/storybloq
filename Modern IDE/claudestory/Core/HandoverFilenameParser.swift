import Foundation

/// Parse a handover filename into date prefix and title.
/// Strips `.md` suffix, extracts `YYYY-MM-DD` date prefix if present,
/// converts remaining hyphens to spaces for the title.
nonisolated func parseHandoverFilename(_ filename: String) -> (date: String?, title: String) {
    var name = filename
    if name.hasSuffix(".md") {
        name = String(name.dropLast(3))
    }

    let datePattern = /^\d{4}-\d{2}-\d{2}/
    if let match = name.prefixMatch(of: datePattern) {
        let date = String(match.output)
        var title = String(name.dropFirst(date.count))
        // Strip leading hyphen separator
        if title.hasPrefix("-") {
            title = String(title.dropFirst())
        }
        title = title.replacingOccurrences(of: "-", with: " ")
            .trimmingCharacters(in: .whitespaces)
        return (date: date, title: title)
    }

    return (date: nil, title: name)
}
