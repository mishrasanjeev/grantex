package dev.grantex.gemma.example

import android.os.Bundle
import android.util.Log
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Main activity demonstrating the three-phase Grantex offline auth flow
 * for a Gemma 4 on-device agent on Android.
 *
 * Phase 1 (Online):  Fetch a consent bundle from the Grantex API and
 *                     store it in EncryptedSharedPreferences.
 *
 * Phase 2 (Offline): Load the bundle, verify the grant token using the
 *                     embedded JWKS snapshot, run the agent with scoped
 *                     tools, and log all actions to a hash-chained audit log.
 *
 * Phase 3 (Online):  Sync the accumulated audit entries to the Grantex cloud.
 *
 * In a production app you would wire these phases to UI buttons, a
 * WorkManager schedule, or a service. Here we run them sequentially
 * in onCreate for demonstration purposes.
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "GemmaGrantexExample"

        // ── Configuration ───────────────────────────────────────────
        // For local development with the Docker stack, the Android
        // emulator uses 10.0.2.2 to reach the host's localhost.
        private const val GRANTEX_BASE_URL = "http://10.0.2.2:3001"
        private const val GRANTEX_API_KEY = "sandbox-api-key-local"
        private const val AGENT_ID = "agent_gemma_android_01"
        private const val USER_ID = "user_alice"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        log("=" .repeat(54))
        log("  Grantex Gemma Agent — Android Example")
        log("=" .repeat(54))

        lifecycleScope.launch {
            try {
                runDemo()
            } catch (e: Exception) {
                log("ERROR: ${e.message}")
                Log.e(TAG, "Demo failed", e)
            }
        }
    }

    /**
     * Run the complete three-phase demo.
     */
    private suspend fun runDemo() {
        // ── Phase 1: Fetch consent bundle (online) ──────────────────
        log("")
        log("Phase 1: Fetching consent bundle (online)...")
        log("-".repeat(54))

        val bundle = withContext(Dispatchers.IO) {
            OfflineAuthManager.fetchAndStoreBundle(
                context = this@MainActivity,
                baseUrl = GRANTEX_BASE_URL,
                apiKey = GRANTEX_API_KEY,
                agentId = AGENT_ID,
                userId = USER_ID,
                scopes = listOf("sensors:read", "actuators:write", "alerts:send"),
                offlineTtl = "72h",
            )
        }

        log("Bundle created successfully!")
        log("  Bundle ID: ${bundle.bundleId}")
        log("  Expires:   ${bundle.offlineExpiresAt}")
        log("  Sync URL:  ${bundle.syncEndpoint}")

        // ── Phase 2: Run agent offline ──────────────────────────────
        log("")
        log("Phase 2: Running agent offline...")
        log("-".repeat(54))

        // Load the bundle from encrypted storage (no network needed)
        val storedBundle = OfflineAuthManager.loadBundle(this)
            ?: throw GrantexAuthException("No bundle found in storage")

        log("Bundle loaded from EncryptedSharedPreferences")

        // Initialize the audit logger with the Ed25519 signing key
        val auditLogger = AuditLogger(this)
        auditLogger.initialize(storedBundle.offlineAuditKey)
        log("Audit logger initialized")

        // Create the agent and verify the grant token offline
        val agent = GemmaAgent(
            bundle = storedBundle,
            auditLogger = auditLogger,
        )

        val grant = agent.verifyGrant()
        log("Grant verified offline:")
        log("  Agent:     ${grant.agentDid}")
        log("  Principal: ${grant.principalDid}")
        log("  Scopes:    ${grant.scopes.joinToString(", ")}")
        log("  Expires:   ${grant.expiresAt}")

        // ── Run the agent's tools ───────────────────────────────────
        log("")
        log("Simulating smart home agent actions...")
        log("-".repeat(54))

        // Tool 1: Read temperature sensor (sensors:read)
        val temp = agent.readSensor("temp_living_room")
        log("[read_sensor] temp_living_room → ${temp.message}")

        // Tool 2: Read humidity sensor (sensors:read)
        val humidity = agent.readSensor("humidity_bedroom")
        log("[read_sensor] humidity_bedroom → ${humidity.message}")

        // Tool 3: Adjust thermostat (actuators:write)
        val thermo = agent.controlActuator("thermostat_main", "set_temp:23")
        log("[control_actuator] thermostat_main → ${thermo.message}")

        // Tool 4: Send alert (alerts:send)
        val alert = agent.sendAlert("Humidity below threshold in bedroom")
        log("[send_alert] → ${alert.message}")

        // Tool 5: Unlock front door (actuators:write)
        val door = agent.controlActuator("door_lock_front", "unlock")
        log("[control_actuator] door_lock_front → ${door.message}")

        // ── Test scope violation ────────────────────────────────────
        log("")
        log("Testing scope violation...")
        log("-".repeat(54))

        // Tool 6: Attempt device deletion (admin:delete — NOT granted)
        val delete = agent.deleteDevice("thermostat_main")
        log("[delete_device] thermostat_main → ${delete.message}")

        // ── Verify audit log integrity ──────────────────────────────
        log("")
        log("Audit Log Verification")
        log("-".repeat(54))

        val verification = auditLogger.verifyChain()
        log("Total entries: ${verification.totalEntries}")
        log("Chain valid:   ${verification.valid}")
        if (!verification.valid && verification.brokenAt != null) {
            log("Broken at:     entry #${verification.brokenAt}")
        }

        // Print audit entries
        val entries = auditLogger.readEntries()
        log("")
        log("  #  | Action             | Result  | Hash (first 12)")
        log("  ---|--------------------|---------|-----------------")
        for (entry in entries) {
            val action = entry.action.padEnd(18)
            val result = entry.result.padEnd(7)
            val hashShort = entry.hash.take(12)
            log("  ${entry.seq.toString().padStart(2)} | $action | $result | $hashShort")
        }

        // ── Phase 3: Sync would happen here when online ────────────
        log("")
        log("Phase 3: Audit sync")
        log("-".repeat(54))
        log("In production, audit entries would be synced to:")
        log("  ${storedBundle.syncEndpoint}")
        log("Total entries to sync: ${entries.size}")
        log("")
        log("Demo complete!")
    }

    /**
     * Log a message to both Logcat and stdout (visible in adb logcat).
     */
    private fun log(message: String) {
        Log.i(TAG, message)
        println(message)
    }
}
