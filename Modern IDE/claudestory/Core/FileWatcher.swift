import Foundation

// MARK: - FileWatching Protocol

/// Protocol for directory monitoring. Two conformances:
/// - `FileWatcher` (production) — FSEvents-based recursive monitor with debounce.
/// - `MockFileWatcher` (tests) — deterministic trigger via `simulateChange()`.
protocol FileWatching {
    var isWatching: Bool { get }
    var watchedURL: URL? { get }
    func start(watching url: URL, onChange: @escaping () -> Void)
    func stop()
}

// MARK: - FileWatcher

/// Monitors a directory tree for filesystem changes using FSEvents.
///
/// Debounces rapid changes and calls `onChange` once per burst. Designed to watch
/// `.story/` and trigger ProjectLoader reload.
///
/// **Lifecycle:** Owner must call `stop()` before releasing. If not called, the
/// retained reference prevents deallocation (leak-not-crash). `deinit` performs
/// cleanup as a safety net.
///
/// **Retain cycle warning:** The `onChange` closure is stored. If the caller holds
/// a strong reference to FileWatcher, use `[weak self]` in the closure.
final class FileWatcher: FileWatching {

    // MARK: - Public Properties

    let debounceInterval: TimeInterval
    private(set) var isWatching: Bool = false
    private(set) var watchedURL: URL?

    // MARK: - Private State

    /// Marked nonisolated(unsafe) so nonisolated deinit can access for cleanup.
    nonisolated(unsafe) private var streamRef: FSEventStreamRef?

    /// Retained reference to self, held by the FSEvents stream context.
    /// Balanced by release() in stop()/deinit. nonisolated(unsafe) for deinit access.
    nonisolated(unsafe) private var retainedSelf: Unmanaged<FileWatcher>?

    private let fsQueue = DispatchQueue(label: "com.story.filewatcher", qos: .utility)
    private var debounceWorkItem: DispatchWorkItem?
    private var onChange: (() -> Void)?

    // MARK: - Init

    /// - Parameter debounceInterval: Seconds to wait after the last FSEvent before
    ///   calling `onChange`. Default 0.25s. Pass a smaller value in tests.
    init(debounceInterval: TimeInterval = 0.25) {
        self.debounceInterval = debounceInterval
    }

    deinit {
        // Full teardown: stream first (prevents further callbacks), drain queue, then release.
        if let stream = streamRef {
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
            // Drain any in-flight callback already dispatched to fsQueue.
            fsQueue.sync {}
        }
        retainedSelf?.release()
    }

    // MARK: - Public API

    /// Begin watching a directory recursively for filesystem changes.
    ///
    /// Calling `start` while already watching stops the previous watcher first.
    ///
    /// - Parameters:
    ///   - url: The directory to monitor (typically `.story/`).
    ///   - onChange: Called on MainActor after the debounce interval elapses with no
    ///     further events. Use `[weak self]` if the caller also holds FileWatcher.
    func start(watching url: URL, onChange: @escaping () -> Void) {
        stop()

        self.onChange = onChange
        self.watchedURL = url

        // Retain self so the C callback pointer is valid while the stream exists.
        let retained = Unmanaged.passRetained(self)
        self.retainedSelf = retained

        var fsContext = FSEventStreamContext(
            version: 0,
            info: retained.toOpaque(),
            retain: nil,
            release: nil,
            copyDescription: nil
        )

        let pathsToWatch = [url.path as CFString] as CFArray

        guard let stream = FSEventStreamCreate(
            kCFAllocatorDefault,
            FileWatcher.fsEventCallback,
            &fsContext,
            pathsToWatch,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            0, // latency: 0 — immediate delivery; we debounce ourselves
            UInt32(
                kFSEventStreamCreateFlagUseCFTypes |
                kFSEventStreamCreateFlagFileEvents |
                kFSEventStreamCreateFlagNoDefer
            )
        ) else {
            // Stream creation failed — release retained ref and silently degrade.
            retained.release()
            self.retainedSelf = nil
            return
        }

        streamRef = stream
        FSEventStreamSetDispatchQueue(stream, fsQueue)

        guard FSEventStreamStart(stream) else {
            // Start failed — tear down.
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
            streamRef = nil
            retained.release()
            self.retainedSelf = nil
            return
        }

        isWatching = true
    }

    /// Stop watching. Safe to call multiple times.
    func stop() {
        debounceWorkItem?.cancel()
        debounceWorkItem = nil
        onChange = nil
        watchedURL = nil

        if let stream = streamRef {
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
            streamRef = nil

            // Drain any in-flight callback already dispatched to fsQueue.
            // After Invalidate, no new callbacks are dispatched, so this
            // completes quickly. Safe to call from MainActor — fsQueue is
            // a separate serial queue that does minimal work.
            fsQueue.sync {}
        }

        if let retained = retainedSelf {
            retained.release()
            retainedSelf = nil
        }

        isWatching = false
    }

    // MARK: - FSEvents C Callback

    /// Static C function pointer for FSEventStreamCreate.
    /// Fires on fsQueue (background). Hops to MainActor for debounce.
    private static let fsEventCallback: FSEventStreamCallback = {
        (_, clientCallbackInfo, _, _, _, _) in

        guard let info = clientCallbackInfo else { return }
        let watcher = Unmanaged<FileWatcher>.fromOpaque(info).takeUnretainedValue()

        // Hop to MainActor for debounce scheduling.
        Task { @MainActor in
            watcher.scheduleDebouncedChange()
        }
    }

    // MARK: - Debounce

    /// Cancels any pending debounce and schedules a new one.
    /// Called on MainActor — no race between cancel and execute.
    private func scheduleDebouncedChange() {
        guard isWatching else { return }
        debounceWorkItem?.cancel()

        let item = DispatchWorkItem { [weak self] in
            self?.onChange?()
        }
        debounceWorkItem = item

        DispatchQueue.main.asyncAfter(deadline: .now() + debounceInterval, execute: item)
    }
}
