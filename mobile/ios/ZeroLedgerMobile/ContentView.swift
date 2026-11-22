import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var ledger: LedgerStore

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(ledger.status)
                        .font(.headline)

                    GroupBox("Engine") {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Version: \(ledger.engineVersionText)")
                            Text("Device: \(ledger.deviceId)")
                                .font(.caption)
                                .textSelection(.enabled)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    GroupBox("Workspaces") {
                        if ledger.workspaces.isEmpty {
                            Text("No workspaces yet")
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(ledger.workspaces, id: \.id) { workspace in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(workspace.name)
                                    Text(workspace.id)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }

                    if let balance = ledger.balance {
                        GroupBox("Trial balance") {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Debit: \(balance.totalDebitMinor)")
                                Text("Credit: \(balance.totalCreditMinor)")
                                Text(balance.balanced ? "Balanced" : "UNBALANCED")
                                    .fontWeight(.semibold)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
                .padding()
            }
            .navigationTitle("0ledger")
        }
        .task { ledger.bootstrap() }
    }
}
