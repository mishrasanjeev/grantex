// swift-tools-version: 5.9
// The swift-tools-version declares the minimum version of Swift Package Manager required to build this package.

import PackageDescription

let package = Package(
    name: "GrantexGemmaExample",
    platforms: [
        .macOS(.v14),
        .iOS(.v17),
    ],
    targets: [
        .executableTarget(
            name: "GrantexGemmaExample",
            path: "Sources/GrantexGemmaExample"
        ),
    ]
)
