import Foundation
import CryptoKit
import Security

// MARK: - OfflineVerifier

/// Verifies Grantex grant tokens offline using a JWKS snapshot.
///
/// The verifier performs full RS256 JWT verification using the pre-fetched
/// JWKS keys from the consent bundle. No network call is made.
///
/// Usage:
/// ```swift
/// let verifier = OfflineVerifier(jwksSnapshot: bundle.jwksSnapshot)
/// let grant = try verifier.verify(token: bundle.grantToken)
/// print(grant.scopes) // ["sensors:read", "actuators:write"]
/// ```
struct OfflineVerifier {

    /// Pre-fetched JWKS keys for offline signature verification.
    let jwksSnapshot: JWKSSnapshot

    /// Allowed clock-skew tolerance in seconds (default 60).
    var clockSkewSeconds: TimeInterval = 60

    // MARK: - Verify

    /// Verify a JWT grant token and return the verified grant.
    ///
    /// This method:
    /// 1. Decodes the JWT header to find the key ID (kid)
    /// 2. Looks up the RSA public key in the JWKS snapshot
    /// 3. Verifies the RS256 signature
    /// 4. Checks expiry with clock skew tolerance
    /// 5. Extracts Grantex-specific claims
    ///
    /// - Parameter token: The JWT grant token string.
    /// - Returns: A ``VerifiedGrant`` with the decoded claims.
    /// - Throws: ``GrantexError`` if verification fails.
    func verify(token: String) throws -> VerifiedGrant {
        // Split the JWT into its three parts
        let parts = token.split(separator: ".")
        guard parts.count == 3 else {
            throw GrantexError.malformedToken("JWT must have 3 parts, got \(parts.count)")
        }

        let headerB64 = String(parts[0])
        let payloadB64 = String(parts[1])
        let signatureB64 = String(parts[2])

        // Decode the header
        guard let headerData = base64URLDecode(headerB64),
              let header = try? JSONSerialization.jsonObject(with: headerData) as? [String: Any] else {
            throw GrantexError.malformedToken("Unable to decode JWT header")
        }

        // Check algorithm — only RS256 is allowed
        guard let alg = header["alg"] as? String else {
            throw GrantexError.malformedToken("JWT header missing 'alg' claim")
        }
        guard alg == "RS256" else {
            if alg == "none" || alg == "HS256" {
                throw GrantexError.blockedAlgorithm(alg)
            }
            throw GrantexError.unsupportedAlgorithm(alg)
        }

        // Get the key ID
        guard let kid = header["kid"] as? String else {
            throw GrantexError.malformedToken("JWT header missing 'kid' claim")
        }

        // Find the RSA key in the JWKS snapshot
        guard let jwk = jwksSnapshot.keys.first(where: { $0["kid"] as? String == kid }) else {
            throw GrantexError.keyNotFound(kid)
        }

        // Import the RSA public key from the JWK
        let publicKey = try importRSAPublicKey(from: jwk)

        // Verify the RS256 signature
        let signedData = "\(headerB64).\(payloadB64)".data(using: .utf8)!
        guard let signatureData = base64URLDecode(signatureB64) else {
            throw GrantexError.malformedToken("Invalid signature encoding")
        }

        let isValid = SecKeyVerifySignature(
            publicKey,
            .rsaSignatureMessagePKCS1v15SHA256,
            signedData as CFData,
            signatureData as CFData,
            nil
        )

        guard isValid else {
            throw GrantexError.signatureInvalid
        }

        // Decode the payload
        guard let payloadData = base64URLDecode(payloadB64),
              let payload = try? JSONSerialization.jsonObject(with: payloadData) as? [String: Any] else {
            throw GrantexError.malformedToken("Unable to decode JWT payload")
        }

        // Check expiry
        if let exp = payload["exp"] as? TimeInterval {
            let expiryDate = Date(timeIntervalSince1970: exp)
            let adjustedNow = Date().addingTimeInterval(-clockSkewSeconds)
            if expiryDate < adjustedNow {
                throw GrantexError.tokenExpired(expiryDate)
            }
        }

        // Check iat is not in the future
        if let iat = payload["iat"] as? TimeInterval {
            let iatDate = Date(timeIntervalSince1970: iat)
            let adjustedNow = Date().addingTimeInterval(clockSkewSeconds)
            if iatDate > adjustedNow {
                throw GrantexError.malformedToken("Token iat is in the future")
            }
        }

        // Extract Grantex-specific claims
        let scopes = payload["scp"] as? [String] ?? []
        let agentDID = payload["agt"] as? String ?? ""
        let principalDID = payload["sub"] as? String ?? ""
        let jti = payload["jti"] as? String ?? ""
        let grantId = payload["grnt"] as? String ?? jti
        let depth = payload["delegationDepth"] as? Int ?? 0
        let exp = payload["exp"] as? TimeInterval ?? 0
        let expiresAt = Date(timeIntervalSince1970: exp)

        return VerifiedGrant(
            agentDID: agentDID,
            principalDID: principalDID,
            scopes: scopes,
            expiresAt: expiresAt,
            jti: jti,
            grantId: grantId,
            depth: depth
        )
    }

    // MARK: - RSA Key Import

    /// Import an RSA public key from a JWK dictionary.
    ///
    /// - Parameter jwk: The JWK dictionary containing `n` (modulus) and `e` (exponent).
    /// - Returns: A `SecKey` for RSA signature verification.
    private func importRSAPublicKey(from jwk: [String: Any]) throws -> SecKey {
        guard let nB64 = jwk["n"] as? String,
              let eB64 = jwk["e"] as? String,
              let nData = base64URLDecode(nB64),
              let eData = base64URLDecode(eB64) else {
            throw GrantexError.malformedToken("JWK missing 'n' or 'e' parameters")
        }

        // Build a DER-encoded RSA public key
        // RSAPublicKey ::= SEQUENCE { modulus INTEGER, publicExponent INTEGER }
        let modulusBytes = asn1Integer(nData)
        let exponentBytes = asn1Integer(eData)
        let sequenceContent = modulusBytes + exponentBytes
        let rsaPublicKeyDER = asn1Sequence(sequenceContent)

        // Wrap in SubjectPublicKeyInfo
        // SEQUENCE { SEQUENCE { OID rsaEncryption, NULL }, BIT STRING { rsaPublicKeyDER } }
        let rsaOID: [UInt8] = [0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01]
        let nullParam: [UInt8] = [0x05, 0x00]
        let algorithmIdentifier = asn1Sequence(Data(rsaOID + nullParam))
        let bitString = asn1BitString(rsaPublicKeyDER)
        let spki = asn1Sequence(algorithmIdentifier + bitString)

        let attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
            kSecAttrKeyClass as String: kSecAttrKeyClassPublic,
            kSecAttrKeySizeInBits as String: nData.count * 8,
        ]

        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateWithData(spki as CFData, attributes as CFDictionary, &error) else {
            let desc = error?.takeRetainedValue().localizedDescription ?? "unknown error"
            throw GrantexError.malformedToken("Failed to import RSA key: \(desc)")
        }

        return key
    }

    // MARK: - ASN.1 Helpers

    /// Encode data as an ASN.1 INTEGER.
    private func asn1Integer(_ data: Data) -> Data {
        var bytes = [UInt8](data)
        // If the high bit is set, prepend a 0x00 byte
        if let first = bytes.first, first & 0x80 != 0 {
            bytes.insert(0x00, at: 0)
        }
        return Data([0x02]) + asn1Length(bytes.count) + Data(bytes)
    }

    /// Encode data as an ASN.1 SEQUENCE.
    private func asn1Sequence(_ data: Data) -> Data {
        return Data([0x30]) + asn1Length(data.count) + data
    }

    /// Encode data as an ASN.1 BIT STRING (with 0 unused bits).
    private func asn1BitString(_ data: Data) -> Data {
        let content = Data([0x00]) + data  // 0 unused bits
        return Data([0x03]) + asn1Length(content.count) + content
    }

    /// Encode a length value in ASN.1 DER format.
    private func asn1Length(_ length: Int) -> Data {
        if length < 128 {
            return Data([UInt8(length)])
        } else if length < 256 {
            return Data([0x81, UInt8(length)])
        } else {
            return Data([0x82, UInt8(length >> 8), UInt8(length & 0xFF)])
        }
    }

    // MARK: - Base64URL

    /// Decode a base64url-encoded string to Data.
    private func base64URLDecode(_ string: String) -> Data? {
        var base64 = string
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        // Pad to a multiple of 4
        let remainder = base64.count % 4
        if remainder > 0 {
            base64 += String(repeating: "=", count: 4 - remainder)
        }
        return Data(base64Encoded: base64)
    }
}

// MARK: - Data Types

/// Result of a successful offline grant verification.
struct VerifiedGrant {
    let agentDID: String
    let principalDID: String
    let scopes: [String]
    let expiresAt: Date
    let jti: String
    let grantId: String
    let depth: Int

    /// Check if a specific scope is present in the grant.
    func hasScope(_ scope: String) -> Bool {
        scopes.contains(scope)
    }
}

/// Snapshot of the Grantex server's JWKS keys.
struct JWKSSnapshot {
    let keys: [[String: Any]]
    let fetchedAt: String
    let validUntil: String
}

/// Ed25519 key pair for signing offline audit entries.
struct OfflineAuditKey {
    let publicKey: String
    let privateKey: String
    let algorithm: String
}

/// A consent bundle containing everything needed for offline authorization.
struct ConsentBundle {
    let bundleId: String
    let grantToken: String
    let jwksSnapshot: JWKSSnapshot
    let offlineAuditKey: OfflineAuditKey
    let checkpointAt: Int
    let syncEndpoint: String
    let offlineExpiresAt: String
}

// MARK: - Errors

/// Grantex authorization errors.
enum GrantexError: Error, CustomStringConvertible {
    case malformedToken(String)
    case blockedAlgorithm(String)
    case unsupportedAlgorithm(String)
    case keyNotFound(String)
    case signatureInvalid
    case tokenExpired(Date)
    case scopeViolation(required: String, granted: [String])
    case bundleTampered(String)
    case networkError(String)
    case keychainError(String)

    var description: String {
        switch self {
        case .malformedToken(let msg): return "Malformed token: \(msg)"
        case .blockedAlgorithm(let alg): return "Blocked algorithm: \(alg)"
        case .unsupportedAlgorithm(let alg): return "Unsupported algorithm: \(alg)"
        case .keyNotFound(let kid): return "Key not found in JWKS snapshot: kid=\(kid)"
        case .signatureInvalid: return "JWT signature verification failed"
        case .tokenExpired(let date): return "Token expired at \(date)"
        case .scopeViolation(let req, let granted):
            return "Missing scope '\(req)' (granted: \(granted.joined(separator: ", ")))"
        case .bundleTampered(let msg): return "Bundle tampered: \(msg)"
        case .networkError(let msg): return "Network error: \(msg)"
        case .keychainError(let msg): return "Keychain error: \(msg)"
        }
    }
}
