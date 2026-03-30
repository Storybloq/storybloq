import Testing
import Foundation
@testable import Modern_IDE

struct TicketModelTests {
    @Test func decodesWithParentTicket() throws {
        let json = """
        {"id":"T-029","title":"Window config","type":"chore","status":"open",
         "phase":"viewer","order":20,"description":"Configure window.",
         "createdDate":"2026-03-11","completedDate":null,
         "blockedBy":[],"parentTicket":"T-008"}
        """.data(using: .utf8)!

        let ticket = try JSONDecoder().decode(Ticket.self, from: json)
        #expect(ticket.id == "T-029")
        #expect(ticket.parentTicket == "T-008")
        #expect(ticket.completedDate == nil)
        #expect(ticket.type == .chore)
        #expect(ticket.phase == .viewer)
    }

    @Test func decodesWithAbsentParentTicket() throws {
        let json = """
        {"id":"T-001","title":"Spec","type":"task","status":"complete",
         "phase":"dogfood","order":10,"description":"Write spec.",
         "createdDate":"2026-03-10","completedDate":"2026-03-10",
         "blockedBy":[]}
        """.data(using: .utf8)!

        let ticket = try JSONDecoder().decode(Ticket.self, from: json)
        #expect(ticket.parentTicket == nil)
        #expect(ticket.completedDate == "2026-03-10")
        #expect(ticket.status == .complete)
    }

    @Test func decodesWithNullParentTicket() throws {
        let json = """
        {"id":"T-044","title":"ViewModel","type":"task","status":"open",
         "phase":"viewer","order":170,"description":"Create VM.",
         "createdDate":"2026-03-11","completedDate":null,
         "blockedBy":["T-035","T-036"],"parentTicket":null}
        """.data(using: .utf8)!

        let ticket = try JSONDecoder().decode(Ticket.self, from: json)
        #expect(ticket.parentTicket == nil)
        #expect(ticket.blockedBy == ["T-035", "T-036"])
    }

    @Test func roundTripPreservesAbsentParentTicket() throws {
        let json = """
        {"id":"T-001","title":"Spec","type":"task","status":"complete",
         "phase":"dogfood","order":10,"description":"Write spec.",
         "createdDate":"2026-03-10","completedDate":"2026-03-10",
         "blockedBy":[]}
        """.data(using: .utf8)!

        let ticket = try JSONDecoder().decode(Ticket.self, from: json)
        let encoded = try JSONEncoder().encode(ticket)
        let encodedString = String(data: encoded, encoding: .utf8)!
        // parentTicket key should NOT be emitted when nil
        #expect(!encodedString.contains("parentTicket"))
    }

    @Test func roundTripPreservesParentTicket() throws {
        let json = """
        {"id":"T-030","title":"Model","type":"task","status":"open",
         "phase":"viewer","order":30,"description":"Build model.",
         "createdDate":"2026-03-11","completedDate":null,
         "blockedBy":[],"parentTicket":"T-009"}
        """.data(using: .utf8)!

        let ticket = try JSONDecoder().decode(Ticket.self, from: json)
        let encoded = try JSONEncoder().encode(ticket)
        let decoded = try JSONDecoder().decode(Ticket.self, from: encoded)
        #expect(decoded.parentTicket == "T-009")
        #expect(ticket == decoded)
    }

    @Test func unknownPhaseIDDecodesWithoutCrash() throws {
        let json = """
        {"id":"T-100","title":"Future","type":"task","status":"open",
         "phase":"alpha","order":10,"description":"Unknown phase.",
         "createdDate":"2026-03-11","completedDate":null,
         "blockedBy":[]}
        """.data(using: .utf8)!

        let ticket = try JSONDecoder().decode(Ticket.self, from: json)
        #expect(ticket.phase?.rawValue == "alpha")
        #expect(ticket.phase != .dogfood)
    }

    @Test func decodesTicketWithNullPhase() throws {
        let json = """
        {"id":"T-200","title":"Unphased","type":"task","status":"open",
         "phase":null,"order":10,"description":"No phase.",
         "createdDate":"2026-03-18","completedDate":null,"blockedBy":[]}
        """.data(using: .utf8)!

        let ticket = try JSONDecoder().decode(Ticket.self, from: json)
        #expect(ticket.phase == nil)
    }

    @Test func decodesTicketWithoutPhaseKey() throws {
        let json = """
        {"id":"T-201","title":"No phase key","type":"task","status":"open",
         "order":10,"description":"Missing phase key.",
         "createdDate":"2026-03-18","completedDate":null,"blockedBy":[]}
        """.data(using: .utf8)!

        let ticket = try JSONDecoder().decode(Ticket.self, from: json)
        #expect(ticket.phase == nil)
    }

    @Test func allTicketTypesDecodable() throws {
        for ticketType in TicketType.allCases {
            let json = """
            {"id":"T-001","title":"Test","type":"\(ticketType.rawValue)","status":"open",
             "phase":"dogfood","order":10,"description":"Test.",
             "createdDate":"2026-03-10","completedDate":null,"blockedBy":[]}
            """.data(using: .utf8)!

            let ticket = try JSONDecoder().decode(Ticket.self, from: json)
            #expect(ticket.type == ticketType)
        }
    }

    @Test func allStatusesDecodable() throws {
        for status in TicketStatus.allCases {
            let json = """
            {"id":"T-001","title":"Test","type":"task","status":"\(status.rawValue)",
             "phase":"dogfood","order":10,"description":"Test.",
             "createdDate":"2026-03-10","completedDate":null,"blockedBy":[]}
            """.data(using: .utf8)!

            let ticket = try JSONDecoder().decode(Ticket.self, from: json)
            #expect(ticket.status == status)
        }
    }
}
