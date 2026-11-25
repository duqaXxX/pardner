// Test-only: the stand-ins of the connection fetch nothing. The app's `RelayLinking` has no default, so a link that forgot `fetch` does not build.
import Foundation
@testable import Relay

extension RelayLinking {
    func fetch(channel: Data, blob: Data) async -> FetchOutcome { .ended }
}
