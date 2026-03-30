import Testing
@testable import Modern_IDE

// MARK: - Handover Filename Parsing Tests

struct HandoverFilenameParsingTests {
    @Test func parseStandardFilename() {
        let result = parseHandoverFilename("2026-03-11-batch2.md")
        #expect(result.date == "2026-03-11")
        #expect(result.title == "batch2")
    }

    @Test func parseMultiWordFilename() {
        let result = parseHandoverFilename("2026-03-11-strategy-revision.md")
        #expect(result.date == "2026-03-11")
        #expect(result.title == "strategy revision")
    }

    @Test func parseNoDatePrefix() {
        let result = parseHandoverFilename("notes.md")
        #expect(result.date == nil)
        #expect(result.title == "notes")
    }

    @Test func parseNoExtension() {
        let result = parseHandoverFilename("2026-03-11-foo")
        #expect(result.date == "2026-03-11")
        #expect(result.title == "foo")
    }

    @Test func parseDateOnly() {
        let result = parseHandoverFilename("2026-03-11.md")
        #expect(result.date == "2026-03-11")
        #expect(result.title == "")
    }

    @Test func parseEmptyString() {
        let result = parseHandoverFilename("")
        #expect(result.date == nil)
        #expect(result.title == "")
    }

    @Test func parseDoubleHyphens() {
        let result = parseHandoverFilename("2026-03-11--quick-fix.md")
        #expect(result.date == "2026-03-11")
        // Double hyphen: first stripped as separator, second becomes space, then trimmed
        #expect(result.title == "quick fix")
    }

    @Test func parseNoMdExtension() {
        let result = parseHandoverFilename("2026-03-11-notes.txt")
        #expect(result.date == "2026-03-11")
        // Only .md is stripped — .txt is preserved in title
        #expect(result.title == "notes.txt")
    }
}
