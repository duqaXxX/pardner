# pardner

An agent daemon, a relay and the protocol between them, in development. macOS only.

This repository holds three things:

- the daemon `pardner`, which runs Claude Code sessions on your Mac through the
  [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) and obeys one owner;
- a relay (`src/relay/`) that carries the owner's messages and the daemon's replies, encrypted;
- the protocol the two speak (`src/protocol/`).

## Status

This is version 0.15.0, in development. The daemon's one chat is the relay chat, and no app reads its
messages yet, so a session cannot be started from a message today.
[docs/features.md](docs/features.md) lists what is tested and what is still checked by hand, and
[docs/limits.md](docs/limits.md) what the terminal does and the chat does not.

## Requirements

- macOS 13 or later, on a Mac that stays awake. The daemon runs as a LaunchAgent in your login
  session.
- Claude Code logged in with a claude.ai subscription, and [Node 26.5.1](https://nodejs.org/) or
  later. It can sit beside the Node your terminal uses: see
  [A Node of its own](docs/setup.md#a-node-of-its-own).
- Projects in a folder macOS protects, such as `~/Documents` or `~/Desktop`, need Full Disk
  Access for the daemon.

The steps from the package to a paired daemon are in [docs/setup.md](docs/setup.md).

## Commands

| Command | What it does |
|---|---|
| `!guide` | Explains how the channel works |
| `!bind <folder>` | Binds the channel to a project folder |
| `!status` | Lists the channel's sessions; in a thread, shows that session's details |
| `!stop` | Stops every session of the channel; in a thread, that one |
| `!memory` | Lists the memory files a thread's session loaded |
| `!skills` | Lists the skills a thread's session can use |
| `!terminal` | Moves a thread's session to a terminal on your Mac, a running turn with it |
| `!fork [prompt]` | Copies a thread's session into a new thread, as the terminal's `/fork` does |
| `!resume` | Lists the folder's sessions, the terminal's included, to resume one |
| `!bypass on` / `off` | Switches a session to `bypassPermissions` and back |
| `!plan` / `!plan off` | Switches a session to plan mode and back |
| `!open` | Shares a file of the session's folder into the thread |
| `!diff` | Lists the files the session's git repository changed since HEAD |
| `!rewind` | Goes back to an earlier prompt of the session: restores its code, its conversation or both |
| `!next` | Offers the agent's suggested next prompt to send |
| `!tag <name>` | Tags the thread's first message and the session |
| `!untag` | Takes the tag away |
| `!pin` | Pins the thread's first message |
| `!unpin` | Takes the pin away |
| `!delete-thread` | Deletes the thread, once you confirm |
| `!clean-channel` | Deletes the channel's threads and what sits outside them, once you confirm |
| `!!<command>` | Runs a shell command in the session's folder once you confirm; Claude Code answers its output |
| `!pardner` | Shows the version that runs and the latest; `update` installs the newer one, `restart` restarts |
| `!help` | Lists the commands a session offers |

Some of these words need features the relay chat does not offer yet; [docs/limits.md](docs/limits.md) lists which.

Every command with its answers and limits: [docs/setup.md](docs/setup.md#using-it).

## Security model

The bot obeys the person it was paired with and nobody else. Every message is checked on its own,
and a session starts only in a folder you have trusted in Claude Code. See
[SECURITY.md](SECURITY.md) and the checklist in
[docs/setup.md](docs/setup.md#part-5-security-checklist).

## Documentation

- [docs/setup.md](docs/setup.md): the setup and every command.
- [docs/architecture.md](docs/architecture.md): how the daemon is built.
- [docs/relay-provider.md](docs/relay-provider.md): how the daemon talks through the relay.
- [docs/features.md](docs/features.md): each feature and what verifies it.
- [docs/limits.md](docs/limits.md): what the terminal does and the chat does not, and why.
- [docs/CHANGELOG.md](docs/CHANGELOG.md): what changed.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
