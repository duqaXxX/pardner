# Security

## Reporting a vulnerability

Report it privately through GitHub: the repository's **Security** tab, **Report a
vulnerability**. Do not open a public issue.

## Scope

pardner runs Claude Code on the owner's machine on behalf of one owner, the person its bot was paired with. In scope:

- any path by which someone other than the owner reaches a Claude Code session, an approval, or
  a command;
- secrets (the `.env` values and the bot's keys) written anywhere other than the instance's
  configuration folder (`~/.config/pardner/`, or `~/.config/pardner-<name>/` for a named
  instance), or message content written to a log;
- two instances served by one chat identity, which the daemon refuses at startup;
- an approval request that shows the owner something other than what Approve lets run, or a
  shell command's confirmation that shows something other than what Run runs;
- a shell command (`!!`) that runs without the owner's Run, runs again after an edit of its
  message, or runs on an instance whose `PARDNER_SHELL` is `off`;
- a suggested next prompt (`!next`) sent without the owner's Send, or with words other than the
  ones its offer showed;
- a session started in a folder the owner has not trusted in Claude Code;
- the daemon's own git (the footer, `!status`, `!open`, `!diff`) run in a repository the owner has not
  trusted in Claude Code, or `!diff` run git with an external diff or a text conversion filter: it
  reads the repository with plumbing commands, `--no-ext-diff` and `--no-textconv`, and never
  writes its index.

Out of scope: what Claude Code does once the owner approves it, and whoever controls the owner's
device, who controls the machine by design. [docs/setup.md](docs/setup.md) lists the
settings that protect against that.
