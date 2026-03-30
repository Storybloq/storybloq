import Foundation

// MARK: - Project Detector

/// Detects project language and type from filesystem markers at the project root.
/// Used to pre-fill the setup form when initializing `.story/` for a new project.
enum ProjectDetector {

    struct Detection: Equatable, Sendable {
        let language: String
        let type: String
    }

    /// Checks for common project marker files at `url` (root only, no recursion).
    /// First match wins. Falls back to unknown/generic.
    static func detect(at url: URL) -> Detection {
        let fm = FileManager.default

        func exists(_ name: String) -> Bool {
            fm.fileExists(atPath: url.appendingPathComponent(name).path)
        }

        func anyMatch(_ pattern: String) -> Bool {
            guard let contents = try? fm.contentsOfDirectory(atPath: url.path) else { return false }
            return contents.contains { $0.hasSuffix(pattern) }
        }

        // Swift / macOS
        if exists("Package.swift") || anyMatch(".xcodeproj") {
            return found(Detection(language: "swift", type: "macapp"), marker: "Swift", at: url)
        }

        // Node / TypeScript / JavaScript
        if exists("package.json") {
            return found(Detection(language: "typescript", type: "webapp"), marker: "package.json", at: url)
        }

        // Rust
        if exists("Cargo.toml") {
            return found(Detection(language: "rust", type: "cli"), marker: "Cargo.toml", at: url)
        }

        // Go
        if exists("go.mod") {
            return found(Detection(language: "go", type: "cli"), marker: "go.mod", at: url)
        }

        // Python
        if exists("pyproject.toml") || exists("setup.py") || exists("requirements.txt") {
            return found(Detection(language: "python", type: "cli"), marker: "Python", at: url)
        }

        // Java / Kotlin / Android
        if exists("build.gradle.kts") || exists("build.gradle") || exists("pom.xml") {
            return found(Detection(language: "kotlin", type: "api"), marker: "Gradle/Maven", at: url)
        }

        // C# / .NET
        if anyMatch(".csproj") || anyMatch(".sln") {
            return found(Detection(language: "csharp", type: "api"), marker: ".NET", at: url)
        }

        // Ruby
        if exists("Gemfile") {
            return found(Detection(language: "ruby", type: "webapp"), marker: "Gemfile", at: url)
        }

        // Flutter / Dart
        if exists("pubspec.yaml") {
            return found(Detection(language: "dart", type: "mobile"), marker: "pubspec.yaml", at: url)
        }

        // C / C++
        if exists("CMakeLists.txt") {
            return found(Detection(language: "cpp", type: "cli"), marker: "CMakeLists.txt", at: url)
        }

        Log.debug("no markers found, fallback to unknown/generic", tag: "ProjectDetector")
        return Detection(language: "unknown", type: "generic")
    }

    private static func found(_ detection: Detection, marker: String, at url: URL) -> Detection {
        Log.info("detected \(detection.language)/\(detection.type) via \(marker) at \(url.lastPathComponent)", tag: "ProjectDetector")
        return detection
    }
}
