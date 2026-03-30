import Testing
import Foundation
@testable import Modern_IDE

struct NoteModelTests {
    @Test func decodesFullNote() throws {
        let json = """
        {"id":"N-001","title":"Design ideas","content":"Explore sidebar layouts.",
         "tags":["brainstorm","ui"],"status":"active",
         "createdDate":"2026-03-22","updatedDate":"2026-03-22"}
        """.data(using: .utf8)!

        let note = try JSONDecoder().decode(Note.self, from: json)
        #expect(note.id == "N-001")
        #expect(note.title == "Design ideas")
        #expect(note.content == "Explore sidebar layouts.")
        #expect(note.tags == ["brainstorm", "ui"])
        #expect(note.status == .active)
        #expect(note.createdDate == "2026-03-22")
        #expect(note.updatedDate == "2026-03-22")
    }

    @Test func decodesNullTitle() throws {
        let json = """
        {"id":"N-002","title":null,"content":"Quick thought.",
         "tags":[],"status":"active",
         "createdDate":"2026-03-22","updatedDate":"2026-03-22"}
        """.data(using: .utf8)!

        let note = try JSONDecoder().decode(Note.self, from: json)
        #expect(note.title == nil)
        #expect(note.tags.isEmpty)
    }

    @Test func decodesArchivedStatus() throws {
        let json = """
        {"id":"N-003","title":null,"content":"Old idea.",
         "tags":["archived-thought"],"status":"archived",
         "createdDate":"2026-03-20","updatedDate":"2026-03-22"}
        """.data(using: .utf8)!

        let note = try JSONDecoder().decode(Note.self, from: json)
        #expect(note.status == .archived)
    }

    @Test func roundTripPreservesAllFields() throws {
        let note = Note(
            id: "N-010", title: "Round-trip", content: "Test content.",
            tags: ["test", "roundtrip"], status: .active,
            createdDate: "2026-03-22", updatedDate: "2026-03-23"
        )

        let data = try JSONEncoder().encode(note)
        let decoded = try JSONDecoder().decode(Note.self, from: data)

        #expect(decoded == note)
    }

    @Test func roundTripPreservesNullTitle() throws {
        let note = Note(
            id: "N-011", title: nil, content: "No title.",
            tags: [], status: .active,
            createdDate: "2026-03-22", updatedDate: "2026-03-22"
        )

        let data = try JSONEncoder().encode(note)
        let decoded = try JSONDecoder().decode(Note.self, from: data)

        #expect(decoded == note)
        #expect(decoded.title == nil)
    }

    @Test func decodesNoteWithMissingTagsKey() throws {
        let json = """
        {"id":"N-012","title":null,"content":"No tags key.",
         "status":"active","createdDate":"2026-03-22","updatedDate":"2026-03-22"}
        """.data(using: .utf8)!

        let note = try JSONDecoder().decode(Note.self, from: json)
        #expect(note.tags == [])
    }
}
