import Foundation

// ─────────────────────────────────────────────────────────────────────
// Grantex Gemma Agent — iOS/macOS Example
//
// Demonstrates the three-phase offline authorization flow:
//   Phase 1 (Online):  Fetch a consent bundle from the Grantex API
//   Phase 2 (Offline): Verify the grant token, run scoped tools,
//                       log actions to a hash-chained audit log
//   Phase 3 (Online):  Sync audit entries to the Grantex cloud
// ─────────────────────────────────────────────────────────────────────

// ── Configuration ───────────────────────────────────────────────────
let grantexBaseURL = "http://localhost:3001"
let grantexAPIKey = "sandbox-api-key-local"
let agentId = "agent_gemma_ios_01"
let userId = "user_alice"
let scopes = ["sensors:read", "actuators:write", "alerts:send"]

// ── Simulated sensor and actuator data ──────────────────────────────
// In production, these would interface with HomeKit, Core Bluetooth,
// or external IoT APIs.

struct SensorReading {
    let type: String
    let value: Double
    let unit: String
}

let sensorData: [String: SensorReading] = [
    "temp_living_room": SensorReading(type: "temperature", value: 22.5, unit: "°C"),
    "temp_kitchen": SensorReading(type: "temperature", value: 24.1, unit: "°C"),
    "humidity_bedroom": SensorReading(type: "humidity", value: 45.2, unit: "%"),
    "motion_hallway": SensorReading(type: "motion", value: 1.0, unit: "bool"),
    "light_level_patio": SensorReading(type: "light", value: 340.0, unit: "lux"),
]

var actuatorState: [String: String] = [
    "thermostat_main": "22°C",
    "light_living_room": "on",
    "light_bedroom": "off",
    "door_lock_front": "locked",
    "fan_kitchen": "off",
]

// ── Tool Functions ──────────────────────────────────────────────────
// Each tool checks its required scope before executing and logs every
// action (success or failure) to the audit log.

/// Read a sensor value. Requires the `sensors:read` scope.
func readSensor(
    _ sensorId: String,
    grant: VerifiedGrant,
    auditLogger: AuditLogger
) -> (success: Bool, message: String) {
    let requiredScope = "sensors:read"

    // Scope check
    guard grant.hasScope(requiredScope) else {
        try? auditLogger.append(
            action: "read_sensor",
            grant: grant,
            result: "denied",
            metadata: ["sensor_id": sensorId, "reason": "missing scope: \(requiredScope)"]
        )
        return (false, "DENIED: missing scope \(requiredScope)")
    }

    // Execute
    guard let sensor = sensorData[sensorId] else {
        try? auditLogger.append(
            action: "read_sensor",
            grant: grant,
            result: "error",
            metadata: ["sensor_id": sensorId, "error": "not_found"]
        )
        return (false, "ERROR: sensor \(sensorId) not found")
    }

    let message = "\(sensor.type)=\(sensor.value)\(sensor.unit)"

    // Log success
    try? auditLogger.append(
        action: "read_sensor",
        grant: grant,
        result: "success",
        metadata: ["sensor_id": sensorId, "reading": sensor.value]
    )

    return (true, message)
}

/// Control an actuator. Requires the `actuators:write` scope.
func controlActuator(
    _ actuatorId: String,
    action: String,
    grant: VerifiedGrant,
    auditLogger: AuditLogger
) -> (success: Bool, message: String) {
    let requiredScope = "actuators:write"

    // Scope check
    guard grant.hasScope(requiredScope) else {
        try? auditLogger.append(
            action: "control_actuator",
            grant: grant,
            result: "denied",
            metadata: [
                "actuator_id": actuatorId,
                "requested_action": action,
                "reason": "missing scope: \(requiredScope)",
            ]
        )
        return (false, "DENIED: missing scope \(requiredScope)")
    }

    // Execute
    guard actuatorState[actuatorId] != nil else {
        try? auditLogger.append(
            action: "control_actuator",
            grant: grant,
            result: "error",
            metadata: ["actuator_id": actuatorId, "error": "not_found"]
        )
        return (false, "ERROR: actuator \(actuatorId) not found")
    }

    actuatorState[actuatorId] = action

    let message: String
    if action.hasPrefix("set_temp:") {
        let temp = action.replacingOccurrences(of: "set_temp:", with: "")
        message = "thermostat set to \(temp)°C"
    } else if action == "unlock" {
        message = "\(actuatorId.replacingOccurrences(of: "_", with: " ")) unlocked"
    } else if action == "lock" {
        message = "\(actuatorId.replacingOccurrences(of: "_", with: " ")) locked"
    } else if action == "on" {
        message = "\(actuatorId) turned on"
    } else if action == "off" {
        message = "\(actuatorId) turned off"
    } else {
        message = "\(actuatorId): \(action) executed"
    }

    // Log success
    try? auditLogger.append(
        action: "control_actuator",
        grant: grant,
        result: "success",
        metadata: ["actuator_id": actuatorId, "command": action]
    )

    return (true, message)
}

/// Send an alert. Requires the `alerts:send` scope.
func sendAlert(
    _ alertMessage: String,
    grant: VerifiedGrant,
    auditLogger: AuditLogger
) -> (success: Bool, message: String) {
    let requiredScope = "alerts:send"

    // Scope check
    guard grant.hasScope(requiredScope) else {
        try? auditLogger.append(
            action: "send_alert",
            grant: grant,
            result: "denied",
            metadata: ["message": alertMessage, "reason": "missing scope: \(requiredScope)"]
        )
        return (false, "DENIED: missing scope \(requiredScope)")
    }

    // In production: APNs, UserNotifications, or external push service
    try? auditLogger.append(
        action: "send_alert",
        grant: grant,
        result: "success",
        metadata: ["message": alertMessage]
    )

    return (true, "alert sent")
}

/// Attempt to delete a device. Requires `admin:delete`, which is NOT granted.
func deleteDevice(
    _ deviceId: String,
    grant: VerifiedGrant,
    auditLogger: AuditLogger
) -> (success: Bool, message: String) {
    let requiredScope = "admin:delete"

    guard grant.hasScope(requiredScope) else {
        try? auditLogger.append(
            action: "delete_device",
            grant: grant,
            result: "denied",
            metadata: ["device_id": deviceId, "reason": "missing scope: \(requiredScope)"]
        )
        return (false, "DENIED: missing scope \(requiredScope)")
    }

    return (true, "deleted")
}

// ── Main ────────────────────────────────────────────────────────────

func printLine(_ msg: String = "") {
    print(msg)
}

func printSeparator() {
    printLine(String(repeating: "-", count: 54))
}

func run() async {
    printLine(String(repeating: "=", count: 54))
    printLine("  Grantex Gemma Agent — iOS/macOS Example")
    printLine(String(repeating: "=", count: 54))
    printLine()

    // ── Phase 1: Create consent bundle (online) ─────────────────
    printLine("Phase 1: Creating consent bundle (online)...")
    printSeparator()

    let bundle: ConsentBundle
    do {
        bundle = try await ConsentBundleManager.fetchBundle(
            baseURL: grantexBaseURL,
            apiKey: grantexAPIKey,
            agentId: agentId,
            userId: userId,
            scopes: scopes
        )
    } catch {
        printLine("ERROR: Failed to fetch bundle: \(error)")
        printLine()
        printLine("  Make sure the Grantex stack is running:")
        printLine("    docker compose up -d   (from repo root)")
        return
    }

    printLine("Bundle created successfully!")
    printLine("  Bundle ID: \(bundle.bundleId)")
    printLine("  Expires:   \(bundle.offlineExpiresAt)")

    // Store in Keychain
    do {
        try ConsentBundleManager.store(bundle)
        printLine("Bundle stored in Keychain")
    } catch {
        printLine("WARNING: Keychain store failed (\(error)). Continuing with in-memory bundle.")
    }

    // ── Phase 2: Run agent offline ──────────────────────────────
    printLine()
    printLine("Phase 2: Running agent offline...")
    printSeparator()

    // Load from Keychain (demonstrates the offline path)
    let storedBundle: ConsentBundle
    do {
        storedBundle = try ConsentBundleManager.load()
        printLine("Bundle loaded from Keychain")
    } catch {
        printLine("Keychain load failed, using in-memory bundle")
        storedBundle = bundle
    }

    // Initialize the audit logger
    let auditLogger = AuditLogger()
    do {
        try auditLogger.initialize(auditKey: storedBundle.offlineAuditKey)
        printLine("Audit logger initialized")
    } catch {
        printLine("ERROR: Failed to initialize audit logger: \(error)")
        return
    }

    // Verify the grant token offline
    let verifier = OfflineVerifier(jwksSnapshot: storedBundle.jwksSnapshot)
    let grant: VerifiedGrant
    do {
        grant = try verifier.verify(token: storedBundle.grantToken)
    } catch {
        printLine("ERROR: Grant verification failed: \(error)")
        return
    }

    printLine("Grant verified offline:")
    printLine("  Agent:     \(grant.agentDID)")
    printLine("  Principal: \(grant.principalDID)")
    printLine("  Scopes:    \(grant.scopes.joined(separator: ", "))")
    printLine("  Expires:   \(grant.expiresAt)")

    // ── Execute tools ───────────────────────────────────────────
    printLine()
    printLine("Simulating smart home agent actions...")
    printSeparator()

    // Tool 1: Read temperature (sensors:read)
    let temp = readSensor("temp_living_room", grant: grant, auditLogger: auditLogger)
    printLine("[read_sensor] temp_living_room -> \(temp.message) \(temp.success ? "(OK)" : "")")

    // Tool 2: Read humidity (sensors:read)
    let humidity = readSensor("humidity_bedroom", grant: grant, auditLogger: auditLogger)
    printLine("[read_sensor] humidity_bedroom -> \(humidity.message) \(humidity.success ? "(OK)" : "")")

    // Tool 3: Adjust thermostat (actuators:write)
    let thermo = controlActuator("thermostat_main", action: "set_temp:23", grant: grant, auditLogger: auditLogger)
    printLine("[control_actuator] thermostat set_temp:23 -> \(thermo.message) \(thermo.success ? "(OK)" : "")")

    // Tool 4: Send alert (alerts:send)
    let alert = sendAlert("Humidity below threshold", grant: grant, auditLogger: auditLogger)
    printLine("[send_alert] Humidity below threshold -> \(alert.message) \(alert.success ? "(OK)" : "")")

    // Tool 5: Unlock door (actuators:write)
    let door = controlActuator("door_lock_front", action: "unlock", grant: grant, auditLogger: auditLogger)
    printLine("[control_actuator] door_lock unlock -> \(door.message) \(door.success ? "(OK)" : "")")

    // ── Test scope violation ────────────────────────────────────
    printLine()
    printLine("Testing scope violation...")
    printSeparator()

    // Tool 6: Delete device (admin:delete — NOT granted)
    let del = deleteDevice("thermostat_main", grant: grant, auditLogger: auditLogger)
    printLine("[delete_device] thermostat_main -> \(del.message)")

    // ── Audit log summary ───────────────────────────────────────
    printLine()
    printLine("Audit Log Summary")
    printSeparator()

    let entries = auditLogger.readEntries()
    printLine("  #  | Action             | Result  | Hash (first 12)")
    printLine("  ---|--------------------|---------|-----------------")
    for entry in entries {
        let action = entry.action.padding(toLength: 18, withPad: " ", startingAt: 0)
        let result = entry.result.padding(toLength: 7, withPad: " ", startingAt: 0)
        let hashShort = String(entry.hash.prefix(12))
        printLine("  \(String(format: "%2d", entry.seq)) | \(action) | \(result) | \(hashShort)")
    }

    // Verify hash chain
    let (valid, brokenAt) = auditLogger.verifyChain()
    printLine()
    if valid {
        printLine("Hash chain: VALID (\(entries.count) entries)")
    } else {
        printLine("Hash chain: BROKEN at entry #\(brokenAt ?? -1)")
    }

    let successCount = entries.filter { $0.result == "success" }.count
    let deniedCount = entries.filter { $0.result == "denied" }.count
    printLine("Total: \(entries.count) entries (\(successCount) success, \(deniedCount) denied)")

    // ── Phase 3 ─────────────────────────────────────────────────
    printLine()
    printLine("Phase 3: Audit sync")
    printSeparator()
    printLine("In production, \(entries.count) audit entries would be synced to:")
    printLine("  \(storedBundle.syncEndpoint)")
    printLine()
    printLine("Demo complete!")

    // Clean up Keychain for demo
    ConsentBundleManager.delete()
}

// Entry point — run the async main function
RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.1))
let semaphore = DispatchSemaphore(value: 0)
Task {
    await run()
    semaphore.signal()
}
semaphore.wait()
