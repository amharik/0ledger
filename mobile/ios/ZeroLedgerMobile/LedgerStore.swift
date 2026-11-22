import Foundation

@MainActor
final class LedgerStore: ObservableObject {
    @Published var status = "Opening authoritative SQLite store…"
    @Published var engineVersionText = ""
    @Published var deviceId = ""
    @Published var workspaces: [FfiWorkspace] = []
    @Published var balance: FfiTrialBalance?

    private var store: FfiStore?
    private var started = false

    var databasePath: String {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("0ledger.sqlite3").path
    }

    func bootstrap() {
        guard !started else { return }
        started = true
        Task {
            do {
                engineVersionText = engineVersion()
                let opened = try FfiStore.open(path: databasePath)
                store = opened
                deviceId = try opened.deviceId()
                workspaces = try opened.listWorkspaces()
                if let first = workspaces.first {
                    balance = try opened.trialBalance(workspaceId: first.id)
                }
                status = "Engine ready"
            } catch {
                status = "Engine error: \(error)"
            }
        }
    }
}
