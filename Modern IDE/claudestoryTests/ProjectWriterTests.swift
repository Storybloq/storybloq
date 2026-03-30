import Testing
import Foundation
@testable import Modern_IDE

// MARK: - Project Writer Tests

struct ProjectWriterTests {
    private let writer = ProjectLoader()

    // MARK: - Ticket Round-Trip

    @Test func writeTicketRoundTrips() throws {
        let ticket = Ticket(
            id: "T-100", title: "Round-trip test", type: .feature, status: .inprogress,
            phase: .detail, order: 42, description: "Test writing and reading back.",
            createdDate: "2026-03-10", completedDate: nil,
            blockedBy: ["T-050", "T-051"], parentTicket: "T-010"
        )

        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        let ticketsDir = tempDir.appendingPathComponent(".story/tickets")
        try FileManager.default.createDirectory(at: ticketsDir, withIntermediateDirectories: true)

        defer { try? FileManager.default.removeItem(at: tempDir) }

        try writer.writeTicket(ticket, to: tempDir)

        let fileURL = ticketsDir.appendingPathComponent("T-100.json")
        let data = try Data(contentsOf: fileURL)
        let decoded = try JSONDecoder().decode(Ticket.self, from: data)

        #expect(decoded.id == ticket.id)
        #expect(decoded.title == ticket.title)
        #expect(decoded.type == ticket.type)
        #expect(decoded.status == ticket.status)
        #expect(decoded.phase == ticket.phase)
        #expect(decoded.order == ticket.order)
        #expect(decoded.description == ticket.description)
        #expect(decoded.createdDate == ticket.createdDate)
        #expect(decoded.completedDate == ticket.completedDate)
        #expect(decoded.blockedBy == ticket.blockedBy)
        #expect(decoded.parentTicket == ticket.parentTicket)
    }

    @Test func writeTicketCompletedDateNull() throws {
        let ticket = Ticket(
            id: "T-101", title: "Null date", type: .task, status: .open,
            phase: .viewer, order: 10, description: "",
            createdDate: "2026-03-10", completedDate: nil
        )

        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        let ticketsDir = tempDir.appendingPathComponent(".story/tickets")
        try FileManager.default.createDirectory(at: ticketsDir, withIntermediateDirectories: true)

        defer { try? FileManager.default.removeItem(at: tempDir) }

        try writer.writeTicket(ticket, to: tempDir)

        let fileURL = ticketsDir.appendingPathComponent("T-101.json")
        let raw = try String(contentsOf: fileURL, encoding: .utf8)

        // completedDate should be present as null (not omitted)
        #expect(raw.contains("\"completedDate\" : null"))
    }

    @Test func writeTicketParentTicketOmittedWhenNil() throws {
        let ticket = Ticket(
            id: "T-102", title: "No parent", type: .task, status: .open,
            phase: .viewer, order: 10, description: "",
            createdDate: "2026-03-10"
        )

        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        let ticketsDir = tempDir.appendingPathComponent(".story/tickets")
        try FileManager.default.createDirectory(at: ticketsDir, withIntermediateDirectories: true)

        defer { try? FileManager.default.removeItem(at: tempDir) }

        try writer.writeTicket(ticket, to: tempDir)

        let fileURL = ticketsDir.appendingPathComponent("T-102.json")
        let raw = try String(contentsOf: fileURL, encoding: .utf8)

        // parentTicket should be omitted entirely when nil
        #expect(!raw.contains("parentTicket"))
    }

    @Test func writeTicketParentTicketPresentWhenSet() throws {
        let ticket = Ticket(
            id: "T-103", title: "Has parent", type: .task, status: .open,
            phase: .viewer, order: 10, description: "",
            createdDate: "2026-03-10", parentTicket: "T-010"
        )

        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        let ticketsDir = tempDir.appendingPathComponent(".story/tickets")
        try FileManager.default.createDirectory(at: ticketsDir, withIntermediateDirectories: true)

        defer { try? FileManager.default.removeItem(at: tempDir) }

        try writer.writeTicket(ticket, to: tempDir)

        let fileURL = ticketsDir.appendingPathComponent("T-103.json")
        let raw = try String(contentsOf: fileURL, encoding: .utf8)

        #expect(raw.contains("\"parentTicket\" : \"T-010\""))
    }

    // MARK: - Issue Round-Trip

    @Test func writeIssueRoundTrips() throws {
        let issue = Issue(
            id: "ISS-100", title: "Round-trip issue", status: .open, severity: .critical,
            components: ["safety", "i18n"], impact: "Breaks French",
            resolution: nil, location: ["lexical.ts:41"],
            discoveredDate: "2026-03-10", resolvedDate: nil,
            relatedTickets: ["T-027"]
        )

        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        let issuesDir = tempDir.appendingPathComponent(".story/issues")
        try FileManager.default.createDirectory(at: issuesDir, withIntermediateDirectories: true)

        defer { try? FileManager.default.removeItem(at: tempDir) }

        try writer.writeIssue(issue, to: tempDir)

        let fileURL = issuesDir.appendingPathComponent("ISS-100.json")
        let data = try Data(contentsOf: fileURL)
        let decoded = try JSONDecoder().decode(Issue.self, from: data)

        #expect(decoded.id == issue.id)
        #expect(decoded.title == issue.title)
        #expect(decoded.status == issue.status)
        #expect(decoded.severity == issue.severity)
        #expect(decoded.components == issue.components)
        #expect(decoded.impact == issue.impact)
        #expect(decoded.resolution == issue.resolution)
        #expect(decoded.location == issue.location)
        #expect(decoded.discoveredDate == issue.discoveredDate)
        #expect(decoded.resolvedDate == issue.resolvedDate)
        #expect(decoded.relatedTickets == issue.relatedTickets)
    }

    @Test func writeIssueResolvedRoundTrips() throws {
        let issue = Issue(
            id: "ISS-101", title: "Resolved issue", status: .resolved, severity: .low,
            components: [], impact: "Minor", resolution: "Fixed it",
            location: [], discoveredDate: "2026-03-08", resolvedDate: "2026-03-10",
            relatedTickets: []
        )

        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        let issuesDir = tempDir.appendingPathComponent(".story/issues")
        try FileManager.default.createDirectory(at: issuesDir, withIntermediateDirectories: true)

        defer { try? FileManager.default.removeItem(at: tempDir) }

        try writer.writeIssue(issue, to: tempDir)

        let fileURL = issuesDir.appendingPathComponent("ISS-101.json")
        let data = try Data(contentsOf: fileURL)
        let decoded = try JSONDecoder().decode(Issue.self, from: data)

        #expect(decoded.resolution == "Fixed it")
        #expect(decoded.resolvedDate == "2026-03-10")
    }

    // MARK: - Error Path

    @Test func writeTicketToInvalidPathThrows() {
        let ticket = Ticket(
            id: "T-999", title: "Will fail", type: .task, status: .open,
            phase: .viewer, order: 10, description: "",
            createdDate: "2026-03-10"
        )

        let invalidRoot = URL(fileURLWithPath: "/nonexistent/path/that/does/not/exist")

        #expect(throws: (any Error).self) {
            try writer.writeTicket(ticket, to: invalidRoot)
        }
    }

    @Test func writeIssueToInvalidPathThrows() {
        let issue = Issue(
            id: "ISS-999", title: "Will fail", status: .open, severity: .low,
            components: [], impact: "", resolution: nil,
            location: [], discoveredDate: "2026-03-10", resolvedDate: nil,
            relatedTickets: []
        )

        let invalidRoot = URL(fileURLWithPath: "/nonexistent/path/that/does/not/exist")

        #expect(throws: (any Error).self) {
            try writer.writeIssue(issue, to: invalidRoot)
        }
    }

    // MARK: - JSON Output Format

    @Test func writeProducesPrettyPrintedSortedJSON() throws {
        let ticket = Ticket(
            id: "T-104", title: "Pretty print", type: .task, status: .open,
            phase: .viewer, order: 10, description: "",
            createdDate: "2026-03-10"
        )

        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        let ticketsDir = tempDir.appendingPathComponent(".story/tickets")
        try FileManager.default.createDirectory(at: ticketsDir, withIntermediateDirectories: true)

        defer { try? FileManager.default.removeItem(at: tempDir) }

        try writer.writeTicket(ticket, to: tempDir)

        let fileURL = ticketsDir.appendingPathComponent("T-104.json")
        let raw = try String(contentsOf: fileURL, encoding: .utf8)

        // Verify it's multi-line (pretty printed)
        #expect(raw.contains("\n"))

        // Verify keys are sorted (blockedBy comes before completedDate)
        let blockedByRange = raw.range(of: "blockedBy")!
        let completedDateRange = raw.range(of: "completedDate")!
        #expect(blockedByRange.lowerBound < completedDateRange.lowerBound)
    }
}
