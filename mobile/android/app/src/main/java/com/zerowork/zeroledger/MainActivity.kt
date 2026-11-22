package com.zerowork.zeroledger

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import uniffi.zeroledger_ffi.FfiStore
import uniffi.zeroledger_ffi.FfiTrialBalance
import uniffi.zeroledger_ffi.FfiWorkspace
import uniffi.zeroledger_ffi.engineVersion
import java.io.File

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val dbPath = File(filesDir, "0ledger.sqlite3").absolutePath
        setContent {
            MaterialTheme {
                EngineScreen(dbPath)
            }
        }
    }
}

@Composable
fun EngineScreen(dbPath: String) {
    var loading by remember { mutableStateOf(true) }
    var status by remember { mutableStateOf("Opening authoritative SQLite store…") }
    var version by remember { mutableStateOf("") }
    var device by remember { mutableStateOf("") }
    var workspaces by remember { mutableStateOf<List<FfiWorkspace>>(emptyList()) }
    var balance by remember { mutableStateOf<FfiTrialBalance?>(null) }

    LaunchedEffect(dbPath) {
        withContext(Dispatchers.IO) {
            try {
                version = engineVersion()
                val store = FfiStore.open(dbPath)
                device = store.deviceId()
                workspaces = store.listWorkspaces()
                workspaces.firstOrNull()?.let { workspace ->
                    balance = store.trialBalance(workspace.id)
                }
                status = "Engine ready"
            } catch (error: Exception) {
                status = "Engine error: ${error.message}"
            } finally {
                loading = false
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("0ledger", style = MaterialTheme.typography.headlineMedium)
        Text("Portable Rust financial engine", style = MaterialTheme.typography.bodyMedium)

        if (loading) {
            CircularProgressIndicator()
        }

        Card {
            Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(status, style = MaterialTheme.typography.titleMedium)
                Text("Engine version: $version", style = MaterialTheme.typography.bodySmall)
                Text("Device: $device", style = MaterialTheme.typography.bodySmall)
                Text("Workspaces: ${workspaces.size}", style = MaterialTheme.typography.bodySmall)
            }
        }

        workspaces.forEach { workspace ->
            Card {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(workspace.name, style = MaterialTheme.typography.titleMedium)
                    Text(workspace.id, style = MaterialTheme.typography.bodySmall)
                }
            }
        }

        balance?.let { tb ->
            Card {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Trial balance", style = MaterialTheme.typography.titleMedium)
                    Text("Debit: ${tb.totalDebitMinor}", style = MaterialTheme.typography.bodySmall)
                    Text("Credit: ${tb.totalCreditMinor}", style = MaterialTheme.typography.bodySmall)
                    Text(
                        if (tb.balanced) "Balanced" else "UNBALANCED",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
        }
    }
}
