import Foundation
import CryptoKit

// MARK: - AuditLogger

/// Offline audit logger with hash chain and Ed25519 signing.
///
/// Every audit entry is:
/// 1. SHA-256 hashed together with the previous entry's hash (forming a chain)
/// 2. Signed with the Ed25519 private key from the consent bundle
/// 3. Appended to a JSONL file on disk
///
/// The hash chain makes the log tamper-evident: modifying any past entry
/// breaks the chain, and `verifyChain()` detects the exact break point.
///
/// Usage:
/// ```swift
/// let logger = AuditLogger()
/// try logger.initialize(auditKey: bundle.offlineAuditKey)
///
/// let entry = try logger.append(
///     action: "read_sensor",
///     grant: grant,
///     result: "success",
///     metadata: ["sensor_id": "temp_01"]
/// )
/// ```
class AuditLogger {

    /// The genesis hash — used as prev_hash for the first entry.
    static let genesisHash = String(repeating: "0", count: 64)

    /// Path to the JSONL audit log file.
    private let logPath: URL

    /// Current sequence number (auto-incremented).
    private var seq: Int = 0

    /// Hash of the previous entry (for chain linking).
    private var prevHash: String

    /// Ed25519 private key for signing entries.
    private var privateKey: Curve25519.Signing.PrivateKey?

    // MARK: - Init

    /// Create an audit logger.
    ///
    /// - Parameter logDirectory: Directory for the JSONL file. Defaults to
    ///   `~/.grantex/` on macOS or the app's documents directory on iOS.
    init(logDirectory: URL? = nil) {
        let dir: URL
        if let logDirectory {
            dir = logDirectory
        } else {
            #if os(macOS)
            dir = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".grantex")
            #else
            dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("grantex")
            #endif
        }

        // Create directory if needed
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        self.logPath = dir.appendingPathComponent("audit.jsonl")
        self.prevHash = AuditLogger.genesisHash

        // Resume from existing log
        resumeFromDisk()
    }

    // MARK: - Initialize

    /// Initialize the logger with the Ed25519 signing key from the bundle.
    ///
    /// Must be called before `append()`.
    ///
    /// - Parameter auditKey: The Ed25519 key pair from the consent bundle.
    /// - Throws: If the private key cannot be parsed.
    func initialize(auditKey: OfflineAuditKey) throws {
        // Parse the Ed25519 private key from PEM
        let pem = auditKey.privateKey
        let b64 = pem
            .replacingOccurrences(of: "-----BEGIN PRIVATE KEY-----", with: "")
            .replacingOccurrences(of: "-----END PRIVATE KEY-----", with: "")
            .components(separatedBy: .whitespacesAndNewlines)
            .joined()

        guard let decoded = Data(base64Encoded: b64) else {
            throw GrantexError.bundleTampered("Invalid Ed25519 private key encoding")
        }

        // PKCS8 wrapping for Ed25519 has a prefix before the 32-byte key.
        // The raw key is the last 32 bytes.
        let keyBytes: Data
        if decoded.count > 32 {
            keyBytes = decoded.suffix(32)
        } else {
            keyBytes = decoded
        }

        privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: keyBytes)
    }

    // MARK: - Append

    /// Append a new signed, hash-chained audit entry.
    ///
    /// - Parameters:
    ///   - action: The action being audited (e.g., "read_sensor").
    ///   - grant: The verified grant that authorized this action.
    ///   - result: The outcome: "success", "denied", or "error".
    ///   - metadata: Optional key-value pairs with additional context.
    /// - Returns: The signed ``SignedAuditEntry``.
    /// - Throws: If signing fails.
    func append(
        action: String,
        grant: VerifiedGrant,
        result: String,
        metadata: [String: Any] = [:]
    ) throws -> SignedAuditEntry {
        guard let privateKey else {
            throw GrantexError.bundleTampered("Audit logger not initialized. Call initialize() first.")
        }

        seq += 1
        let timestamp = ISO8601DateFormatter().string(from: Date())

        // Build the entry dictionary for hashing
        let entryForHash: [String: Any] = [
            "seq": seq,
            "timestamp": timestamp,
            "action": action,
            "agent_did": grant.agentDID,
            "grant_id": grant.grantId,
            "scopes": grant.scopes,
            "result": result,
            "metadata": metadata,
            "prev_hash": prevHash,
        ]

        // Compute SHA-256 hash
        let hash = computeHash(entryForHash)

        // Sign the hash with Ed25519
        let hashData = hash.data(using: .utf8)!
        let signature = try privateKey.signature(for: hashData)
        let signatureB64 = signature.withUnsafeBytes { Data($0) }
            .base64URLEncodedString()

        // Build the full entry for storage
        let fullEntry: [String: Any] = [
            "seq": seq,
            "timestamp": timestamp,
            "action": action,
            "agent_did": grant.agentDID,
            "grant_id": grant.grantId,
            "scopes": grant.scopes,
            "result": result,
            "metadata": metadata,
            "prev_hash": prevHash,
            "hash": hash,
            "signature": signatureB64,
        ]

        // Serialize to JSON and append to the JSONL file
        let jsonData = try JSONSerialization.data(withJSONObject: fullEntry, options: [.sortedKeys])
        let jsonString = String(data: jsonData, encoding: .utf8)!

        let line = jsonString + "\n"
        if let fileHandle = try? FileHandle(forWritingTo: logPath) {
            fileHandle.seekToEndOfFile()
            fileHandle.write(line.data(using: .utf8)!)
            fileHandle.closeFile()
        } else {
            try line.write(to: logPath, atomically: false, encoding: .utf8)
        }

        // Update chain state
        prevHash = hash

        return SignedAuditEntry(
            seq: seq,
            timestamp: timestamp,
            action: action,
            agentDID: grant.agentDID,
            grantId: grant.grantId,
            scopes: grant.scopes,
            result: result,
            metadata: metadata,
            prevHash: entryForHash["prev_hash"] as! String,
            hash: hash,
            signature: signatureB64
        )
    }

    // MARK: - Read Entries

    /// Read all entries from the JSONL log file.
    func readEntries() -> [SignedAuditEntry] {
        guard let content = try? String(contentsOf: logPath, encoding: .utf8) else {
            return []
        }

        return content
            .split(separator: "\n")
            .filter { !$0.isEmpty }
            .compactMap { line -> SignedAuditEntry? in
                guard let data = line.data(using: .utf8),
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    return nil
                }

                return SignedAuditEntry(
                    seq: json["seq"] as? Int ?? 0,
                    timestamp: json["timestamp"] as? String ?? "",
                    action: json["action"] as? String ?? "",
                    agentDID: json["agent_did"] as? String ?? "",
                    grantId: json["grant_id"] as? String ?? "",
                    scopes: json["scopes"] as? [String] ?? [],
                    result: json["result"] as? String ?? "",
                    metadata: json["metadata"] as? [String: Any] ?? [:],
                    prevHash: json["prev_hash"] as? String ?? "",
                    hash: json["hash"] as? String ?? "",
                    signature: json["signature"] as? String ?? ""
                )
            }
    }

    // MARK: - Verify Chain

    /// Verify the integrity of the hash chain.
    ///
    /// - Returns: A tuple of (isValid, brokenAtIndex). If valid,
    ///   brokenAtIndex is nil.
    func verifyChain() -> (valid: Bool, brokenAt: Int?) {
        let entries = readEntries()
        guard !entries.isEmpty else {
            return (true, nil)
        }

        for (i, entry) in entries.enumerated() {
            // Recompute hash from content fields
            let entryForHash: [String: Any] = [
                "seq": entry.seq,
                "timestamp": entry.timestamp,
                "action": entry.action,
                "agent_did": entry.agentDID,
                "grant_id": entry.grantId,
                "scopes": entry.scopes,
                "result": entry.result,
                "metadata": entry.metadata,
                "prev_hash": entry.prevHash,
            ]

            let expectedHash = computeHash(entryForHash)
            if entry.hash != expectedHash {
                return (false, i)
            }

            // Check prev_hash linkage
            if i > 0 && entry.prevHash != entries[i - 1].hash {
                return (false, i)
            }
        }

        return (true, nil)
    }

    // MARK: - Internal

    /// Resume seq and prevHash from an existing log file.
    private func resumeFromDisk() {
        guard let content = try? String(contentsOf: logPath, encoding: .utf8) else {
            return
        }

        let lines = content.split(separator: "\n").filter { !$0.isEmpty }
        guard let lastLine = lines.last,
              let data = lastLine.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }

        seq = json["seq"] as? Int ?? 0
        prevHash = json["hash"] as? String ?? AuditLogger.genesisHash
    }

    /// Compute SHA-256 hash of an entry dictionary.
    ///
    /// Uses sorted keys for deterministic hashing that matches the
    /// Python and TypeScript implementations.
    private func computeHash(_ entry: [String: Any]) -> String {
        // Build canonical representation with sorted keys
        let canonical: [String: Any] = [
            "action": entry["action"] as Any,
            "agent_did": entry["agent_did"] as Any,
            "grant_id": entry["grant_id"] as Any,
            "metadata": entry["metadata"] as Any,
            "prev_hash": entry["prev_hash"] as Any,
            "result": entry["result"] as Any,
            "scopes": entry["scopes"] as Any,
            "seq": entry["seq"] as Any,
            "timestamp": entry["timestamp"] as Any,
        ]

        guard let jsonData = try? JSONSerialization.data(
            withJSONObject: canonical,
            options: [.sortedKeys]
        ) else {
            return ""
        }

        let hash = SHA256.hash(data: jsonData)
        return hash.compactMap { String(format: "%02x", $0) }.joined()
    }
}

// MARK: - SignedAuditEntry

/// A signed, hash-chained audit log entry.
struct SignedAuditEntry {
    let seq: Int
    let timestamp: String
    let action: String
    let agentDID: String
    let grantId: String
    let scopes: [String]
    let result: String
    let metadata: [String: Any]
    let prevHash: String
    let hash: String
    let signature: String
}

// MARK: - Data Extension

extension Data {
    /// Encode data as base64url (no padding).
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
