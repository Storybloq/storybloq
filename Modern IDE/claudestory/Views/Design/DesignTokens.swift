import SwiftUI
import Fabric

// MARK: - Theme Colors (aliases to Fabric)

enum StoryTheme {
    // MARK: Surfaces

    static let base = FabricColors.linen
    static let surface = FabricColors.canvas
    static let surfaceAlt = FabricColors.parchment
    static let surfaceTint = FabricColors.burlap
    static let border = FabricColors.connector

    // MARK: Text Hierarchy

    static let textPrimary = FabricColors.inkPrimary
    static let textSecondary = FabricColors.inkSecondary
    static let textTertiary = FabricColors.inkTertiary

    // MARK: Accent

    static let accent = FabricColors.indigo
    static let accentSoft = FabricAccent.indigo.fill
    static let accentGlow = FabricColors.indigo.opacity(0.20)

    // MARK: Status Colors

    static let ok = FabricColors.sage
    static let okSoft = FabricAccent.sage.fill
    static let warn = FabricColors.ochre
    static let warnSoft = FabricAccent.ochre.fill
    static let err = FabricColors.madder
    static let errSoft = FabricAccent.madder.fill
    static let mute = FabricColors.inkTertiary
    static let muteSoft = FabricColors.badgeFill
}

// MARK: - Spacing (aliases to Fabric)

enum StorySpacing {
    static let xxs: CGFloat = 2
    static let xs = FabricSpacing.xs
    static let sm = FabricSpacing.sm
    static let md = FabricSpacing.md
    static let lg = FabricSpacing.lg
    static let xl = FabricSpacing.xl
}

// MARK: - Date Formatting

enum StoryDate {
    /// Returns today's date as `YYYY-MM-DD` string per RULES.md.
    /// Creates a fresh formatter each call for thread safety.
    /// Called only on status transitions (infrequent), so no performance concern.
    static func today() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        return formatter.string(from: Date())
    }
}
