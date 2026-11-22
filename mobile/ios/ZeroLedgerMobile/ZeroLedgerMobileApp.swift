import SwiftUI

@main
struct ZeroLedgerMobileApp: App {
    @StateObject private var ledger = LedgerStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(ledger)
        }
    }
}
