// Test-only: `seal <recipient public key> <info> <plaintext>` (hex) prints the enc and the sealed
// bytes CryptoKit makes, for Node to open: the other direction of the cross-engine seal check.
import Foundation
import Platform

guard CommandLine.arguments.count == 5, CommandLine.arguments[1] == "seal" else {
    FileHandle.standardError.write(Data("usage: vector-tool seal <recipient> <info> <plaintext>\n".utf8))
    exit(2)
}

func hex(_ text: String) -> Data {
    Data((0..<text.count / 2).map { UInt8(text.dropFirst($0 * 2).prefix(2), radix: 16)! })
}

func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

let sealed = try CryptoKitPlatform.hpkeSeal(hex(CommandLine.arguments[2]), hex(CommandLine.arguments[3]), Data(), hex(CommandLine.arguments[4]))
print(hex(sealed.enc), hex(sealed.sealed))
