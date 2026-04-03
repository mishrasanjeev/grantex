package dev.grantex.gemma.example

import android.content.Context
import android.util.Log
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileWriter
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64

/**
 * Offline audit logger for Android with hash chain and Ed25519 signing.
 *
 * Every audit entry is:
 * 1. SHA-256 hashed with the previous entry's hash (forming an immutable chain)
 * 2. Signed with the Ed25519 private key from the consent bundle
 * 3. Appended to a JSONL file in the app's internal storage
 *
 * The hash chain ensures that if any historical entry is modified, the
 * chain breaks and the tampering is detectable. The Ed25519 signatures
 * prove that each entry was created by the authorized agent.
 *
 * Usage:
 * ```
 * val logger = AuditLogger(context)
 * logger.initialize(bundle.offlineAuditKey)
 *
 * val entry = logger.append(
 *     action = "read_sensor",
 *     agentDid = grant.agentDid,
 *     grantId = grant.grantId,
 *     scopes = grant.scopes,
 *     result = "success",
 *     metadata = mapOf("sensor_id" to "temp_01"),
 * )
 * ```
 */
class AuditLogger(private val context: Context) {

    companion object {
        private const val TAG = "AuditLogger"
        private const val LOG_DIR = "grantex"
        private const val LOG_FILE = "audit.jsonl"
        private const val GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000"
    }

    private var seq = 0
    private var prevHash = GENESIS_HASH
    private var privateKeyParams: Ed25519PrivateKeyParameters? = null
    private var logFile: File? = null

    /**
     * Initialize the audit logger with the Ed25519 signing key from the bundle.
     *
     * Must be called before [append]. Resumes the sequence number and
     * prev_hash from any existing log file on disk.
     *
     * @param auditKey The Ed25519 key pair from the consent bundle.
     */
    fun initialize(auditKey: OfflineAuditKey) {
        // Set up the log file in internal storage
        val dir = File(context.filesDir, LOG_DIR)
        dir.mkdirs()
        logFile = File(dir, LOG_FILE)

        // Parse the Ed25519 private key from PEM
        privateKeyParams = parseEd25519PrivateKey(auditKey.privateKey)

        // Resume state from existing log
        resumeFromDisk()

        Log.d(TAG, "Audit logger initialized (seq=$seq)")
    }

    /**
     * Append a new signed, hash-chained audit entry.
     *
     * @param action The action being audited (e.g., "read_sensor", "control_actuator").
     * @param agentDid The agent's DID from the verified grant.
     * @param grantId The grant ID from the verified grant.
     * @param scopes The grant's authorized scopes.
     * @param result The outcome: "success", "denied", or "error".
     * @param metadata Optional key-value pairs with additional context.
     * @return The signed [AuditEntry].
     */
    fun append(
        action: String,
        agentDid: String,
        grantId: String,
        scopes: List<String>,
        result: String,
        metadata: Map<String, Any> = emptyMap(),
    ): AuditEntry {
        requireNotNull(privateKeyParams) { "Call initialize() before append()" }
        requireNotNull(logFile) { "Call initialize() before append()" }

        seq++
        val timestamp = Instant.now().toString()

        // Build the entry (without hash and signature)
        val entryForHash = JSONObject().apply {
            put("seq", seq)
            put("timestamp", timestamp)
            put("action", action)
            put("agent_did", agentDid)
            put("grant_id", grantId)
            put("scopes", JSONArray(scopes))
            put("result", result)
            put("metadata", JSONObject(metadata))
            put("prev_hash", prevHash)
        }

        // Compute SHA-256 hash of the canonical JSON
        val hash = computeHash(entryForHash)

        // Sign the hash with Ed25519
        val signature = signData(hash)

        // Build the full entry JSON for storage
        val fullEntry = JSONObject().apply {
            put("seq", seq)
            put("timestamp", timestamp)
            put("action", action)
            put("agent_did", agentDid)
            put("grant_id", grantId)
            put("scopes", JSONArray(scopes))
            put("result", result)
            put("metadata", JSONObject(metadata))
            put("prev_hash", prevHash)
            put("hash", hash)
            put("signature", signature)
        }

        // Append to the JSONL file
        FileWriter(logFile!!, /* append = */ true).use { writer ->
            writer.write(fullEntry.toString() + "\n")
        }

        // Update chain state
        prevHash = hash

        val entry = AuditEntry(
            seq = seq,
            timestamp = timestamp,
            action = action,
            agentDid = agentDid,
            grantId = grantId,
            scopes = scopes,
            result = result,
            metadata = metadata,
            prevHash = entryForHash.getString("prev_hash"),
            hash = hash,
            signature = signature,
        )

        Log.d(TAG, "Audit #$seq: $action → $result (hash=${hash.take(12)}...)")
        return entry
    }

    /**
     * Read all audit entries from the log file.
     */
    fun readEntries(): List<AuditEntry> {
        val file = logFile ?: return emptyList()
        if (!file.exists()) return emptyList()

        return file.readLines()
            .filter { it.isNotBlank() }
            .map { line ->
                val json = JSONObject(line)
                AuditEntry(
                    seq = json.getInt("seq"),
                    timestamp = json.getString("timestamp"),
                    action = json.getString("action"),
                    agentDid = json.getString("agent_did"),
                    grantId = json.getString("grant_id"),
                    scopes = (0 until json.getJSONArray("scopes").length())
                        .map { json.getJSONArray("scopes").getString(it) },
                    result = json.getString("result"),
                    metadata = jsonObjectToMap(json.getJSONObject("metadata")),
                    prevHash = json.getString("prev_hash"),
                    hash = json.getString("hash"),
                    signature = json.getString("signature"),
                )
            }
    }

    /**
     * Verify the hash chain integrity of all stored entries.
     *
     * @return A [ChainVerificationResult] indicating validity.
     */
    fun verifyChain(): ChainVerificationResult {
        val entries = readEntries()
        if (entries.isEmpty()) {
            return ChainVerificationResult(valid = true, brokenAt = null, totalEntries = 0)
        }

        for (i in entries.indices) {
            val entry = entries[i]

            // Recompute the hash from the entry's content fields
            val entryForHash = JSONObject().apply {
                put("seq", entry.seq)
                put("timestamp", entry.timestamp)
                put("action", entry.action)
                put("agent_did", entry.agentDid)
                put("grant_id", entry.grantId)
                put("scopes", JSONArray(entry.scopes))
                put("result", entry.result)
                put("metadata", JSONObject(entry.metadata))
                put("prev_hash", entry.prevHash)
            }

            val expectedHash = computeHash(entryForHash)
            if (entry.hash != expectedHash) {
                return ChainVerificationResult(
                    valid = false,
                    brokenAt = i,
                    totalEntries = entries.size,
                )
            }

            // Check prev_hash linkage
            if (i > 0 && entry.prevHash != entries[i - 1].hash) {
                return ChainVerificationResult(
                    valid = false,
                    brokenAt = i,
                    totalEntries = entries.size,
                )
            }
        }

        return ChainVerificationResult(
            valid = true,
            brokenAt = null,
            totalEntries = entries.size,
        )
    }

    // ── Internal Helpers ────────────────────────────────────────────

    /**
     * Resume seq and prevHash from an existing log file on disk.
     */
    private fun resumeFromDisk() {
        val file = logFile ?: return
        if (!file.exists()) return

        val lines = file.readLines().filter { it.isNotBlank() }
        if (lines.isEmpty()) return

        try {
            val lastEntry = JSONObject(lines.last())
            seq = lastEntry.getInt("seq")
            prevHash = lastEntry.getString("hash")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to resume from existing log, starting fresh", e)
        }
    }

    /**
     * Compute SHA-256 hash of a JSONObject's canonical string representation.
     *
     * Uses sorted keys and no whitespace for deterministic hashing that
     * matches the Python and TypeScript implementations.
     */
    private fun computeHash(entry: JSONObject): String {
        // Build a canonical representation with sorted keys
        val canonical = JSONObject().apply {
            put("action", entry.getString("action"))
            put("agent_did", entry.getString("agent_did"))
            put("grant_id", entry.getString("grant_id"))
            put("metadata", entry.getJSONObject("metadata"))
            put("prev_hash", entry.getString("prev_hash"))
            put("result", entry.getString("result"))
            put("scopes", entry.getJSONArray("scopes"))
            put("seq", entry.getInt("seq"))
            put("timestamp", entry.getString("timestamp"))
        }

        val payload = canonical.toString()
        val digest = MessageDigest.getInstance("SHA-256")
        val hashBytes = digest.digest(payload.toByteArray(Charsets.UTF_8))
        return hashBytes.joinToString("") { "%02x".format(it) }
    }

    /**
     * Sign data with the Ed25519 private key and return base64url signature.
     */
    private fun signData(data: String): String {
        val signer = Ed25519Signer()
        signer.init(true, privateKeyParams)
        val dataBytes = data.toByteArray(Charsets.UTF_8)
        signer.update(dataBytes, 0, dataBytes.size)
        val sigBytes = signer.generateSignature()
        return Base64.getUrlEncoder().withoutPadding().encodeToString(sigBytes)
    }

    /**
     * Parse an Ed25519 private key from PEM format.
     */
    private fun parseEd25519PrivateKey(pem: String): Ed25519PrivateKeyParameters {
        // Strip PEM headers and decode base64
        val b64 = pem
            .replace("-----BEGIN PRIVATE KEY-----", "")
            .replace("-----END PRIVATE KEY-----", "")
            .replace("\\s".toRegex(), "")

        val decoded = Base64.getDecoder().decode(b64)

        // PKCS8 wrapping for Ed25519 has a 16-byte prefix before the 32-byte key
        // The raw key is the last 32 bytes of the decoded data
        val keyBytes = if (decoded.size > 32) {
            decoded.copyOfRange(decoded.size - 32, decoded.size)
        } else {
            decoded
        }

        return Ed25519PrivateKeyParameters(keyBytes, 0)
    }

    /**
     * Convert a JSONObject to a Map for the metadata field.
     */
    private fun jsonObjectToMap(json: JSONObject): Map<String, Any> {
        val map = mutableMapOf<String, Any>()
        json.keys().forEach { key ->
            map[key] = json.get(key)
        }
        return map
    }
}

// ── Data Classes ────────────────────────────────────────────────────

/**
 * A signed, hash-chained audit log entry.
 */
data class AuditEntry(
    val seq: Int,
    val timestamp: String,
    val action: String,
    val agentDid: String,
    val grantId: String,
    val scopes: List<String>,
    val result: String,
    val metadata: Map<String, Any>,
    val prevHash: String,
    val hash: String,
    val signature: String,
)

/**
 * Result of verifying the audit log hash chain.
 */
data class ChainVerificationResult(
    val valid: Boolean,
    val brokenAt: Int?,
    val totalEntries: Int,
)
