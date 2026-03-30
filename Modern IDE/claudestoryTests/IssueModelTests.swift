import Testing
import Foundation
@testable import Modern_IDE

struct IssueModelTests {
    @Test func decodesOpenIssue() throws {
        let json = """
        {"id":"ISS-001","title":"Bug title","status":"open","severity":"high",
         "components":["safety"],"impact":"What's broken.","resolution":null,
         "location":["file.swift:41"],"discoveredDate":"2026-03-10",
         "resolvedDate":null,"relatedTickets":[]}
        """.data(using: .utf8)!

        let issue = try JSONDecoder().decode(Issue.self, from: json)
        #expect(issue.id == "ISS-001")
        #expect(issue.status == .open)
        #expect(issue.severity == .high)
        #expect(issue.components == ["safety"])
        #expect(issue.resolution == nil)
        #expect(issue.resolvedDate == nil)
        #expect(issue.location == ["file.swift:41"])
    }

    @Test func decodesResolvedIssue() throws {
        let json = """
        {"id":"ISS-002","title":"Fixed bug","status":"resolved","severity":"medium",
         "components":["ui","model"],"impact":"UI glitch.","resolution":"Patched in T-015.",
         "location":["view.swift:12","model.swift:88"],"discoveredDate":"2026-03-10",
         "resolvedDate":"2026-03-11","relatedTickets":["T-015"]}
        """.data(using: .utf8)!

        let issue = try JSONDecoder().decode(Issue.self, from: json)
        #expect(issue.status == .resolved)
        #expect(issue.resolution == "Patched in T-015.")
        #expect(issue.resolvedDate == "2026-03-11")
        #expect(issue.relatedTickets == ["T-015"])
        #expect(issue.components.count == 2)
    }

    @Test func roundTrips() throws {
        let json = """
        {"id":"ISS-001","title":"Bug","status":"open","severity":"critical",
         "components":["safety"],"impact":"Crash.","resolution":null,
         "location":[],"discoveredDate":"2026-03-10",
         "resolvedDate":null,"relatedTickets":[]}
        """.data(using: .utf8)!

        let original = try JSONDecoder().decode(Issue.self, from: json)
        let encoded = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(Issue.self, from: encoded)
        #expect(original == decoded)
    }

    @Test func severityComparable() {
        #expect(IssueSeverity.critical < IssueSeverity.high)
        #expect(IssueSeverity.high < IssueSeverity.medium)
        #expect(IssueSeverity.medium < IssueSeverity.low)
        #expect(!(IssueSeverity.low < IssueSeverity.critical))
    }

    @Test func decodesInProgressIssue() throws {
        let json = """
        {"id":"ISS-003","title":"WIP bug","status":"inprogress","severity":"medium",
         "components":["ui"],"impact":"Investigating.","resolution":null,
         "location":[],"discoveredDate":"2026-03-18",
         "resolvedDate":null,"relatedTickets":[]}
        """.data(using: .utf8)!

        let issue = try JSONDecoder().decode(Issue.self, from: json)
        #expect(issue.status == .inprogress)
    }

    @Test func decodesIssueWithoutOrderAndPhase() throws {
        // Backward compatibility: existing JSON files lack order and phase
        let json = """
        {"id":"ISS-001","title":"Bug","status":"open","severity":"high",
         "components":[],"impact":"Crash.","resolution":null,
         "location":[],"discoveredDate":"2026-03-10",
         "resolvedDate":null,"relatedTickets":[]}
        """.data(using: .utf8)!

        let issue = try JSONDecoder().decode(Issue.self, from: json)
        #expect(issue.order == 0)
        #expect(issue.phase == nil)
    }

    @Test func decodesIssueWithOrderAndPhase() throws {
        let json = """
        {"id":"ISS-005","title":"Phased bug","status":"open","severity":"low",
         "components":[],"impact":"Minor.","resolution":null,
         "location":[],"discoveredDate":"2026-03-18",
         "resolvedDate":null,"relatedTickets":[],"order":30,"phase":"terminal"}
        """.data(using: .utf8)!

        let issue = try JSONDecoder().decode(Issue.self, from: json)
        #expect(issue.order == 30)
        #expect(issue.phase == PhaseID("terminal"))
    }

    @Test func allSeveritiesDecodable() throws {
        for severity in IssueSeverity.allCases {
            let json = """
            {"id":"ISS-001","title":"Test","status":"open","severity":"\(severity.rawValue)",
             "components":[],"impact":"Test.","resolution":null,
             "location":[],"discoveredDate":"2026-03-10",
             "resolvedDate":null,"relatedTickets":[]}
            """.data(using: .utf8)!

            let issue = try JSONDecoder().decode(Issue.self, from: json)
            #expect(issue.severity == severity)
        }
    }
}
