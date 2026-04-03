import Foundation
import Security

// MARK: - ConsentBundleManager

/// Manages the consent bundle lifecycle on iOS/macOS.
///
/// Handles:
/// - Fetching a consent bundle from the Grantex API (online)
/// - Storing the bundle in the system Keychain (encrypted at rest)
/// - Loading the bundle from the Keychain (offline)
/// - Deleting the bundle (after revocation)
///
/// The Keychain provides hardware-backed encryption on devices with a
/// Secure Enclave (iPhone 5S+, Apple Watch Series 1+, M1+ Macs).
///
/// Usage:
/// ```swift
/// // Phase 1: Online — fetch and store
/// let bundle = try await ConsentBundleManager.fetchBundle(
///     baseURL: "https://api.grantex.dev",
///     apiKey: "gx_...",
///     agentId: "agent_01",
///     userId: "user_alice",
///     scopes: ["sensors:read"]
/// )
/// try ConsentBundleManager.store(bundle)
///
/// // Phase 2: Offline — load
/// let stored = try ConsentBundleManager.load()
/// ```
enum ConsentBundleManager {

    /// Keychain service identifier for Grantex bundles.
    private static let keychainService = "dev.grantex.gemma"

    /// Keychain account key for the consent bundle.
    private static let keychainAccount = "consent_bundle"

    // MARK: - Phase 1: Fetch

    /// Fetch a consent bundle from the Grantex API.
    ///
    /// This requires network connectivity. The returned bundle contains
    /// everything needed for offline operation.
    ///
    /// - Parameters:
    ///   - baseURL: Grantex API base URL.
    ///   - apiKey: Developer API key.
    ///   - agentId: The agent's identifier or DID.
    ///   - userId: The principal (user) identifier.
    ///   - scopes: List of scopes to authorize.
    ///   - offlineTTL: How long the bundle is valid offline (default "72h").
    /// - Returns: The parsed ``ConsentBundle``.
    /// - Throws: ``GrantexError/networkError(_:)`` on failure.
    static func fetchBundle(
        baseURL: String,
        apiKey: String,
        agentId: String,
        userId: String,
        scopes: [String],
        offlineTTL: String = "72h"
    ) async throws -> ConsentBundle {
        let url = URL(string: "\(baseURL)/v1/consent-bundles")!

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body: [String: Any] = [
            "agentId": agentId,
            "userId": userId,
            "scopes": scopes,
            "offlineTtl": offlineTTL,
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw GrantexError.networkError("Failed to fetch consent bundle: \(error.localizedDescription)")
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            throw GrantexError.networkError("Invalid response type")
        }

        guard httpResponse.statusCode == 200 else {
            let body = String(data: data, encoding: .utf8) ?? "unknown"
            throw GrantexError.networkError("HTTP \(httpResponse.statusCode): \(body)")
        }

        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw GrantexError.networkError("Invalid JSON response")
        }

        return try parseBundle(json)
    }

    // MARK: - Keychain Storage

    /// Store a consent bundle in the Keychain.
    ///
    /// The bundle is serialized to JSON and stored with:
    /// - `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` — encrypted at rest
    /// - Device binding — cannot be restored to a different device
    ///
    /// - Parameter bundle: The consent bundle to store.
    /// - Throws: ``GrantexError/keychainError(_:)`` on failure.
    static func store(_ bundle: ConsentBundle) throws {
        let json = serializeBundle(bundle)
        guard let data = try? JSONSerialization.data(withJSONObject: json) else {
            throw GrantexError.keychainError("Failed to serialize bundle")
        }

        // Delete any existing bundle first
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
        ]
        SecItemDelete(deleteQuery as CFDictionary)

        // Add the new bundle
        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]

        let status = SecItemAdd(addQuery as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw GrantexError.keychainError("Keychain write failed: \(status)")
        }
    }

    /// Load a consent bundle from the Keychain.
    ///
    /// No network call is made.
    ///
    /// - Returns: The stored ``ConsentBundle``.
    /// - Throws: ``GrantexError/keychainError(_:)`` if not found or corrupted.
    static func load() throws -> ConsentBundle {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess, let data = result as? Data else {
            throw GrantexError.keychainError("No bundle found in Keychain (status: \(status))")
        }

        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw GrantexError.bundleTampered("Bundle in Keychain contains invalid JSON")
        }

        return try parseBundle(json)
    }

    /// Check whether a bundle exists in the Keychain.
    static func hasBundle() -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecReturnData as String: false,
        ]
        return SecItemCopyMatching(query as CFDictionary, nil) == errSecSuccess
    }

    /// Delete the bundle from the Keychain.
    static func delete() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
        ]
        SecItemDelete(query as CFDictionary)
    }

    // MARK: - Parsing

    /// Parse a JSON dictionary into a ``ConsentBundle``.
    private static func parseBundle(_ json: [String: Any]) throws -> ConsentBundle {
        guard let bundleId = json["bundleId"] as? String,
              let grantToken = json["grantToken"] as? String,
              let jwksData = json["jwksSnapshot"] as? [String: Any],
              let auditKeyData = json["offlineAuditKey"] as? [String: Any],
              let checkpointAt = json["checkpointAt"] as? Int,
              let syncEndpoint = json["syncEndpoint"] as? String,
              let offlineExpiresAt = json["offlineExpiresAt"] as? String else {
            throw GrantexError.bundleTampered("Missing required fields in bundle JSON")
        }

        guard let keys = jwksData["keys"] as? [[String: Any]],
              let fetchedAt = jwksData["fetchedAt"] as? String,
              let validUntil = jwksData["validUntil"] as? String else {
            throw GrantexError.bundleTampered("Invalid jwksSnapshot in bundle")
        }

        guard let publicKey = auditKeyData["publicKey"] as? String,
              let privateKey = auditKeyData["privateKey"] as? String,
              let algorithm = auditKeyData["algorithm"] as? String else {
            throw GrantexError.bundleTampered("Invalid offlineAuditKey in bundle")
        }

        return ConsentBundle(
            bundleId: bundleId,
            grantToken: grantToken,
            jwksSnapshot: JWKSSnapshot(
                keys: keys,
                fetchedAt: fetchedAt,
                validUntil: validUntil
            ),
            offlineAuditKey: OfflineAuditKey(
                publicKey: publicKey,
                privateKey: privateKey,
                algorithm: algorithm
            ),
            checkpointAt: checkpointAt,
            syncEndpoint: syncEndpoint,
            offlineExpiresAt: offlineExpiresAt
        )
    }

    /// Serialize a ``ConsentBundle`` to a JSON dictionary.
    private static func serializeBundle(_ bundle: ConsentBundle) -> [String: Any] {
        let keysAsJSON: [[String: Any]] = bundle.jwksSnapshot.keys

        return [
            "bundleId": bundle.bundleId,
            "grantToken": bundle.grantToken,
            "jwksSnapshot": [
                "keys": keysAsJSON,
                "fetchedAt": bundle.jwksSnapshot.fetchedAt,
                "validUntil": bundle.jwksSnapshot.validUntil,
            ] as [String: Any],
            "offlineAuditKey": [
                "publicKey": bundle.offlineAuditKey.publicKey,
                "privateKey": bundle.offlineAuditKey.privateKey,
                "algorithm": bundle.offlineAuditKey.algorithm,
            ] as [String: Any],
            "checkpointAt": bundle.checkpointAt,
            "syncEndpoint": bundle.syncEndpoint,
            "offlineExpiresAt": bundle.offlineExpiresAt,
        ]
    }
}
