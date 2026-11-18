# pardner

The bot of Pardner, a self-hosted messenger for your Claude Code sessions, in development. macOS only.

The daemon runs Claude Code sessions on your Mac through the Claude Agent SDK and obeys one
owner. Its one chat is the relay chat, and no app reads its messages yet.

## Commands

The package provides the `pardner` command, which comes from `npm install -g pardner`. The
[setup guide](https://github.com/duqaXxX/pardner/blob/v{{VERSION}}/docs/setup.md) says which
systems this version supports. `pardner setup` asks for the relay's values, writes the
configuration and pairs the bot; `pardner service install` installs the service that starts the
daemon at login; `pardner update` installs a newer version:

```sh
pardner setup
pardner service install
pardner update
```

## More

- Documentation and source: [github.com/duqaXxX/pardner](https://github.com/duqaXxX/pardner)
- Security model: [SECURITY.md](https://github.com/duqaXxX/pardner/blob/v{{VERSION}}/SECURITY.md)
- License: MIT
