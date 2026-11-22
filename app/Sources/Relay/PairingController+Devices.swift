// The devices of a person, on the controller's connection (device pairing design 3.4, 3.6, 3.7, 3.9, 3.10): the list the Devices
// screen reads, the add of a device, the join of this Mac as a new device and the removal of devices. Every act and every rest's
// pass runs one at a time on `serially`, so no two paths rebuild the same entry. No view lives here, and no secret is stored.
import Foundation
import ProtocolHost

/// The device log as the last `devices` effect told it (design 4.2).
struct DeviceSnapshot: Sendable {
    struct Device: Sendable {
        let id: Data
        let kind: DeviceKind
        let active: Bool
        let addedBy: Data?
        let position: Int
        let onlyHolderEpochs: Int
        /// The short form the package wrote (design 3.2): the one form the person compares.
        let short: String
    }

    let person: Data
    let length: Int
    let last: Data
    let selfID: Data
    let devices: [Device]

    init?(_ effect: HostValue) {
        guard let person = effect["person"]?.bytesValue, let length = effect["length"]?.numberValue, let last = effect["last"]?.bytesValue,
              let selfID = effect["self"]?.bytesValue, let list = effect["devices"]?.arrayValue else { return nil }
        var devices: [Device] = []
        for item in list {
            guard let id = item["id"]?.bytesValue, let kind = item["kind"]?.stringValue.flatMap(DeviceKind.init(rawValue:)),
                  case .bool(let active)? = item["active"], let position = item["position"]?.numberValue,
                  let short = item["short"]?.stringValue else { return nil }
            devices.append(Device(id: id, kind: kind, active: active, addedBy: item["addedBy"]?.bytesValue, position: Int(position),
                                  onlyHolderEpochs: item["onlyHolder"]?.arrayValue?.count ?? 0, short: short))
        }
        (self.person, self.length, self.last, self.selfID, self.devices) = (person, Int(length), last, selfID, devices)
    }
}

/// A queue of one: the next act starts when the one before it has ended.
struct Gate {
    var busy = false
    var waiters: [CheckedContinuation<Void, Never>] = []
}

extension PairingController {
    // MARK: the one queue

    func serially<T: Sendable>(_ work: () async throws -> T) async rethrows -> T {
        if gate.busy {
            await withCheckedContinuation { gate.waiters.append($0) } // the finishing act hands `busy` over, so none slips in between
        } else {
            gate.busy = true
        }
        defer {
            if gate.waiters.isEmpty { gate.busy = false } else { gate.waiters.removeFirst().resume() }
        }
        return try await work()
    }

    // MARK: what the new device is given (design 3.1)

    /// The relay's address, its key and the person id, as the three values `pardner setup` asks for; nil until this Mac is paired.
    public func handoffValues() -> PairingHandoff? {
        guard let state = stored, state.stage == .paired, let person = state.person else { return nil }
        return PairingHandoff(relayAddress: state.relay.address, relayKey: StoreDisk.hex(state.relay.key), person: StoreDisk.hex(person))
    }

    // MARK: adding a device (design 3.4, 3.6)

    /// Reads a pasted pairing string and runs the checks of design 3.4; the person then confirms the candidate it shows.
    public func inspect(pairingString text: String) async -> Result<DeviceCandidate, DeviceRefusal> {
        guard stored?.stage == .paired, let host, let link, snapshot != nil else { return .failure(.notReady) }
        do {
            switch try await host.inspectPairingString(text) {
            case .notAString: return .failure(.notAPairingString)
            case .badName: return .failure(.badName)
            case .read(let device, let proof, let name, let short):
                switch try await link.build(.check(device: device, proof: proof)) {
                case .checked:
                    return .success(DeviceCandidate(kind: device["kind"]?.stringValue.flatMap(DeviceKind.init(rawValue:)) ?? .app, name: name, shortForm: short, device: device, proof: proof))
                case .refused(let why): return .failure(Self.refusal(why))
                case .built: return .failure(.failed("the link built an entry for a check"))
                }
            }
        } catch {
            return .failure(.failed(Problem.reason(error)))
        }
    }

    private static func refusal(_ why: String) -> DeviceRefusal {
        switch why {
        case "proof": .otherPerson
        case "named": .alreadyAdded
        case "busy", "ended": .notReady
        default: .failed(why)
        }
    }

    /// Builds and signs the add, writes it pending with the device's label (flushed), then sends it (design 3.6, steps 1 and 2). Nil when it was
    /// written, whatever the relay answers: the pass of each rest carries it from there.
    public func confirmAdd(_ candidate: DeviceCandidate) async -> DeviceRefusal? {
        await serially {
            guard stored?.stage == .paired, let host, let link, var state = stored, snapshot != nil else { return .notReady }
            guard state.pending == nil else { return .entryPending }
            guard state.removal == nil else { return .removalRunning } // a pending add does not hold a removal back, and an add does not start behind one (3.9)
            let read: DeviceEntryRead
            do {
                guard try await host.nameFits(candidate.name) else { return .badName } // the label is stored: it is checked again, whoever made the candidate
                switch try await link.build(.add(device: candidate.device, proof: candidate.proof)) {
                case .refused(let why): return Self.refusal(why)
                case .checked: return .failed("the link checked an add and built nothing")
                case .built(let entry):
                    read = try await host.readDeviceEntry(entry.signed)
                    (state.pending, state.labels[read.device], pendingAddDevice) = (entry, candidate.name, read.device)
                    guard save(state) else { return .failed("the pairing could not be written") }
                    deviceList.notice = nil
                    publish()
                }
            } catch {
                return .failed(Problem.reason(error))
            }
            await submitPending(kind: read.kind, device: read.device)
            publish()
            return nil
        }
    }

    // MARK: the pass of a rest (design 3.6, 3.9)

    /// At every rest and every launch: seen times, the pending entry read back, sent again or rebuilt, then the removal's next step.
    func settle() async {
        await serially {
            guard stored?.stage == .paired, let snap = snapshot, link != nil else { return }
            guard recordSeen(snap), absorbJoiners(snap) else { return }
            await resolvePending(snap)
            if stored?.pending == nil { await advanceRemoval(snap) }
            publish()
        }
    }

    func devicesRead(_ effect: HostValue) async {
        guard let snap = DeviceSnapshot(effect) else { return await hostFaulted("the package gave a device list that does not read") }
        snapshot = snap
        if stored?.stage == .paired, stored?.device == nil { recordDevice(snap) }
        if stored?.stage == .joining { await completeJoin(snap) }
        if stored?.stage == .paired { await settle() }
    }

    /// A paired store without its device id gets it at the first read that lists this device. Bookkeeping: a failed write changes no phase and the next read tries again.
    private func recordDevice(_ snap: DeviceSnapshot) {
        guard var state = stored, snap.devices.contains(where: { $0.id == snap.selfID && $0.active }) else { return }
        state.device = snap.selfID
        guard (try? pairing.write(state)) != nil else { return }
        stored = state
    }

    /// The time this Mac first read each device's add, kept in the pairing store so no other device can forge it (design 3.9).
    private func recordSeen(_ snap: DeviceSnapshot) -> Bool {
        guard var state = stored else { return false }
        let fresh = snap.devices.filter { state.seen[$0.id] == nil }
        guard !fresh.isEmpty else { return true }
        let now = clock().timeIntervalSince1970
        for device in fresh { state.seen[device.id] = now }
        return save(state)
    }

    private func resolvePending(_ snap: DeviceSnapshot) async {
        guard let host, var state = stored, let pending = state.pending else { return pendingAddDevice = nil }
        let read: DeviceEntryRead
        do { read = try await host.readDeviceEntry(pending.signed) } catch is EntryRefused {
            return dropPending() // bytes that read as neither: nothing to keep
        } catch {
            return // the host failed, not the entry: it stays kept (design 3.6)
        }
        pendingAddDevice = read.kind == .add ? read.device : nil
        let named = snap.devices.first { $0.id == read.device }
        // The log already shows the entry's effect: the device is named (an add) or is not active (a remove), and the entry is read back (step 3 and 4).
        let landed = read.kind == .add ? named != nil : named?.active != true
        if landed || snap.last == pending.id { return dropPending() }
        if acceptedOn == connectionID { return } // sent and accepted on this connection: it lands, the next rest reads it
        if snap.length > read.seq || (snap.length == read.seq && snap.last != read.prev) { // its position is taken: it can never land
            let act: DeviceAct
            switch read.kind {
            case .add:
                guard let keys = read.keys, let proof = read.proof else { return dropPending() }
                act = .add(device: keys, proof: proof)
            case .remove: act = .remove(target: read.device)
            }
            guard let link else { return }
            switch try? await link.build(act) {
            case .built(let entry)?:
                state.pending = entry
                guard save(state) else { return }
                heldAtLength = nil
            case .refused("busy")?, .refused("ended")?, nil: return
            default: return dropPending(notice: read.kind == .add ? .addRefused(subject(read.device, snap)) : nil)
            }
        } else if let held = heldAtLength, snap.length <= held {
            return // the relay said `position`: the log it holds is not here yet
        }
        await submitPending(kind: read.kind, device: read.device) // a rebuilt entry names the same device and does the same
    }

    /// `leaving`: a device the log refused to remove, which goes out of the act so that no rest builds it again.
    private func dropPending(notice: DevicesNotice? = nil, leaving: Data? = nil) {
        guard var state = stored else { return }
        state.pending = nil
        pendingAddDevice = nil
        if let leaving, var act = state.removal {
            act.devices.removeAll { $0 == leaving }
            if !act.left.contains(leaving) { act.left.append(leaving) }
            state.removal = act.devices.isEmpty ? nil : act
        }
        guard save(state) else { return }
        (acceptedOn, heldAtLength) = (nil, nil)
        if let notice { deviceList.notice = notice }
    }

    /// Sends the pending entry as it is kept (design 3.6, steps 2 to 6).
    private func submitPending(kind: DeviceEntryRead.Kind, device: Data) async {
        guard let link, let pending = stored?.pending else { return }
        let named = subject(device, snapshot)
        let outcome: SubmitOutcome
        do { outcome = try await link.submit(kind: 1, signed: pending.signed, sig: pending.sig) } catch RelayError.invalidItem {
            return dropPending(notice: .entryInvalid(named))
        } catch {
            return // the connection is ending: the entry stays kept for the next rest
        }
        switch outcome {
        case .code(0): acceptedOn = connectionID
        case .code(2): heldAtLength = snapshot?.length
        case .code(1):
            if kind == .add { dropPending(notice: .addRefused(named)) } else { dropPending(notice: .removeRefused(named), leaving: device) }
        case .code(5): await markRemoved()
        default: break // not answered, busy or ended: the same bytes go again at the next rest
        }
    }

    // MARK: removing devices (design 3.9, 3.10)

    /// The confirmation a Remove opens: every active device but this Mac, newest first, the clicked one chosen.
    public func removalChoices(clicked: Data) -> [RemovalChoice] {
        deviceList.removalChoices(clicked: clicked)
    }

    /// Stores the act and starts it: the clicked device first, then the others newest first. A pending add not yet read back is dropped.
    public func confirmRemoval(chosen: [Data], clicked: Data) async -> RemovalRefusal? {
        await serially {
            guard stored?.stage == .paired, link != nil, var state = stored, let snap = snapshot else { return .notReady }
            guard !chosen.isEmpty else { return .nothingChosen }
            guard !chosen.contains(snap.selfID) else { return .thisMac }
            let active = Dictionary(uniqueKeysWithValues: snap.devices.filter(\.active).map { ($0.id, $0.position) })
            guard chosen.allSatisfy({ active[$0] != nil }) else { return .notActive }
            guard state.removal == nil else { return .running }
            let first = chosen.contains(clicked) ? [clicked] : []
            let rest = chosen.filter { $0 != clicked }.sorted { (active[$0] ?? 0) > (active[$1] ?? 0) }
            state.removal = PairingRemoval(devices: first + rest, length: snap.length)
            if let pending = state.pending, let host, let read = try? await host.readDeviceEntry(pending.signed), read.kind == .add {
                state.pending = nil // an add not yet read back does not hold a removal back; it may still land, and the list shows it
                pendingAddDevice = nil
                (acceptedOn, heldAtLength) = (nil, nil)
            }
            guard save(state) else { return .failed("the pairing could not be written") }
            deviceList.notice = nil
            if state.pending == nil { await advanceRemoval(snap) } // a remove already pending is read back first
            publish()
            return nil
        }
    }

    /// Devices added after the act began, and not by this Mac, join it (design 3.9, step 3): read at every rest, whether or not an entry is pending.
    private func absorbJoiners(_ snap: DeviceSnapshot) -> Bool {
        guard var state = stored, var act = state.removal else { return true }
        let known = Set(act.devices + act.left)
        let joiners = snap.devices.filter { $0.active && $0.position >= act.length && $0.addedBy != snap.selfID && !known.contains($0.id) }
            .sorted { $0.position > $1.position }.map(\.id)
        guard !joiners.isEmpty else { return true }
        act.devices.insert(contentsOf: joiners, at: min(1, act.devices.count)) // newest first, behind the device the person clicked
        state.removal = act
        return save(state)
    }

    /// The next step of the act: a device gone is done, and it ends on a log read back that shows none of its devices active.
    private func advanceRemoval(_ snap: DeviceSnapshot) async {
        guard var state = stored, let act = state.removal else { return }
        let active = Set(snap.devices.filter(\.active).map(\.id))
        guard let target = act.devices.first(where: { active.contains($0) }) else {
            state.removal = nil
            _ = save(state)
            return
        }
        guard let link else { return }
        guard case .built(let entry)? = try? await link.build(.remove(target: target)) else { return } // busy or stale: the next rest decides again
        state.pending = entry
        guard save(state) else { return }
        pendingAddDevice = nil
        await submitPending(kind: .remove, device: target)
    }

    // MARK: joining as a new device (design 3.7)

    /// Steps 1 and 2: the form is checked, `keys-made` is written, then the keys, the proof (signed once) and `joining`; the connection runs with the proof alone.
    /// Throws a `PairingInputError` before anything is written; any other error after the attempt was erased.
    public func join(address: String, relayKey: String, person: String, name: String) async throws {
        guard case .unpaired = phase else { throw PairingInputError.notReady }
        let relay = try Self.relay(address: address, key: relayKey)
        guard let personID = Self.hexBytes(person, 32) else { throw PairingInputError.person }
        let host = try await hostMade() // the name's check is the package's, so it runs before anything is written
        guard try await host.nameFits(name) else { throw PairingInputError.name }
        guard case .unpaired = phase else { throw PairingInputError.notReady }
        phase = .settingUp
        cancelRequested = false
        var state = PairingState(stage: .keysMade(.join), relay: relay, person: personID)
        do {
            try pairing.write(state) // before the keys, as for a first device
            _ = try keys.make(Self.signName, .sign)
            _ = try keys.make(Self.receiveName, .receive)
            guard !cancelRequested else { return await abandon() }
            let proof = try await host.makePairingProof(person: personID, device: try deviceValue())
            guard !cancelRequested else { return await abandon() }
            state.stage = .joining
            (state.proof, state.name) = (proof, name)
            try pairing.write(state)
            stored = state
            let info: JoiningInfo
            do {
                info = try await joiningInfo(state) // before the connection: nothing it tells can land during this wait
            } catch {
                phase = .fault(.joinUnmade, PairingPhase.joinUnmadeAdvice) // `joining` is on disk: Retry resumes it, and Pair again starts over
                throw error
            }
            do {
                guard !cancelRequested else { return await abandon() }
                try await startConnection(state, enrolment: nil)
            } catch {
                // `joining` is on disk: Retry resumes it
                phase = .fault(.failed, Problem.sentence("Pardner could not connect to the relay", error, next: "Retry: joining goes on where it stopped."))
                throw error
            }
            guard !isShutDown else { return }
            guard !cancelRequested else { return await abandon() } // a cancel asked during the awaits above is honoured
            phase = .joining(info) // nothing awaited since the connection started: its first event finds this phase
        } catch let error where stored?.stage != .joining {
            self.host = nil // a host that failed is over for good: the next join makes its own
            await abandon()
            throw error
        }
    }

    func deviceValue() throws -> HostValue {
        .object(["kind": .string("app"), "signing": .bytes(try keys.publicKey(Self.signName)), "receiving": .bytes(try keys.publicKey(Self.receiveName))])
    }

    /// The string and the short form a joining screen shows, made again from the kept proof: the same bytes at every launch.
    func joiningInfo(_ state: PairingState) async throws -> JoiningInfo {
        guard let proof = state.proof, let name = state.name else { throw PairingFault(description: "the pairing at joining holds no proof or name") }
        let host = try await hostMade()
        let text = try await host.pairingString(device: try deviceValue(), proof: proof, name: name)
        guard case .read(_, _, _, let short) = try await host.inspectPairingString(text) else { throw HostError.faulted("the package refused its own pairing string") }
        let info = JoiningInfo(pairingString: text, shortForm: short, waiting: false, name: name)
        joiningScreen = info
        return info
    }

    func waitForAdd() {
        guard var info = joiningScreen, !info.waiting, case .joining = phase else { return }
        info.waiting = true
        joiningScreen = info
        phase = .joining(info)
    }

    /// Step 4: the log is served; this Mac is paired only when it holds this device's add. Entry 0 being the given person is the link's own check.
    private func completeJoin(_ snap: DeviceSnapshot) async {
        guard var state = stored, state.stage == .joining else { return }
        guard snap.person == state.person, snap.devices.contains(where: { $0.id == snap.selfID && $0.active }) else {
            await stopConnection()
            phase = .fault(.joinMismatch, PairingPhase.joinMismatchAdvice)
            return
        }
        state.stage = .paired
        state.device = snap.selfID
        mayHoldUnnamedEarlier = false
        state.proof = nil // the name stays for good: the link takes it as this device's name while none is pending or read, so a restart before it is written still sends it
        guard save(state) else { return }
        joiningScreen = nil
        phase = .paired
    }

    // MARK: what is stored and what is shown

    /// Writes the pairing whole; a failed write is a fault the screen names, and the state in memory stays the one on disk.
    func save(_ state: PairingState) -> Bool {
        do {
            try pairing.write(state)
        } catch {
            phase = .fault(.failed, Problem.sentence("Pardner could not save the pairing", error, next: PairingPhase.retryAdvice))
            return false
        }
        stored = state
        return true
    }

    private func subject(_ id: Data, _ snap: DeviceSnapshot?) -> DeviceSubject {
        if let name = shownDeviceNames[id] ?? stored?.labels[id] { return .label(name) }
        guard let device = snap?.devices.first(where: { $0.id == id }) else { return .unknown }
        return .shortForm(device.kind, device.short)
    }

    func publish() {
        guard let snap = snapshot, let state = stored else { return }
        let removal = state.removal
        let active = Set(snap.devices.filter(\.active).map(\.id))
        var list = deviceList
        list.rows = snap.devices.sorted { $0.position > $1.position }.map { device in
            let adder: DeviceAdder
            switch device.addedBy {
            case nil: adder = .none
            case let by? where active.contains(by): adder = .device(by)
            default: adder = .removedDevice
            }
            return DeviceRow(
                id: device.id, kind: device.kind, label: shownDeviceNames[device.id] ?? state.labels[device.id], shortForm: device.short, adder: adder,
                position: device.position, active: device.active, isThisMac: device.id == snap.selfID,
                seenAt: state.seen[device.id].map { Date(timeIntervalSince1970: $0) }, onlyHolderEpochs: device.onlyHolderEpochs,
                addedWhileRemoving: removal.map { $0.devices.contains(device.id) && device.position >= $0.length && device.addedBy != snap.selfID } ?? false,
                isEarlierKeys: device.active && device.id == state.earlier)
        }
        list.pendingEntry = state.pending != nil
        list.pendingAddName = state.pending == nil ? nil : pendingAddDevice.flatMap { state.labels[$0] }
        list.removing = removal?.devices.filter { active.contains($0) } ?? []
        let times = list.rows.compactMap(\.seenAt)
        list.seenTogether = Dictionary(grouping: times, by: { $0 }).values.contains { $0.count > 1 }
        if list != deviceList { deviceList = list }
    }
}
