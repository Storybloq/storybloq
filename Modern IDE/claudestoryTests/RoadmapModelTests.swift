import Foundation
import Testing
@testable import Modern_IDE

struct RoadmapModelTests {
    @Test func decodesFullRoadmap() throws {
        let json = """
        {
          "title": "claudestory",
          "date": "2026-03-11",
          "phases": [
            {"id": "dogfood", "label": "PHASE 0", "name": "Dogfood Infrastructure", "description": "Bootstrap the project."},
            {"id": "viewer", "label": "PHASE 1", "name": "Mac App — Project Viewer", "description": "Sidebar + models."}
          ],
          "blockers": [
            {"name": "npm claudestory reserved", "cleared": true, "note": "Reserved as v0.0.1 on 2026-03-10."}
          ]
        }
        """.data(using: .utf8)!

        let roadmap = try JSONDecoder().decode(Roadmap.self, from: json)
        #expect(roadmap.title == "claudestory")
        #expect(roadmap.date == "2026-03-11")
        #expect(roadmap.phases.count == 2)
        #expect(roadmap.blockers.count == 1)
    }

    @Test func blockerIncludesNoteField() throws {
        let json = """
        {"name":"npm claudestory reserved","cleared":true,"note":"Reserved as v0.0.1 on 2026-03-10."}
        """.data(using: .utf8)!

        let blocker = try JSONDecoder().decode(Blocker.self, from: json)
        #expect(blocker.name == "npm claudestory reserved")
        #expect(blocker.cleared == true)
        #expect(blocker.note == "Reserved as v0.0.1 on 2026-03-10.")
    }

    @Test func phasesHaveUniqueIDs() throws {
        let json = """
        {
          "title": "test",
          "date": "2026-03-11",
          "phases": [
            {"id": "dogfood", "label": "P0", "name": "Phase Zero", "description": "First."},
            {"id": "viewer", "label": "P1", "name": "Phase One", "description": "Second."},
            {"id": "detail", "label": "P2", "name": "Phase Two", "description": "Third."}
          ],
          "blockers": []
        }
        """.data(using: .utf8)!

        let roadmap = try JSONDecoder().decode(Roadmap.self, from: json)
        let ids = roadmap.phases.map(\.id)
        #expect(Set(ids).count == ids.count)
    }

    @Test func blockerDecodesWithoutNote() throws {
        let json = """
        {"name":"some blocker","cleared":false}
        """.data(using: .utf8)!

        let blocker = try JSONDecoder().decode(Blocker.self, from: json)
        #expect(blocker.name == "some blocker")
        #expect(blocker.cleared == false)
        #expect(blocker.note == nil)
    }

    @Test func roundTrips() throws {
        let json = """
        {"title":"test","date":"2026-03-11","phases":[{"id":"dogfood","label":"P0","name":"Phase Zero","description":"First."}],"blockers":[{"name":"blocker","cleared":false,"note":"Still open."}]}
        """.data(using: .utf8)!

        let original = try JSONDecoder().decode(Roadmap.self, from: json)
        let encoded = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(Roadmap.self, from: encoded)
        #expect(original == decoded)
    }

    // MARK: - New-format blocker tests

    @Test func blockerDecodesNewFormat() throws {
        let json = """
        {"name":"npm reserved","createdDate":"2026-03-10","clearedDate":"2026-03-10","note":"Done."}
        """.data(using: .utf8)!

        let blocker = try JSONDecoder().decode(Blocker.self, from: json)
        #expect(blocker.name == "npm reserved")
        #expect(blocker.cleared == true)
        #expect(blocker.createdDate == "2026-03-10")
        #expect(blocker.clearedDate == "2026-03-10")
        #expect(blocker.note == "Done.")
    }

    @Test func blockerDecodesNewFormatUncleared() throws {
        let json = """
        {"name":"waiting","createdDate":"2026-03-15","clearedDate":null}
        """.data(using: .utf8)!

        let blocker = try JSONDecoder().decode(Blocker.self, from: json)
        #expect(blocker.cleared == false)
        #expect(blocker.createdDate == "2026-03-15")
        #expect(blocker.clearedDate == nil)
    }

    @Test func blockerEncodesNewFormat() throws {
        let json = """
        {"name":"test","createdDate":"2026-03-10","clearedDate":"2026-03-12","note":"Cleared."}
        """.data(using: .utf8)!

        let blocker = try JSONDecoder().decode(Blocker.self, from: json)
        let encoded = try JSONEncoder().encode(blocker)
        let dict = try JSONSerialization.jsonObject(with: encoded) as! [String: Any]

        #expect(dict["createdDate"] as? String == "2026-03-10")
        #expect(dict["clearedDate"] as? String == "2026-03-12")
        #expect(!dict.keys.contains("cleared")) // No legacy key
    }

    @Test func legacyBlockerRoundTrips() throws {
        let json = """
        {"name":"legacy blocker","cleared":true,"note":"Old format."}
        """.data(using: .utf8)!

        let original = try JSONDecoder().decode(Blocker.self, from: json)
        #expect(original.cleared == true)

        let encoded = try JSONEncoder().encode(original)
        let dict = try JSONSerialization.jsonObject(with: encoded) as! [String: Any]

        // Legacy format preserved on encode
        #expect(dict["cleared"] as? Bool == true)
        #expect(dict["createdDate"] == nil) // No fabricated dates
        #expect(dict["clearedDate"] == nil)

        // Round-trip decode
        let decoded = try JSONDecoder().decode(Blocker.self, from: encoded)
        #expect(original == decoded)
    }

    @Test func minimalBlockerRoundTrips() throws {
        let json = """
        {"name":"Waiting"}
        """.data(using: .utf8)!

        let blocker = try JSONDecoder().decode(Blocker.self, from: json)
        #expect(blocker.name == "Waiting")
        #expect(blocker.cleared == false)
        #expect(blocker.createdDate == nil)
        #expect(blocker.clearedDate == nil)
        #expect(blocker.note == nil)

        let encoded = try JSONEncoder().encode(blocker)
        let dict = try JSONSerialization.jsonObject(with: encoded) as! [String: Any]

        // No cleared/date keys introduced
        #expect(dict["cleared"] == nil)
        #expect(dict["createdDate"] == nil)
        #expect(dict["clearedDate"] == nil)
        #expect(dict["name"] as? String == "Waiting")

        // Round-trip
        let decoded = try JSONDecoder().decode(Blocker.self, from: encoded)
        #expect(blocker == decoded)
    }

    @Test func minimalBlockerWithNullNoteRoundTrips() throws {
        let json = """
        {"name":"Waiting","note":null}
        """.data(using: .utf8)!

        let blocker = try JSONDecoder().decode(Blocker.self, from: json)
        #expect(blocker.note == nil)

        let encoded = try JSONEncoder().encode(blocker)
        let decoded = try JSONDecoder().decode(Blocker.self, from: encoded)
        #expect(blocker == decoded)
    }

    @Test func newFormatBlockerRoundTrips() throws {
        let json = """
        {"name":"test","createdDate":"2026-03-10","clearedDate":"2026-03-12","note":"Done."}
        """.data(using: .utf8)!

        let original = try JSONDecoder().decode(Blocker.self, from: json)
        let encoded = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(Blocker.self, from: encoded)
        #expect(original == decoded)
    }

    // MARK: - Blocker edge cases

    @Test func mixedFormatBlockerDecodesDated() throws {
        // CLI's handleBlockerAdd creates blockers with both cleared + date keys.
        // The decoder treats this as dated format (date keys take precedence).
        let json = """
        {"name":"mixed","cleared":false,"createdDate":"2026-03-23","clearedDate":null,"note":null}
        """.data(using: .utf8)!

        let blocker = try JSONDecoder().decode(Blocker.self, from: json)
        #expect(blocker.name == "mixed")
        #expect(blocker.cleared == false) // clearedDate is null → not cleared
        #expect(blocker.createdDate == "2026-03-23")
        #expect(blocker.clearedDate == nil)
    }

    @Test func mixedFormatClearedBlockerDecodesDated() throws {
        // CLI's handleBlockerClear creates blockers with cleared:true + clearedDate.
        let json = """
        {"name":"done","cleared":true,"createdDate":"2026-03-20","clearedDate":"2026-03-23","note":"Fixed."}
        """.data(using: .utf8)!

        let blocker = try JSONDecoder().decode(Blocker.self, from: json)
        #expect(blocker.cleared == true) // clearedDate is non-nil → cleared
        #expect(blocker.createdDate == "2026-03-20")
        #expect(blocker.clearedDate == "2026-03-23")
        #expect(blocker.note == "Fixed.")
    }

    @Test func programmaticInitMinimal() throws {
        let blocker = Blocker(name: "test")
        #expect(blocker.cleared == false)
        #expect(blocker.createdDate == nil)
        #expect(blocker.clearedDate == nil)

        let encoded = try JSONEncoder().encode(blocker)
        let dict = try JSONSerialization.jsonObject(with: encoded) as! [String: Any]
        #expect(dict["cleared"] == nil)
        #expect(dict["createdDate"] == nil)
    }

    @Test func programmaticInitDated() throws {
        let blocker = Blocker(name: "test", createdDate: "2026-03-10", clearedDate: "2026-03-12")
        #expect(blocker.cleared == true)

        let encoded = try JSONEncoder().encode(blocker)
        let dict = try JSONSerialization.jsonObject(with: encoded) as! [String: Any]
        #expect(dict["createdDate"] as? String == "2026-03-10")
        #expect(dict["clearedDate"] as? String == "2026-03-12")
        #expect(dict["cleared"] == nil)
    }

    @Test func programmaticInitOnlyClearedDate() throws {
        let blocker = Blocker(name: "test", clearedDate: "2026-03-10")
        #expect(blocker.cleared == true)
        #expect(blocker.createdDate == nil)

        let encoded = try JSONEncoder().encode(blocker)
        let dict = try JSONSerialization.jsonObject(with: encoded) as! [String: Any]
        // createdDate omitted (encodeIfPresent — TS schema is optional, not nullable)
        #expect(!dict.keys.contains("createdDate"))
        #expect(dict.keys.contains("clearedDate"))
    }

    @Test func datedWithOnlyClearedDateRoundTrips() throws {
        let json = """
        {"name":"x","clearedDate":"2026-03-10"}
        """.data(using: .utf8)!

        let original = try JSONDecoder().decode(Blocker.self, from: json)
        #expect(original.cleared == true)
        #expect(original.createdDate == nil)

        let encoded = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(Blocker.self, from: encoded)
        #expect(original == decoded)
    }

    @Test func legacyFalseNotEqualToMinimal() throws {
        let legacyJSON = """
        {"name":"x","cleared":false}
        """.data(using: .utf8)!
        let minimalJSON = """
        {"name":"x"}
        """.data(using: .utf8)!

        let legacy = try JSONDecoder().decode(Blocker.self, from: legacyJSON)
        let minimal = try JSONDecoder().decode(Blocker.self, from: minimalJSON)

        // Same observable data but different formats — not equal
        #expect(legacy != minimal)
    }

    // MARK: - Phase summary tests

    @Test func phaseDecodesSummary() throws {
        let json = """
        {"id":"dogfood","label":"P0","name":"Dogfood","description":"Bootstrap.","summary":"CLAUDE.md, RULES.md"}
        """.data(using: .utf8)!

        let phase = try JSONDecoder().decode(Phase.self, from: json)
        #expect(phase.summary == "CLAUDE.md, RULES.md")
    }

    @Test func phaseDecodesWithoutSummary() throws {
        let json = """
        {"id":"dogfood","label":"P0","name":"Dogfood","description":"Bootstrap."}
        """.data(using: .utf8)!

        let phase = try JSONDecoder().decode(Phase.self, from: json)
        #expect(phase.summary == nil)
    }
}
