import Testing
import Foundation
@testable import Modern_IDE

struct ConfigModelTests {
    @Test func decodesValidConfig() throws {
        let json = """
        {
          "version": 2,
          "project": "claudestory",
          "type": "macapp",
          "language": "swift",
          "features": {
            "tickets": true,
            "issues": true,
            "handovers": true,
            "roadmap": true,
            "reviews": true
          }
        }
        """.data(using: .utf8)!

        let config = try JSONDecoder().decode(Config.self, from: json)
        #expect(config.version == 2)
        #expect(config.project == "claudestory")
        #expect(config.type == "macapp")
        #expect(config.language == "swift")
        #expect(config.features.tickets == true)
        #expect(config.features.reviews == true)
    }

    @Test func roundTrips() throws {
        let json = """
        {"version":2,"project":"claudestory","type":"macapp","language":"swift","features":{"tickets":true,"issues":true,"handovers":true,"roadmap":true,"reviews":true}}
        """.data(using: .utf8)!

        let original = try JSONDecoder().decode(Config.self, from: json)
        let encoded = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(Config.self, from: encoded)
        #expect(original == decoded)
    }

    @Test func failsOnMissingFeatures() {
        let json = """
        {"version":2,"project":"claudestory","type":"macapp","language":"swift"}
        """.data(using: .utf8)!

        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder().decode(Config.self, from: json)
        }
    }

    @Test func validateRejectsVersionZero() throws {
        let json = """
        {"version":0,"project":"claudestory","type":"macapp","language":"swift","features":{"tickets":true,"issues":true,"handovers":true,"roadmap":true,"reviews":true}}
        """.data(using: .utf8)!

        let config = try JSONDecoder().decode(Config.self, from: json)
        #expect(throws: ConfigError.self) {
            try config.validate()
        }
    }

    @Test func validateRejectsEmptyProject() throws {
        let json = """
        {"version":2,"project":"","type":"macapp","language":"swift","features":{"tickets":true,"issues":true,"handovers":true,"roadmap":true,"reviews":true}}
        """.data(using: .utf8)!

        let config = try JSONDecoder().decode(Config.self, from: json)
        #expect(throws: ConfigError.self) {
            try config.validate()
        }
    }

    @Test func validateRejectsEmptyLanguage() throws {
        let json = """
        {"version":2,"project":"test","type":"macapp","language":"","features":{"tickets":true,"issues":true,"handovers":true,"roadmap":true,"reviews":true}}
        """.data(using: .utf8)!

        let config = try JSONDecoder().decode(Config.self, from: json)
        #expect(throws: ConfigError.self) {
            try config.validate()
        }
    }

    @Test func validateRejectsEmptyType() throws {
        let json = """
        {"version":2,"project":"test","type":"","language":"swift","features":{"tickets":true,"issues":true,"handovers":true,"roadmap":true,"reviews":true}}
        """.data(using: .utf8)!

        let config = try JSONDecoder().decode(Config.self, from: json)
        #expect(throws: ConfigError.self) {
            try config.validate()
        }
    }
}
