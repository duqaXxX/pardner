// Test-only: the two functions the vector runner takes beside the platform, never inside it.
import Foundation
import JavaScriptCore
import Platform
@testable import ProtocolHost

extension Bridge {
    /// The way to put a private key under a name.
    func importKey(_ store: SoftwareKeyStore) -> JSValue {
        let block = { (a: JSValue, c: JSValue, d: JSValue) -> JSValue in
            let b = Bridge.current()
            return b.result { b.typedArray(try store.importKey(a.toString(), c.toString(), try b.bytes(d))) }
        } as @convention(block) (JSValue, JSValue, JSValue) -> JSValue
        return JSValue(object: block, in: context)
    }

    /// The way to give a recovery its secret: a fresh platform whose person types it.
    func withSecret() -> JSValue {
        let block = { (a: JSValue) -> JSValue in
            let b = Bridge.current()
            do {
                let secret = try b.bytes(a)
                let store = SoftwareKeyStore()
                store.refusesAbsentDelete = true // as the Secure Enclave store does
                return b.platform(CryptoKitPlatform(store: store, person: .typing(secret)))
            } catch { return b.fault("\(error)") }
        } as @convention(block) (JSValue) -> JSValue
        return JSValue(object: block, in: context)
    }
}
