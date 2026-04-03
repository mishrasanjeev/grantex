package dev.grantex.gemma.example

import android.content.Context
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Manages the consent bundle lifecycle on Android.
 *
 * The consent bundle contains everything needed for offline authorization:
 * - A signed JWT grant token with embedded scopes
 * - A JWKS snapshot for verifying the JWT signature without network
 * - An Ed25519 key pair for signing tamper-evident audit entries
 * - Sync metadata (endpoint URL, bundle ID, expiry)
 *
 * The bundle is stored in [EncryptedSharedPreferences], which uses the
 * Android Keystore for key management. This means the bundle is encrypted
 * at rest and tied to the device — it cannot be extracted and replayed
 * on another device.
 */
object OfflineAuthManager {

    private const val TAG = "OfflineAuthManager"
    private const val PREFS_FILE = "grantex_bundle_prefs"
    private const val KEY_BUNDLE_JSON = "consent_bundle"

    /** The HTTP client used for online operations (bundle fetch, sync). */
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    // ── Encrypted Storage ───────────────────────────────────────────

    /**
     * Get the EncryptedSharedPreferences instance backed by Android Keystore.
     *
     * The master key is stored in the hardware-backed Keystore (TEE/StrongBox
     * on supported devices), so even root access cannot extract the key.
     */
    private fun getEncryptedPrefs(context: Context) =
        EncryptedSharedPreferences.create(
            context,
            PREFS_FILE,
            MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )

    // ── Phase 1: Online Bundle Fetch ────────────────────────────────

    /**
     * Fetch a consent bundle from the Grantex API and store it encrypted.
     *
     * This requires network connectivity. Call this once during initial
     * setup or when the existing bundle is about to expire.
     *
     * @param context Android context for accessing EncryptedSharedPreferences.
     * @param baseUrl Grantex API base URL (e.g., "http://10.0.2.2:3001").
     * @param apiKey Developer API key.
     * @param agentId The agent's identifier or DID.
     * @param userId The principal (user) identifier.
     * @param scopes List of scopes to authorize.
     * @param offlineTtl How long the bundle is valid offline (default "72h").
     * @return The parsed [ConsentBundle].
     */
    suspend fun fetchAndStoreBundle(
        context: Context,
        baseUrl: String,
        apiKey: String,
        agentId: String,
        userId: String,
        scopes: List<String>,
        offlineTtl: String = "72h",
    ): ConsentBundle {
        Log.d(TAG, "Fetching consent bundle from $baseUrl...")

        // Build the request body
        val body = JSONObject().apply {
            put("agentId", agentId)
            put("userId", userId)
            put("scopes", JSONArray(scopes))
            put("offlineTtl", offlineTtl)
        }

        // POST /v1/consent-bundles
        val request = Request.Builder()
            .url("$baseUrl/v1/consent-bundles")
            .addHeader("Authorization", "Bearer $apiKey")
            .addHeader("Content-Type", "application/json")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()

        val response = httpClient.newCall(request).execute()

        if (!response.isSuccessful) {
            val errorBody = response.body?.string() ?: "unknown error"
            throw GrantexAuthException(
                "Failed to create consent bundle: HTTP ${response.code} — $errorBody"
            )
        }

        val responseJson = JSONObject(response.body!!.string())

        // Parse the response into a ConsentBundle
        val bundle = parseBundle(responseJson)

        // Store encrypted in SharedPreferences
        storeBundle(context, responseJson.toString())

        Log.d(TAG, "Bundle stored (ID: ${bundle.bundleId})")
        return bundle
    }

    // ── Bundle Storage ──────────────────────────────────────────────

    /**
     * Store the raw bundle JSON in EncryptedSharedPreferences.
     */
    private fun storeBundle(context: Context, bundleJson: String) {
        getEncryptedPrefs(context)
            .edit()
            .putString(KEY_BUNDLE_JSON, bundleJson)
            .apply()
    }

    /**
     * Load and decrypt the consent bundle from local storage.
     *
     * No network call is made. Returns null if no bundle is stored.
     */
    fun loadBundle(context: Context): ConsentBundle? {
        val json = getEncryptedPrefs(context)
            .getString(KEY_BUNDLE_JSON, null)
            ?: return null

        return try {
            parseBundle(JSONObject(json))
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse stored bundle", e)
            null
        }
    }

    /**
     * Check whether a stored bundle exists and is not expired.
     */
    fun hasValidBundle(context: Context): Boolean {
        val bundle = loadBundle(context) ?: return false
        return !bundle.isExpired()
    }

    /**
     * Delete the stored bundle (e.g., after grant revocation).
     */
    fun clearBundle(context: Context) {
        getEncryptedPrefs(context)
            .edit()
            .remove(KEY_BUNDLE_JSON)
            .apply()
        Log.d(TAG, "Bundle cleared")
    }

    // ── Parsing ─────────────────────────────────────────────────────

    /**
     * Parse a JSONObject into a [ConsentBundle].
     */
    private fun parseBundle(json: JSONObject): ConsentBundle {
        val jwksJson = json.getJSONObject("jwksSnapshot")
        val keysArray = jwksJson.getJSONArray("keys")
        val keys = (0 until keysArray.length()).map { keysArray.getJSONObject(it) }

        val auditKeyJson = json.getJSONObject("offlineAuditKey")

        return ConsentBundle(
            bundleId = json.getString("bundleId"),
            grantToken = json.getString("grantToken"),
            jwksSnapshot = JWKSSnapshot(
                keys = keys,
                fetchedAt = jwksJson.getString("fetchedAt"),
                validUntil = jwksJson.getString("validUntil"),
            ),
            offlineAuditKey = OfflineAuditKey(
                publicKey = auditKeyJson.getString("publicKey"),
                privateKey = auditKeyJson.getString("privateKey"),
                algorithm = auditKeyJson.getString("algorithm"),
            ),
            checkpointAt = json.getLong("checkpointAt"),
            syncEndpoint = json.getString("syncEndpoint"),
            offlineExpiresAt = json.getString("offlineExpiresAt"),
        )
    }
}

// ── Data Classes ────────────────────────────────────────────────────

/**
 * A consent bundle containing everything needed for offline authorization.
 */
data class ConsentBundle(
    val bundleId: String,
    val grantToken: String,
    val jwksSnapshot: JWKSSnapshot,
    val offlineAuditKey: OfflineAuditKey,
    val checkpointAt: Long,
    val syncEndpoint: String,
    val offlineExpiresAt: String,
) {
    /** Check if the bundle's offline period has expired. */
    fun isExpired(): Boolean {
        return try {
            val expiresAt = java.time.Instant.parse(offlineExpiresAt)
            java.time.Instant.now().isAfter(expiresAt)
        } catch (_: Exception) {
            true // If we can't parse, assume expired
        }
    }
}

/**
 * Snapshot of the Grantex server's JWKS keys for offline JWT verification.
 */
data class JWKSSnapshot(
    val keys: List<JSONObject>,
    val fetchedAt: String,
    val validUntil: String,
)

/**
 * Ed25519 key pair for signing offline audit entries.
 */
data class OfflineAuditKey(
    val publicKey: String,
    val privateKey: String,
    val algorithm: String,
)

// ── Exceptions ──────────────────────────────────────────────────────

class GrantexAuthException(message: String) : Exception(message)
class ScopeViolationException(message: String) : Exception(message)
class TokenExpiredException(message: String) : Exception(message)
class BundleTamperedException(message: String) : Exception(message)
