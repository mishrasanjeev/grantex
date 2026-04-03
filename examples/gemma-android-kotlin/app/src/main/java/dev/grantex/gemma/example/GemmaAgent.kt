package dev.grantex.gemma.example

import android.util.Log
import com.nimbusds.jose.JWSAlgorithm
import com.nimbusds.jose.crypto.RSASSAVerifier
import com.nimbusds.jose.jwk.JWKSet
import com.nimbusds.jose.jwk.RSAKey
import com.nimbusds.jwt.SignedJWT
import org.json.JSONObject
import java.time.Instant
import java.util.Date

/**
 * A Gemma 4 on-device agent with Grantex offline authorization.
 *
 * This class demonstrates how to integrate Grantex offline auth with
 * an AI agent on Android. In production, you would combine this with
 * the Google AI Edge SDK for actual Gemma 4 inference.
 *
 * The agent:
 * 1. Verifies the grant token from the consent bundle using the JWKS snapshot
 * 2. Exposes tools with per-tool scope enforcement
 * 3. Logs every action (success or failure) to a hash-chained audit log
 *
 * Usage:
 * ```
 * val agent = GemmaAgent(bundle, auditLogger)
 * agent.verifyGrant()                     // Verify offline
 * agent.readSensor("temp_01")             // Requires sensors:read
 * agent.controlActuator("light", "on")    // Requires actuators:write
 * agent.sendAlert("Warning!")             // Requires alerts:send
 * ```
 */
class GemmaAgent(
    private val bundle: ConsentBundle,
    private val auditLogger: AuditLogger,
) {

    companion object {
        private const val TAG = "GemmaAgent"
        private const val CLOCK_SKEW_SECONDS = 60L
    }

    /** The verified grant extracted from the JWT token. */
    private var grant: VerifiedGrant? = null

    // ── Simulated device data ───────────────────────────────────────
    // In production, these would interface with actual hardware via GPIO,
    // Bluetooth, MQTT, or the Android Things API.

    private val sensorData = mapOf(
        "temp_living_room" to SensorReading("temperature", 22.5, "°C"),
        "temp_kitchen" to SensorReading("temperature", 24.1, "°C"),
        "humidity_bedroom" to SensorReading("humidity", 45.2, "%"),
        "motion_hallway" to SensorReading("motion", 1.0, "bool"),
        "light_level_patio" to SensorReading("light", 340.0, "lux"),
    )

    private val actuatorState = mutableMapOf(
        "thermostat_main" to "22°C",
        "light_living_room" to "on",
        "light_bedroom" to "off",
        "door_lock_front" to "locked",
        "fan_kitchen" to "off",
    )

    // ── Grant Verification ──────────────────────────────────────────

    /**
     * Verify the grant token from the consent bundle offline.
     *
     * This performs full JWT verification using the JWKS snapshot:
     * - Parses the JWT header to find the key ID (kid)
     * - Looks up the corresponding RSA public key in the JWKS snapshot
     * - Verifies the RS256 signature
     * - Checks expiry with clock skew tolerance
     * - Extracts Grantex-specific claims (scopes, agent DID, etc.)
     *
     * No network call is made.
     *
     * @return The verified grant containing scopes and identity claims.
     * @throws TokenExpiredException if the token has expired.
     * @throws GrantexAuthException if verification fails.
     */
    fun verifyGrant(): VerifiedGrant {
        Log.d(TAG, "Verifying grant token offline...")

        // Parse the JWT (without verification first to read the header)
        val jwt: SignedJWT
        try {
            jwt = SignedJWT.parse(bundle.grantToken)
        } catch (e: Exception) {
            throw GrantexAuthException("Malformed JWT: ${e.message}")
        }

        // Check the algorithm — only RS256 is allowed
        val alg = jwt.header.algorithm
        if (alg != JWSAlgorithm.RS256) {
            throw GrantexAuthException("Unsupported algorithm: $alg (only RS256 is allowed)")
        }

        // Find the signing key in the JWKS snapshot by key ID (kid)
        val kid = jwt.header.keyID
            ?: throw GrantexAuthException("JWT header missing 'kid' claim")

        val jwkSetJson = JSONObject().apply {
            put("keys", org.json.JSONArray(bundle.jwksSnapshot.keys.map { it.toString() }))
        }

        val jwkSet: JWKSet
        try {
            jwkSet = JWKSet.parse(jwkSetJson.toString())
        } catch (e: Exception) {
            throw GrantexAuthException("Failed to parse JWKS snapshot: ${e.message}")
        }

        val jwk = jwkSet.getKeyByKeyId(kid)
            ?: throw GrantexAuthException("No key found in JWKS snapshot for kid=$kid")

        if (jwk !is RSAKey) {
            throw GrantexAuthException("Key $kid is not an RSA key")
        }

        // Verify the RS256 signature
        val verifier = RSASSAVerifier(jwk.toRSAPublicKey())
        val signatureValid = jwt.verify(verifier)
        if (!signatureValid) {
            throw GrantexAuthException("JWT signature verification failed")
        }

        // Check expiry with clock skew tolerance
        val claims = jwt.jwtClaimsSet
        val expDate = claims.expirationTime
        if (expDate != null) {
            val now = Date.from(Instant.now().minusSeconds(CLOCK_SKEW_SECONDS))
            if (expDate.before(now)) {
                throw TokenExpiredException(
                    "Grant token expired at $expDate"
                )
            }
        }

        // Extract Grantex-specific claims
        val scopes = claims.getStringListClaim("scp") ?: emptyList()
        val agentDid = claims.getStringClaim("agt") ?: ""
        val principalDid = claims.subject ?: ""
        val jti = claims.jwtid ?: ""
        val grantId = claims.getStringClaim("grnt") ?: jti
        val depth = claims.getIntegerClaim("delegationDepth") ?: 0

        val verifiedGrant = VerifiedGrant(
            agentDid = agentDid,
            principalDid = principalDid,
            scopes = scopes,
            expiresAt = expDate?.toInstant() ?: Instant.MAX,
            jti = jti,
            grantId = grantId,
            depth = depth,
        )

        grant = verifiedGrant
        Log.d(TAG, "Grant verified: agent=$agentDid, scopes=$scopes")

        return verifiedGrant
    }

    // ── Tools with Scope Enforcement ────────────────────────────────
    // Each tool checks its required scope before executing and logs
    // every invocation to the audit log.

    /**
     * Read a sensor value. Requires the `sensors:read` scope.
     *
     * @param sensorId The sensor to read (e.g., "temp_living_room").
     * @return A human-readable result string.
     */
    fun readSensor(sensorId: String): ToolResult {
        val g = requireGrant()
        val requiredScope = "sensors:read"

        // Scope enforcement
        if (!g.scopes.contains(requiredScope)) {
            auditLogger.append(
                action = "read_sensor",
                agentDid = g.agentDid,
                grantId = g.grantId,
                scopes = g.scopes,
                result = "denied",
                metadata = mapOf("sensor_id" to sensorId, "reason" to "missing scope: $requiredScope"),
            )
            return ToolResult(
                success = false,
                message = "DENIED: missing scope $requiredScope",
            )
        }

        // Execute the tool
        val sensor = sensorData[sensorId]
        if (sensor == null) {
            auditLogger.append(
                action = "read_sensor",
                agentDid = g.agentDid,
                grantId = g.grantId,
                scopes = g.scopes,
                result = "error",
                metadata = mapOf("sensor_id" to sensorId, "error" to "not_found"),
            )
            return ToolResult(
                success = false,
                message = "ERROR: sensor $sensorId not found",
            )
        }

        val message = "${sensor.type}=${sensor.value}${sensor.unit}"

        // Log the successful action
        auditLogger.append(
            action = "read_sensor",
            agentDid = g.agentDid,
            grantId = g.grantId,
            scopes = g.scopes,
            result = "success",
            metadata = mapOf("sensor_id" to sensorId, "reading" to sensor.value),
        )

        return ToolResult(success = true, message = message)
    }

    /**
     * Control an actuator. Requires the `actuators:write` scope.
     *
     * @param actuatorId The actuator to control (e.g., "thermostat_main").
     * @param action The action to perform (e.g., "set_temp:23", "unlock").
     * @return A human-readable result string.
     */
    fun controlActuator(actuatorId: String, action: String): ToolResult {
        val g = requireGrant()
        val requiredScope = "actuators:write"

        // Scope enforcement
        if (!g.scopes.contains(requiredScope)) {
            auditLogger.append(
                action = "control_actuator",
                agentDid = g.agentDid,
                grantId = g.grantId,
                scopes = g.scopes,
                result = "denied",
                metadata = mapOf(
                    "actuator_id" to actuatorId,
                    "requested_action" to action,
                    "reason" to "missing scope: $requiredScope",
                ),
            )
            return ToolResult(
                success = false,
                message = "DENIED: missing scope $requiredScope",
            )
        }

        // Execute the tool
        if (actuatorId !in actuatorState) {
            auditLogger.append(
                action = "control_actuator",
                agentDid = g.agentDid,
                grantId = g.grantId,
                scopes = g.scopes,
                result = "error",
                metadata = mapOf("actuator_id" to actuatorId, "error" to "not_found"),
            )
            return ToolResult(
                success = false,
                message = "ERROR: actuator $actuatorId not found",
            )
        }

        actuatorState[actuatorId] = action

        val message = when {
            action.startsWith("set_temp:") -> "thermostat set to ${action.substringAfter(":")}°C"
            action == "unlock" -> "${actuatorId.replace("_", " ")} unlocked"
            action == "lock" -> "${actuatorId.replace("_", " ")} locked"
            action == "on" -> "$actuatorId turned on"
            action == "off" -> "$actuatorId turned off"
            else -> "$actuatorId: $action executed"
        }

        // Log the successful action
        auditLogger.append(
            action = "control_actuator",
            agentDid = g.agentDid,
            grantId = g.grantId,
            scopes = g.scopes,
            result = "success",
            metadata = mapOf("actuator_id" to actuatorId, "command" to action),
        )

        return ToolResult(success = true, message = message)
    }

    /**
     * Send an alert notification. Requires the `alerts:send` scope.
     *
     * @param message The alert message to send.
     * @return A human-readable result string.
     */
    fun sendAlert(message: String): ToolResult {
        val g = requireGrant()
        val requiredScope = "alerts:send"

        // Scope enforcement
        if (!g.scopes.contains(requiredScope)) {
            auditLogger.append(
                action = "send_alert",
                agentDid = g.agentDid,
                grantId = g.grantId,
                scopes = g.scopes,
                result = "denied",
                metadata = mapOf("message" to message, "reason" to "missing scope: $requiredScope"),
            )
            return ToolResult(
                success = false,
                message = "DENIED: missing scope $requiredScope",
            )
        }

        // In production, this would send via FCM, MQTT, or a notification service
        auditLogger.append(
            action = "send_alert",
            agentDid = g.agentDid,
            grantId = g.grantId,
            scopes = g.scopes,
            result = "success",
            metadata = mapOf("message" to message),
        )

        return ToolResult(success = true, message = "alert sent")
    }

    /**
     * Attempt to delete a device. Requires the `admin:delete` scope,
     * which is NOT included in the consent bundle — demonstrating
     * scope violation handling.
     *
     * @param deviceId The device to attempt deletion on.
     * @return A denial result (expected).
     */
    fun deleteDevice(deviceId: String): ToolResult {
        val g = requireGrant()
        val requiredScope = "admin:delete"

        // This will always be denied because admin:delete is not in the grant
        if (!g.scopes.contains(requiredScope)) {
            auditLogger.append(
                action = "delete_device",
                agentDid = g.agentDid,
                grantId = g.grantId,
                scopes = g.scopes,
                result = "denied",
                metadata = mapOf("device_id" to deviceId, "reason" to "missing scope: $requiredScope"),
            )
            return ToolResult(
                success = false,
                message = "DENIED: missing scope $requiredScope",
            )
        }

        // This line should never be reached in this example
        return ToolResult(success = true, message = "deleted")
    }

    // ── Helpers ─────────────────────────────────────────────────────

    /**
     * Ensure the grant has been verified before tool execution.
     */
    private fun requireGrant(): VerifiedGrant {
        return grant ?: throw GrantexAuthException(
            "Grant not verified. Call verifyGrant() first."
        )
    }
}

// ── Data Classes ────────────────────────────────────────────────────

/**
 * The result of a successful offline grant verification.
 */
data class VerifiedGrant(
    val agentDid: String,
    val principalDid: String,
    val scopes: List<String>,
    val expiresAt: Instant,
    val jti: String,
    val grantId: String,
    val depth: Int,
)

/**
 * A simulated sensor reading.
 */
data class SensorReading(
    val type: String,
    val value: Double,
    val unit: String,
)

/**
 * The result of a tool invocation.
 */
data class ToolResult(
    val success: Boolean,
    val message: String,
)
