# Setup

This guide takes a Mac from installing the package to a daemon paired with a relay. It covers the
relay's values, the configuration pardner reads, how it starts on macOS, and the security
settings the design relies on.

Status: an early release (0.x); [CHANGELOG.md](CHANGELOG.md) lists each one, and
[features.md](features.md) what is tested and what is still checked by hand. The daemon's one chat
is the relay chat, which is in development: no app reads its messages yet
([relay-provider.md](relay-provider.md)).

The install is one numbered sequence that runs through Parts 0 to 4 ([A relay on this Mac](#a-relay-on-this-mac)
between Parts 0 and 1 has no numbered steps). Three checkpoints in it say
what to run and what you should see, so a wrong turn shows up where it happened. Part 5 is the
security checklist. [Part 6](#part-6-a-second-instance) adds a second daemon on the same Mac, with
a relay pairing of its own and, if you want, a Claude Code login of its own, and has a checkpoint of
its own. "Using it" describes the daily use, and the reference at the end holds the detail the
sequence leaves out.

## Requirements

- macOS 13 or later, with a user account that stays logged in on the machine that runs the
  sessions. The floor is Claude Code's (its system requirements, read 2026-10-12); pardner
  itself has been run on macOS 27 only. The Mac has to stay awake: a sleeping machine answers
  nothing until it wakes.
- Claude Code installed and logged in with a claude.ai subscription: run `claude`, then `/login`.
  The 5-hour and weekly usage figures in the status footer exist only with a subscription.
- [Node.js](https://nodejs.org/) 26.5.1 or later, which brings `npm`. It does not have to be the
  Node your terminal uses: see [A Node of its own](#a-node-of-its-own).
- A relay to pair the bot with: its address as `host:port`, its public key, and your person id
  (Part 1); [A relay on this Mac](#a-relay-on-this-mac) runs one.
- Full Disk Access for the Node executable that runs pardner, only if your projects
  live in a folder macOS protects, such as `~/Documents` or `~/Desktop`. Without it a session
  there fails to start. The step is under [Folders macOS protects](#folders-macos-protects).

## A Node of its own

pardner needs one Node, 26.5.1 or later, and the service of Part 4 runs on it. That Node can sit
beside the one your terminal uses for everything else, so trying pardner changes nothing for your
other projects. On a Node older than 26.5.1, `pardner` ends at once with status 1 and a line that
points here.

The service runs the Node that was first on the `PATH` of the command that installed it: `pardner
service install` writes that Node's path into the plist (Part 4, "Install the service"). So the
Node to use is the one you install the package and the service with, whatever your shell's default
is.

With [nvm](https://github.com/nvm-sh/nvm), whose README gives `nvm install`, `nvm exec` and
`nvm which` (read 2026-10-17):

```bash
nvm install 26
nvm exec 26 -- npm install -g pardner
nvm exec 26 -- pardner --version
nvm exec 26 -- pardner service install
```

`nvm install 26` installs the latest 26.x beside your other versions. `nvm exec 26 -- <command>` runs
one command in a subshell with that version first on the `PATH`, which leaves your shell as it was.
Global npm packages belong to the Node that installed them (nvm's `NVM_BIN` is where the active
version's Node, npm and global packages live), so `pardner` is installed for 26 only and the
command is not on your default Node's `PATH`. Put an alias for it in your shell profile:

```bash
alias pardner='nvm exec --silent 26 -- pardner'
```

`--` stops nvm reading the arguments as its own: without it, `--help`, `-h` or `help` anywhere in
the command prints nvm's help and pardner never starts (the `nvm` function in `nvm.sh`, v0.39.7
to v0.40.3, read 2026-11-01; nvm's own help documents `--silent` and not `--`). `--silent` drops the
`Running node ...` line from the output of every command.

`nvm which 26` prints the path of that Node, which `ProgramArguments` in the plist names. When 26
is the first version nvm installs, nvm also makes it the default of new shells; `nvm alias default
<version>` sets another.

With nvm that path holds the version folder (`.../v26.x.y/bin/node`). When you remove that version,
or replace it with a newer 26.x, the service stops starting. Run `nvm exec 26 -- pardner service
uninstall`, then `nvm exec 26 -- pardner service install` again, with the version that is installed.

Without nvm, unpack an official archive from [nodejs.org/dist](https://nodejs.org/dist/) (each
release folder lists the macOS archives and a `SHASUMS256.txt` to check them against) into a
folder of your own, and put its `bin` first on the `PATH` of each command. npm's global prefix
defaults to the location where Node is installed (npm's documentation of
[folders](https://docs.npmjs.com/cli/v10/configuring-npm/folders), read 2026-10-17), so the package
goes into that folder too:

```bash
PATH="<folder>/bin:$PATH" npm install -g pardner
PATH="<folder>/bin:$PATH" pardner service install
```

The same warning holds: the plist records the path of that folder's Node, so moving or deleting the
folder stops the service until you uninstall and install it again. A Node installed with Homebrew
is not covered here.

## Part 0: install

1. Install the command from the npm registry:

   ```bash
   npm install -g pardner
   ```

That puts the `pardner` command in the `bin` folder of npm's global prefix (`npm prefix -g`) and
the package beside it, in `lib/node_modules/pardner`; the service of Part 4 runs that copy. When
npm answers `EACCES`, your user cannot write to that prefix: npm's page
[Resolving EACCES permissions errors](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally)
gives the remedies. To install on a Node other than your terminal's default, see
[A Node of its own](#a-node-of-its-own). To update, see
[Updating pardner](#updating-pardner). To run a copy built from the repository
instead, see [CONTRIBUTING.md](../CONTRIBUTING.md).

pardner runs the Claude Code CLI that ships inside the Claude Agent SDK it depends on,
not the `claude` on your `PATH`. Both read the same login, so logging in once with `claude` and
`/login` covers both.

### Checkpoint 1: the command is installed

```bash
command -v pardner
pardner --version
```

The first prints the command's path, which ends in `bin/pardner`; the second the version
installed, such as `0.1.0`, without starting anything. If the first prints nothing, the `bin`
folder of npm's global prefix is not on your `PATH`: add `$(npm prefix -g)/bin` to it in your
shell profile and open a new terminal. Running `pardner` now, before `.env` exists, ends at
once with `ERROR pardner.main:` and a line that says `.env` does not exist and gives the address
of Part 2 of this guide, and exit status 1. On a Node older than 26.5.1 the same command ends with
a line that starts `ERROR pardner.main: pardner needs Node 26.5.1 or later and this is Node`,
followed by the version found and the address of [A Node of its own](#a-node-of-its-own), and also
with status 1: install a newer Node, beside the one you have if you like.

## A relay on this Mac

Skip this part when someone else runs your relay: you need only its three values (Part 1). A relay
is a program of its own, with its own folder and its own process; the commands below start it from
the `pardner` command. This part has no numbered steps, so the steps of Parts 1 to 6 keep their
numbers. A relay that starts at login, as a service, is not part of this release.

Make the relay's folder once:

```bash
pardner relay init
```

It makes `~/.local/share/pardner-relay` (and `~/.local/share` with mode `0700` when that folder
does not exist), sets the Time Machine exclusion on it, and prints its two values, once, then
`the relay is made`:

```text
relay public key: <130 hex digits>
enrolment secret: <64 hex digits>
the relay is made
```

The public key is `RELAY_KEY` of Part 1. The enrolment secret is what the first device presents to
enrol; the relay keeps only its hash, so keep the printed value: nothing prints it again. `init`
refuses a folder that already holds a relay. The exclusion call (`tmutil addexclusion`) took 11
seconds on a Mac mini running macOS 27.2.1 (2026-11-19), so `init` can wait that long before it
prints.

Serve it in the foreground:

```bash
pardner relay serve --listen 0.0.0.0:4433
```

The relay logs to the terminal; `listening on port 4433` says it accepts connections. The address a
device connects to (`RELAY_ADDRESS` of Part 1) is the one that device can reach: `127.0.0.1` serves
this Mac alone. `Ctrl-C` or `SIGTERM` to `pardner` stops the relay. If `pardner` is killed with
`SIGKILL`, the relay keeps serving as an orphan and holds the folder's lock, so a second `serve`
exits with `another relay holds the directory`: find the relay's process with
`pgrep -f 'relay/main'` and send it `SIGTERM`.

`--instance <name>` gives a relay of its own, with the folder `~/.local/share/pardner-relay-<name>`.
It names a relay only: `PARDNER_INSTANCE`, which picks one of the daemons, does not apply to
`pardner relay`.

The person id (`RELAY_OWNER`) comes from a device, not from the relay. No device can pair until the
app does, and the app is not released, so today a relay started here has no one to serve.

## Part 1: the relay's values

The daemon's chat is the relay chat: the bot talks through a relay, and the relay chat is the
only chat this build holds. Nothing selects it. Collect three values before Part 2; the setup asks
for them and pairs the bot with them.

2. Note the relay's values and your own:

   - the relay's address, as `host:port` (`RELAY_ADDRESS`), for example `127.0.0.1:4433`;
   - the relay's public key (`RELAY_KEY`): 130 hex digits that start with `04` and name a point
     of the P-256 curve;
   - your person id (`RELAY_OWNER`): 64 hex digits. The bot obeys the person with this id and
     nobody else.

After the file is written, the setup makes the bot's own keys, pairs the bot with the relay and
the person id, and prints the string your device adds on its side. The bot's keys stay in the
instance's configuration folder (Part 2).

## Part 2: configuration

pardner keeps its files in `~/.config/pardner/` (a named instance has a folder of its own, see
[Part 6](#part-6-a-second-instance)). `.env` is the one you write;
`state.json` is written by pardner and never needs editing (what it holds is under
[The config directory and `state.json`](#the-config-directory-and-statejson)).

pardner refuses to start when `.env` is readable by anyone else, is a symbolic link, or
belongs to another user. It also refuses a missing variable, named in the message, a
`RELAY_ADDRESS` that is not `host:port`, and an `ALLOWED_ROOT` that is not an absolute path (or
one starting with `~/`) or is not a directory.

3. Let `pardner setup` write the file, or write it by hand (step 4 below):

   ```bash
   pardner setup
   ```

   In a terminal, it first asks which agent to use, as a numbered list: type a number and press Enter, or press
   Enter alone for the first, which is the default (a list of one name is still shown).
   It then says what the pairing needs and asks, in this order:

   - the relay's address (`RELAY_ADDRESS`), as `host:port`.
   - the relay's public key (`RELAY_KEY`): 130 hex digits that name a point of the P-256 curve.
   - your person id (`RELAY_OWNER`): 64 hex digits.
   - the folder your projects live under (`ALLOWED_ROOT`), by the rule the daemon applies when it
     starts.
   - two questions about Claude Code: how long a command may run, in hours
     (`BASH_DEFAULT_TIMEOUT_MS`; Enter means 4, a number of hours with a dot for decimals such
     as `1.5`, from 0.02 (72 seconds) to 596.5), written in milliseconds, and the folder of a login of its own
     (`CLAUDE_CONFIG_DIR`, skipped with Enter, absolute or starting with `~/`; it need not exist
     yet, see [Part 6](#an-instance-with-its-own-claude-code-login)). A skipped one is not
     written. The 4 hours replace the 30 minutes after which Claude Code stops a command left in
     the background, and the 2 minutes a command in the foreground is waited for (the
     `BASH_DEFAULT_TIMEOUT_MS` paragraph below).

   Each answered question is replaced by one line, with the check's verdict:

   ```text
   ? Folder your projects live under (ALLOWED_ROOT): ~/code   ✔
   ? Bash command timeout in hours (BASH_DEFAULT_TIMEOUT_MS, Enter for 4): 4   ✔ 14400000 ms
   ```

   The pick comes first and is written as `PARDNER_AGENT`:

   ```text
   ? Agent (PARDNER_AGENT): claude   ✔
   ```

   The questions that follow are those of the relay chat and of the agent you picked.

   Before it writes, it lists every variable the file will hold.

   A refused answer prints `   ✖` and the reason on its line, and the question is asked again.

   It then writes `~/.config/pardner/.env` readable by you only (a named instance writes its
   own folder: `pardner setup --instance work`, see [Part 6](#part-6-a-second-instance)),
   pairs the bot with the relay and prints `Paired. Add this device on your side with:` and the
   string your device adds, and on macOS asks whether to install the service now (a list: Yes, No), which is `pardner service install` for that
   instance. Ctrl-C, or Ctrl-D on an empty line, at any question before the write ends it with nothing written; at
   the service question the file is already written and stays.

   `pardner setup` refuses before it asks anything when `.env` exists already (it never
   overwrites one) and when stdin or stdout is not a terminal. The pairing is the last step, so
   ending the setup before the file is written leaves no keys. If the pairing fails, the file is
   written: move it away, then run setup again. On Windows, Node ignores the file modes, so the
   file is not restricted to you there.

   By hand instead, create the directory and the file, readable by you only:

   ```bash
   mkdir -p ~/.config/pardner
   touch ~/.config/pardner/.env
   chmod 600 ~/.config/pardner/.env
   ```

4. Open the file in an editor (`nano ~/.config/pardner/.env` works) and write the
   variables, one `NAME=value` per line. Replace each `<...>` placeholder, brackets included,
   with the value from Part 1:

   ```
   RELAY_ADDRESS=<host:port>
   RELAY_KEY=<public key>
   RELAY_OWNER=<person id>
   ALLOWED_ROOT=~/code
   ```

   A file written by hand holds no pairing: the bot refuses to start until the pairing exists, so
   run `pardner setup` for an instance that has no `.env` yet.

The `RELAY_*` variables are the relay chat's; the others belong to the daemon.

| Variable | Value |
|---|---|
| `RELAY_ADDRESS` | the relay's address as `host:port` |
| `RELAY_KEY` | the relay's public key, 130 hex digits |
| `RELAY_OWNER` | your person id, 64 hex digits; the setup pairs the bot with it and prints the string your device adds |
| `ALLOWED_ROOT` | the directory `/bind` accepts paths under, for example `~/code` |
| `PARDNER_AGENT` | optional: the agent pardner drives; `claude` when absent, the only one this release has |
| `PARDNER_SHELL` | optional: `on` or `off`, whether `!<command>` runs your shell commands; `on` when absent |

`PARDNER_AGENT` can be set or left out: a file without it works as one with `claude`. A value
pardner does not know stops the start, and the message lists the valid ones. A variable that
belongs to a module you did not select is not read. The chat is not selected by a variable: the
relay chat is the only one.

The bot's start is checked against the pairing: `RELAY_OWNER` and `RELAY_KEY` must be the ones the
bot was paired with, or the start stops and the message says so. A `.env` that no longer matches
the pairing, or a relay that was put back from an older copy, is fixed by moving the instance's
`.env` away and running setup again.

The variables of the Claude Code module, the agent this release has, are read only when it is the
selected agent:

| Variable | Value |
|---|---|
| `BASH_DEFAULT_TIMEOUT_MS` | optional: Claude Code's own variable, in milliseconds, for how long a command may run; see below |
| `CLAUDE_CONFIG_DIR` | optional: Claude Code's own variable, the folder of a login of its own, for an instance that drives a second account; see [Part 6](#an-instance-with-its-own-claude-code-login) |

`BASH_DEFAULT_TIMEOUT_MS` is a variable of Claude Code, which pardner hands to every session as
you wrote it. In a session started through the Agent SDK, Claude Code stops a command left
running in the background after 30 minutes, where a terminal session lets it run. A value above
`1800000` replaces those 30 minutes, up to 24.8 days: `BASH_DEFAULT_TIMEOUT_MS=14400000` gives a
dev server or a long build 4 hours. The same value becomes how long a command in the foreground
may run before Claude Code stops waiting for it, 2 minutes when the variable is absent. Claude
Code reads the value and decides what an invalid one means. `pardner setup` checks the hours
it asks for; the daemon does not check the value in the file.

`CLAUDE_CONFIG_DIR` is a variable of Claude Code too, and pardner reads it as well: it looks in
that folder for Claude Code's trust record, its Chrome setting and the transcripts of the
sessions. It is an absolute path, or starts with `~/`, and a relative one stops the start with
`CLAUDE_CONFIG_DIR must be an absolute path, or one starting with ~/; it is "<value>"` (when
the value comes from pardner's own environment and not from `.env`, the name is followed by
`, set in the daemon's environment and not in .env,`). When the
file leaves it out, the variable in pardner's own environment applies, and when that is absent
too, Claude Code's usual `~/.claude` and `~/.claude.json`.

`PARDNER_SHELL=off` turns `!<command>` off for the instance: the word then answers ``Shell
commands are turned off for this instance (`PARDNER_SHELL`).`` and `/help` and `/guide` leave it
out. Any value other than `on` or `off`, in any case, stops the start with `PARDNER_SHELL must
be on or off; it is "<value>"`, so a mistyped `off` never leaves the commands on.

`ALLOWED_ROOT` guards against a typo such as `/bind /`. It is not a security boundary:
Claude Code can read and run outside its working directory once you approve it.

How the file is read:

- One `NAME=value` per line, with `export ` allowed in front. A value may be in single or double
  quotes. In an unquoted value a `#` starts a comment even with no space before it, so quote a
  value that holds one.
- Inside quotes a backslash is kept as written, except that `\n` in double quotes becomes a line
  break. `\t` and `\\` stay two characters, and a quote after a backslash still ends the value,
  so write a value that holds a quote in the other kind of quotes.
- A value is trimmed, and a variable with an empty value counts as missing.
- `${NAME}` and `${NAME:-default}` inside a value become the value of `NAME` defined above in the
  same file, else the one in pardner's own environment, else the default, else nothing.
  `$NAME` without braces stays as written.
- `ALLOWED_ROOT` is an absolute path, or starts with `~/`, which becomes your home directory. A
  relative path is refused, since launchd starts pardner in `/` and a terminal in its own folder.
  It must name a directory that exists once links are followed; the message shows the path it
  resolved to.
- The `.env` of a repository is never read. `BASH_DEFAULT_TIMEOUT_MS` and `CLAUDE_CONFIG_DIR` are
  handed on to the Claude Code sessions pardner starts. Of the file's values, `CLAUDE_CONFIG_DIR`
  is the one pardner also puts in its own process environment, once, at start: the Agent SDK
  finds a folder's sessions through the environment of the process and has no other way to be
  told where Claude Code keeps them. The other value pardner puts there is not from the file:
  `PARDNER_INSTANCE`, the instance's name ([Part 6](#choosing-the-instance-a-command-is-about)).

### Checkpoint 2: the daemon reads `.env` and starts

Run the daemon in the foreground once, before the LaunchAgent exists:

```bash
pardner
```

The daemon dials the relay and stays running. Each line of the log starts
with the local date and time, then the level and the name of the part that wrote it. Press Ctrl-C
to stop it: it logs `shutting down` and exits. A problem in `.env` ends the start at once with a
line that holds `ERROR pardner.main:` and ends with what to fix, for example:

```
2026-10-10 09:05:03,042 ERROR pardner.main: RELAY_ADDRESS: write the address as host:port, for example 127.0.0.1:4433.
```

and exit status 1. `another pardner is running` means another daemon of the same instance
holds the lock: stop it first. Leave no foreground run going when you start the LaunchAgent in
Part 4.

## Part 3: Claude Code

pardner drives Claude Code through the Claude Agent SDK, with the login already on the
machine. Your own Claude Code settings apply: `~/.claude/settings.json`, the project's
`.claude/settings.json`, and `.claude/settings.local.json`. Whatever Claude Code asks your
approval for reaches the chat as an approval request, with the tool's whole input.

5. Trust the project folder in Claude Code. A session starts only in a folder you have trusted in
   Claude Code. Claude Code shows its trust dialog only in the terminal, and a session started
   from the chat would otherwise run a repository's own hooks and apply its settings without asking.
   Before you bind a channel to a repository, open `claude` at its root in the terminal once and
   accept the dialog. A trusted parent folder does not cover a git repository inside it, such as
   a clone. Outside a repository a trusted parent folder is enough for a session to start, and
   Claude Code then leaves out the `permissions.allow` rules and `additionalDirectories` of the
   folder's own `.claude/settings.json` until you accept the dialog in that folder: the chat asks
   for approvals those rules would cover, and the terminal shows the dialog again there, listing
   them. How trust reaches worktrees and nested repositories is under
   [How trust applies to git](#how-trust-applies-to-git).

What else a session takes from your Claude Code setup (the models it offers, the Bash sandbox, MCP
servers, the Chrome integration) is under
[What a session takes from Claude Code](#what-a-session-takes-from-claude-code).

## Part 4: starting pardner on macOS

pardner runs as a user LaunchAgent: it starts when you log in and restarts if it exits.
It has to run inside your login session, because Claude Code keeps its credentials in the macOS
Keychain. After the Mac restarts, it starts again when you log in.

One daemon runs per instance. A chat identity takes one daemon: pardner refuses to start while
another daemon holds its instance's lock, or the lock of its chat identity (for the relay chat,
the bot's device). This part sets up the
default instance; a second daemon on the Mac is a second instance, under
[Part 6](#part-6-a-second-instance).

### Folders macOS protects

6. Give Full Disk Access to Node, only if your projects live in `~/Documents`, `~/Desktop`,
    `~/Downloads` or another folder macOS protects. Do this before the LaunchAgent starts, or the
    first session in such a folder fails.

macOS keeps `~/Documents`, `~/Desktop`, `~/Downloads` and a few other folders private to the
apps you allowed. A program started from Terminal uses Terminal's permission; pardner,
started by launchd, has none, and Claude Code fails to start in a directory there. The permission
goes to the Node executable that runs pardner, the one the service of the next step starts:

- Show the executable in Finder (it can sit in a folder Finder does not show, so this is the
  simplest way to reach it):

  ```bash
  open -R "$(readlink -f "$(command -v node)")"
  ```

  The command finds `node` on your `PATH`, resolves the links to the real file, and shows it in
  Finder. That file is what launchd starts, so it is the one macOS asks permission for.
- Open **System Settings**, **Privacy & Security**, **Full Disk Access**, and drag the selected
  file (`node`) from Finder into the list. Alternatively choose **+** and press **⌘⇧.** in the
  file picker to show hidden folders.
- Check that the new entry is turned on. If the service is already running, restart it:
  `pardner service restart`.

The permission belongs to that executable: any other program started outside Terminal with the
same `node` gets the same access. Projects outside the protected folders need no permission at
all.

### Install the service

7. Install and start the service:

    ```bash
    pardner service install
    ```

    It writes the plist `~/Library/LaunchAgents/local.pardner.plist`, checks it with `plutil
    -lint`, and loads it with `launchctl bootstrap` in your login session. pardner starts at once,
    and again at every login. The command prints the plist's path and the log's,
    `~/Library/Logs/pardner/pardner.log`, then the copy of the package the plist starts and that
    copy's version (`Runs the copy in <folder>, version <version>.`), and ends with status 0.

launchd does not expand `~` or `$HOME` and gives a service a minimal `PATH`, so the plist names
everything by absolute paths. `ProgramArguments` has two entries: the first `node` on the `PATH`
of the terminal you ran the command from (a link such as `/opt/homebrew/bin/node` stays valid
across Node upgrades; a Node installed under a version folder, as nvm does, stops working when that
version goes), and the real path of the `dist/main.js` the command belongs to. The `PATH` the
service gives Claude Code's commands starts with the folder of that Node, then npm's global `bin`
folder, then the folder of the first `claude` on your terminal's `PATH`, then
`/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, so a session finds `node`, `npm`, `claude` and
the commands you installed with npm as your terminal does. The folder of `claude` is the one of the
link your terminal runs (`~/.local/bin` for Claude Code's native installer), which stays valid across
Claude Code updates; a terminal with no `claude` on its `PATH` adds no folder, so run the command
from your own terminal. The plist also sets `RunAtLoad`,
`KeepAlive` (launchd starts the daemon again after any exit) and an `ExitTimeOut` of 60 seconds,
and sends both outputs to the log.

Running `pardner service install` again changes nothing while the service is loaded with the same
plist. When the plist it would write differs (another Node, the package moved, `claude` found in
another folder, a plist written by hand before this command existed), it refuses and writes nothing: run `pardner service uninstall`,
then `pardner service install`, once `pardner service status` says not installed. The uninstall
returns at once and stops the daemon, which ends turns still running within 60 seconds; until the
daemon has exited, the install refuses.

### Checkpoint 3: the service runs it

```bash
pardner service status
tail -n 5 ~/Library/Logs/pardner/pardner.log
```

The first prints `local.pardner is running, pid` and the pid, and ends with status 0 (3 when the
service is not running). After a few seconds the log holds no `ERROR` line and the daemon stays up.

A start that fails logs `ERROR pardner.main:` and what to fix; launchd starts the daemon again
after each exit (`KeepAlive`), so the same line repeats until you fix it and restart the service.

The log holds what the service did, never the content of your messages.

To restart it, read its state, stop it and start it again, or remove it:

```bash
pardner service restart
pardner service status
pardner service stop
pardner service start
pardner service uninstall
```

`pardner service list` shows every instance's service on the Mac
(see [Part 6](#part-6-a-second-instance)).

`restart` sends `SIGTERM` to the running daemon (`launchctl kill TERM gui/$(id -u)/local.pardner`):
running turns finish first, then launchd starts it again. `status` reads `launchctl list`.
`stop` and `uninstall` refuse with status 1 during an update, see [A stop during an update](#a-stop-during-an-update).
`stop` keeps the service installed and unloads it (`launchctl disable`, then `launchctl bootout`):
run it with no turn running, since launchd ends a turn still running within 60 seconds, its reply
with it, and a session that runs `stop` itself is such a turn. The command returns at once, while the
daemon may still be exiting: until `status` says not loaded, `status` and `list` still show it
running, `start` refuses, `install` answers that it is loaded though it is about to go, and
`restart` says launchd starts the daemon again though nothing will, so run these only after that. launchd then refuses to load the service until `start` or `install`, across
logins and reboots. It leaves the plist, `.env`, `state.json` and the log. `start` loads the plist again
(`launchctl enable`, then `launchctl bootstrap`), and refuses with status 1 when none is installed
or the service is already loaded. `install` also clears a `stop`. `status` and `list` show a stopped
service as installed and not loaded. `uninstall` unloads the service (`launchctl bootout`) and removes the plist; it leaves
`~/.config/pardner/` (`.env`, `state.json`) and the log folder, and names both; removing
pardner entirely is under [Uninstalling](#uninstalling). On a system other than macOS, `pardner service` answers that the service exists on macOS only, with status 1.

What a restart waits for, and what each way of stopping does, is under
[Restarts and shutdown](#restarts-and-shutdown).

### Bind a folder and send the first message

8. A channel is bound to a project folder with `/bind <folder>`, given relative to
   `ALLOWED_ROOT` (`/bind my-project`) and trusted in step 5. The folder must already exist
   under `ALLOWED_ROOT`: for one that does not, the answer starts with the path you typed and
   says why (`does not exist`, `is a file, not a folder`, `is outside`). For one that does, the
   answer starts `Bound this channel to`. A message sent before any `/bind` starts nothing and is
   answered `This channel is not bound to a folder yet`.

The relay chat is in development and no app reads its messages yet, so the first message cannot be
sent from a device today. Go through the checklist in Part 5 next.

## Part 5: security checklist

The bot obeys one person, and the rest of this list protects what that person owns.

- `~/.config/pardner/.env` is mode `600`. It holds the relay's address and keys and your person
  id; the bot's own keys are in the same folder.
- The bot obeys the person id it was paired with and nobody else: every message is checked on its
  own, and the core never checks. Whoever controls the device that holds that person id controls
  the machine, and no check in pardner can tell them apart from you.
- A relay that was put back from an older copy, or that is at fault, stops the bot from dialing
  (see [relay-provider.md](relay-provider.md)): recreate the relay, move the instance's `.env`
  away and run setup again.
- `!<command>` runs a shell command on this Mac from the chat, after you confirm, outside
  Claude Code's permission rules and its sandbox, as the terminal's `!` does. The confirmation
  passes the same owner check as the message, so it guards against your own mistakes and not
  against someone holding your device. `PARDNER_SHELL=off` turns it off for the instance.
- Trust a folder in Claude Code only after reading its `.claude/` settings and hooks: trusting it
  is what lets a session from the chat start there.
- With Chrome enabled by default in Claude Code, a session from the chat acts in your browser with
  your sign-ins, and a thread in bypass may do so without asking. Leave it off in `/chrome` if
  you do not want that reachable from the chat.
- The footer, `/status`, `/open` and `/diff` run git only in a repository you trusted in Claude Code by
  itself, since a repository's config can name filters git would run outside the approval prompt.
  Accept the dialog only for a repository whose config you know ([How trust applies to
  git](#how-trust-applies-to-git)).

## Part 6: a second instance

One daemon serves one chat identity. A second daemon on the same Mac is a second instance, with a name
and files of its own. Two reasons to run one: a second login for the agent, and a copy of pardner
under development beside the release you use every day. This part adds an instance beside the
default one that Parts 0 to 4 installed. Its steps continue the numbering of Part 4, and its
commands use the name `work`.

Each instance has its own pairing, its own keys and its own owner check. A daemon on another Mac is
not a second instance of this one: it is that Mac's default instance, set up with Parts 0 to 5 and
a pairing of its own.

### Name the instance

9. Choose a name of 1 to 32 characters of `a-z`, `0-9` and `-`, starting with a letter or a
    digit. `default` and `pardner` are refused. Everything the instance owns derives from the name
    (the table under [What an instance owns](#what-an-instance-owns)), and `--instance <name>`
    tells a command which instance it is about.

### Pair it with a relay

10. Collect the values of Part 1 for the instance: the relay's address and key, and the person id
    the instance's bot obeys. They can be those of the first instance's relay, but the instance
    makes keys of its own when it is paired: two instances never share a pairing.

Each instance needs a pairing of its own. A chat identity takes one daemon, so a second daemon on
the same pairing is refused at start ([One daemon per chat identity](#one-daemon-per-chat-identity)).

### Write its `.env`

11. Run `pardner setup --instance work`, which asks for the relay's values and writes the
    instance's `.env` (step 3), then pairs the bot. Or create the instance's folder and `.env` by hand, with the name
    in the folder:

    ```bash
    mkdir -p ~/.config/pardner-work
    touch ~/.config/pardner-work/.env
    chmod 600 ~/.config/pardner-work/.env
    ```

    Write the variables of step 4 in it. The instance does not read `~/.config/pardner/.env`,
    and a file written by hand holds no pairing: use the setup for the instance's first `.env`.

### Optional: its own Claude Code login

12. Skip this step to let the instance drive the login of the machine and the folders you trusted
    in step 5. To give it another account:

    - Log in once, in a terminal, with a folder of your choice:
      `CLAUDE_CONFIG_DIR=~/.claude-work claude`, then `/login`.
    - In that same terminal session, trust each project folder the instance will be bound to, as
      in step 5.
    - Add `CLAUDE_CONFIG_DIR=~/.claude-work` to the instance's `.env`, written exactly as you
      typed it for `/login`.

    What this changes, and the rules for the path, are under
    [An instance with its own Claude Code login](#an-instance-with-its-own-claude-code-login).

### Install its service

13. Install and start the instance's service:

    ```bash
    pardner service install --instance work
    ```

    It writes `~/Library/LaunchAgents/local.pardner.work.plist`, loads it, and prints the plist's
    path, the log's (`~/Library/Logs/pardner/work.log`) and the copy of the package the plist
    starts, as in step 7. `uninstall`, `status` and `restart` take the same flag. In a terminal,
    `pardner --instance work` runs the daemon in the foreground, as in checkpoint 2.

### Checkpoint 4: both instances run

```bash
pardner service list
pardner service status --instance work
tail -n 5 ~/Library/Logs/pardner/work.log
```

The first prints a table with one row for `(default)` and one for `work`, each with the state
`running, pid` and a pid. The second prints `local.pardner.work is running, pid` and the pid.
After a few seconds the log holds no `ERROR` line for either instance.

### What an instance owns

Everything that is an instance's own derives from its name:

| What | Default instance | Instance `work` |
|---|---|---|
| Configuration folder (`.env`, `state.json`, the lock) | `~/.config/pardner/` | `~/.config/pardner-work/` |
| LaunchAgent label | `local.pardner` | `local.pardner.work` |
| Plist | `~/Library/LaunchAgents/local.pardner.plist` | `~/Library/LaunchAgents/local.pardner.work.plist` |
| Log | `~/Library/Logs/pardner/pardner.log` | `~/Library/Logs/pardner/work.log` |
| Arguments of the plist after the entry file | none | `--instance work` |

The default instance's plist is the one earlier versions wrote, so the default instance runs the
same under a version that knows instances and one that does not.

### Choosing the instance a command is about

`--instance <name>` picks the instance a command is about, and so does `PARDNER_INSTANCE` in the
environment of the command when the flag is absent; the flag wins. With neither, the command is
about the default instance, which has no name and keeps the paths of Parts 2 to 4. A name that
breaks the rule of step 9 ends the command with status 2 and the reason on stderr. `--version`
and `--help` take no instance.

The daemon sets `PARDNER_INSTANCE` to its name in its own environment (and removes it for the
default instance), which every session it starts inherits. A session of `work` that runs
`pardner service status` therefore asks about `work`, under launchd and in a foreground run
alike, with no flag typed. To reach the default instance from such a session, empty the variable:
`PARDNER_INSTANCE= pardner service status`.

### Listing the instances

`pardner service list` shows every instance's service, whatever `--instance` or
`PARDNER_INSTANCE` say: it takes no instance. It reads each `local.pardner.plist` and
`local.pardner.<name>.plist` in `~/Library/LaunchAgents/`, takes the instance from the plist's
`--instance <name>` argument (none means the default instance), and prints it, whether
`launchctl` has it loaded (with the pid when it runs), the copy of the package the plist starts and
that copy's version:

```
INSTANCE   STATE              COPY                                                     VERSION
(default)  running, pid 4242  /opt/homebrew/lib/node_modules/pardner                  0.1.1
dev        not loaded         /usr/local/share/pardner-dev/lib/node_modules/pardner  0.2.0
```

The default instance is written `(default)`: it has no name, and `--instance default` is refused.
A job `launchctl` has loaded whose plist file is gone (removed by hand) is listed too, with
`its plist is gone` after its state and `-` for the copy and the version; `service uninstall`
stops it.

A plist with no entry file is listed with `unreadable plist` as its copy, and a copy whose
`package.json` is gone with the version `unknown`. A plist that does not agree with itself is not
listed as an instance: the command names the file below the table, as `<file>: not a pardner
instance it can manage: <reason>`. That is a plist that cannot be read, whose arguments are
anything but the entry file with an optional `--instance <name>`, whose name breaks the name rule
(including `default` and `pardner`), whose `Label` is not `local.pardner` or
`local.pardner.<name>` for the instance its arguments start, or whose file name is not that label
with `.plist`. `service install`, `uninstall`, `status`, `restart`, `stop` and `start` could not find such a file by
an instance name. Instances installed from one copy run it
together: `npm install -g pardner@latest` replaces that copy, and each of them needs its own
`pardner service restart --instance <name>` to run the new one. The update from the chat and
`pardner update` restart every instance on the copy, see [Updating pardner](#updating-pardner).

### One daemon per chat identity

Each instance has its own lock, in its own configuration folder. A second lock guards the chat
identity: copying an instance's `.env` and its pairing files to start another would give two
daemons one bot device, and the relay would send each event to one of the two connections. Once
the chat is built, and before the connection opens, the daemon takes a lock named after the bot's
device (the identity the chat reports). It is in `~/.config/pardner_identities/<16 hex digits>/`
(the same folder for every instance of the user, created at mode `700`; no instance name can hold
the underscore, so no instance's folder can be it). The hash of the identity is all that is
stored in the folder name. A daemon that finds the lock held ends with status 1 and this line in
its log:

```
ERROR pardner.main: another pardner instance is connected to this chat identity (lock on <folder>): give each instance its own chat identity
```

The locks are files of one Mac: they stop a second daemon on the same Mac, not one on another
Mac started with a copy of the same pairing. A daemon on each Mac needs a pairing of its own, as
each instance does.

The lock is held for as long as the daemon runs and is released with it. A folder left behind
after a stop is empty and harmless.

### A development copy beside the release

Install a build of a clone in a prefix of its own, never in npm's global one, which holds the
release and which `npm install -g` replaces:

```bash
npm install -g --prefix ~/.local/share/pardner-dev "./$(npm pack --silent)"
alias pardner-dev=~/.local/share/pardner-dev/bin/pardner
pardner-dev service install --instance dev
```

Run from the clone, `npm pack` builds the tarball. The alias (put it in the shell's profile) makes
`pardner-dev` the command of that copy, and `pardner-dev service install --instance dev` writes
a plist that starts it; its output names the copy and its version. The release keeps running as
the default instance from the global prefix.

### An instance with its own Claude Code login

An instance drives the Claude Code login of the machine unless its `.env` names another folder
with `CLAUDE_CONFIG_DIR`. Claude Code keeps a login, its settings, its trust record and its
sessions in such a folder, and on macOS the Keychain entry of the login is keyed to the folder
([authentication](https://code.claude.com/docs/en/authentication), read 2026-10-17). A Claude
Console sign-in made without an API key is stored outside that folder, so two folders do not keep
two of those apart. Step 16 gives an instance a second account. pardner reads the trust record
of the instance's folder, so a project folder trusted only in `~/.claude` is not trusted there.
After changing the line in an existing instance's `.env`, restart the instance.

Write in `.env` exactly the path you used with `/login`. On macOS Claude Code keys the Keychain
entry of the login by the folder's string as it is written, so `~/.claude-work/` (with a trailing
slash) is another entry from `~/.claude-work`, and the instance would find no login. pardner
reads `~` as your home and passes the rest on unchanged. The value must be absolute or start with
`~/`; a relative path ends the start with an error that names the variable. The same rule holds
for a `CLAUDE_CONFIG_DIR` the daemon inherits from its environment when `.env` sets none, and the
error then says it came from the environment.

That instance then reads the settings of `~/.claude-work`, not those of `~/.claude`: your
`CLAUDE.md`, skills, hooks, MCP servers and permission rules are the other folder's, and have to
be set there. Its sessions are written there as well, so in a terminal `claude --resume <id>`
finds them only with the same variable: `CLAUDE_CONFIG_DIR=~/.claude-work claude --resume <id>`.
The command `/status` prints carries it: `cd <folder> && CLAUDE_CONFIG_DIR=<folder of the login>
claude --resume <session id>`, the login's folder quoted for the shell as the
project folder is. The default instance, and any instance whose `.env` does not set it, keep using
`~/.claude`, and its line is the one shown in "Continuing a session in the terminal".

### Renaming an instance

No command renames an instance: its name is in its folder, its label and its log, so moving the
folder between an uninstall and an install renames it. From `dev` to `lab`, at a time when no
session of `dev` is working (the uninstall ends turns still running after 60 seconds), and from a
terminal rather than a session of that instance, which the uninstall would stop. The uninstall
returns before the daemon has exited, so move the folder once `status` says not installed:

```bash
pardner service uninstall --instance dev
pardner service status --instance dev
mv ~/.config/pardner-dev ~/.config/pardner-lab
pardner service install --instance lab
```

`.env`, `state.json` and the pairing move with the folder, so the bound channels and their sessions
stay. The relay and the bot's keys do not change. The new log is `lab.log`; `dev.log` stays where
it was.

### Instances that share a login and a folder

Two instances that use the same Claude Code login and are bound to the same folder list each
other's sessions in `/resume`, since Claude Code keeps the sessions of a folder in one place.
Resuming a session that another process has open gives two branches of one transcript, as it does
with two terminals. Keep the instances' folders apart, or resume only sessions of the instance you
are in.

## Using it

A message the owner sends in a bound channel opens a new thread and starts a session there; a
reply inside that thread continues the same session, even days later. Each thread keeps the folder
it was opened in: `/bind` only changes where the *next* thread starts. A thread's Claude Code
process closes on its own after an hour with nothing to do; the next message sent to it resumes
the session, as `claude --resume <id>` would. How a message reaches the daemon, and how the chat
shows a reply, are the chat's own: the relay chat's are in
[relay-provider.md](relay-provider.md) and [limits.md](limits.md).

### Continuing a session in the terminal

A thread's session and the terminal share one session id, so you can move between them and back
as often as you like:

1. In the thread, `/status` gives the command that opens the session in the terminal. During a
   turn, `/terminal` gives it too, and takes the running turn with it.
2. In the terminal, run it and work there. When you are done, type `/exit`.
3. Back in the thread, write as usual. What you did in the terminal shows first, then the reply,
   which knows it.

A session you started in the terminal comes to the chat the other way, with `/resume` in the channel.

Claude Code leaves a session created through the Agent SDK out of the terminal's session picker
and out of `claude --continue`; it resumes one only by its id
([sessions reference](https://code.claude.com/docs/en/sessions)). Every session started from
the chat is such a session. `/status`, typed in the session's thread, shows the command to run:

```
Terminal: `cd <folder> && claude --resume <session id>`
```

Write from one side at a time. Two processes on one session do not see each other's messages,
and the second to write splits the conversation; a later resume continues one side only
(measured 2026-10-27, Claude Code 2.1.311). Opening the session in the terminal and closing it
without writing changes nothing.

Before a message you send in the thread reaches the session, pardner asks Claude Code which
processes hold it open (`claude agents --json`, run with the instance's `CLAUDE_CONFIG_DIR`):

- A terminal running a turn: your message waits, under `⏳ This session is running a turn in a
  terminal. Your message waits here until that turn ends.` with a way to cancel it. When the
  turn ends the notice reads `The terminal's turn ended.`, and the message goes on, after the
  question below if the terminal is still open.
- A terminal open and idle: pardner asks once per terminal process (the answer is kept in `state.json`, so a restart of pardner or an idle close does not ask again; the next answer replaces it, a new session id clears it, and it goes with the thread), `⚠️ This session is also open in a
  terminal. If you send this here, that terminal will not see it: before writing there, close it
  and run <command> again.`, with a choice to send here or to cancel. The question becomes `Sent here.`
  or `Not sent.` A `/stop` sent while either is shown removes it.
- The turns the terminal wrote since the thread's last message come first, one message each:
  `🖥 In the terminal:`, your prompt as a quote, then Claude's last reply of that turn. A turn
  `/terminal` moved, which the terminal went on with by itself, comes first as
  `🖥 In the terminal, the turn went on:` with its last reply, or as
  `🖥 In the terminal, the turn went on, and you interrupted it.` when you stopped it there. The
  session's process is then started again, so that it reads them.
- Background work running in the thread while the terminal wrote: the process that runs it never
  reads what the terminal wrote, and starting it again stops the work. pardner asks first,
  `⚠️ This session was continued in a terminal while work runs here: <tasks>. To send this here,
  that work stops first.`, with a choice to stop them and send, or to cancel. The question becomes
  `Sent here.` or `Not sent.`

Another of your Claude Code sessions can write to a thread's session (`SendMessage`, which lists
it among the sessions it can reach). Its message shows in the reply as `📨 From another session:`
then the text as a quote, whether it starts a turn or arrives during one, and Claude answers
it. A message Claude Code holds for your approval (seen with bypass off in the thread and on in
the sender) cannot be approved from the chat, and is dropped when the approval expires.

A terminal left open does not read what you write in the chat: close it and run the command again
before writing there. `/resume <session id>` inside it does not reload a session started from
the chat, which the picker does not list.

`/terminal`, sent in the thread, moves the session to the terminal and answers with the command:

- During a turn, the turn is cut there without an interrupt and continues in the terminal by
  itself: the command adds `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1`, the command that was running
  stops (its card in the thread shows it stopped) and Claude decides there whether to run it
  again, and the reply ends with `Moved to the terminal, which continues this turn.`
- With no turn running, the thread's process is closed and the answer is `Continue in the
  terminal with:` and the plain command.
- Background work running in the thread stops with the process, so `/terminal` first asks
  `⚠️ Moving to the terminal stops what still runs here: <tasks>.` with a choice to stop them and move, or to cancel (`Not moved.`). Opened in the terminal, the session then says
  `Background shell command didn't finish before the previous session ended`: Claude Code's own
  line, since a background command does not move from one process to another.

While a turn or background work runs, `/status` says under the command that writing in the
terminal now splits the session.

The line shows as soon as the thread has a session id, which Claude Code reports when the first
turn starts. It is left out when the thread's folder is missing, unreadable or not trusted, with
the reason at the end of the status. `claude --resume <session id>` finds the session from any
folder (Claude Code 2.1.223 or later); the `cd` makes it work in the thread's folder.

### Copying a session into a new thread

`/fork <prompt>`, sent in a thread, copies its session into a new thread of the same channel, as
the terminal's `/fork` copies a session into a new one: the copy holds the whole conversation,
runs the same model, effort and bypass, and starts on the prompt, while the thread you sent it
from goes on as it was. Use it when a session finds a problem that is not its task.

- pardner posts the new thread's first message in the channel, `Fork of <link>: <prompt>`, the
  link going back to the thread you sent it from. That thread gets one line:
  `Forked into <link> · running · session <id>`.
- The new thread's next message is the original's last turn, `Last in the original:`: your prompt
  as a quote and the start of the final reply, each cut at 300 characters, with the rest left in
  the original's thread, and `(stopped)` under a turn you interrupted. Commands such as `/model` are not turns and are skipped. Nothing is posted when the original has no turn yet or its record cannot
  be read.
- With no prompt, `/fork` opens the new thread and the copy waits for your first message there. No
  process runs for it until then, and its first message in the thread names it: the `/resume` list
  shows that message, not the original's title with `(fork)` after it. A command, a `!command` or a
  message with only files does not name it; the first message with text after them does. The
  thread's first message shows no status until the copy's first turn. When the original has no
  title, the link back reads `the original thread`.
- Sent while a turn runs, it waits for the turn to end, so the copy holds the whole conversation.
- A thread that works in an earlier folder of the channel, after a `/bind` to another, cannot be
  forked: the copy's thread would start in the channel's folder, where the session does not exist.
- Sent while pardner waits to restart, it is refused, and nothing is copied.
- The copy is told it was forked from a session that still runs, and can message it, as the
  terminal's copy is; a command the original left running in the background stays the
  original's, and the copy is not told it stopped. The original is not told of the copy.
- The new thread asks no setup: it starts from the copy's settings. It is a thread like any other
  afterwards, in `/status`.
- The copy works in the same folder as the original. The terminal's `/fork` tells its copy to make
  a worktree of its own before editing; a copy made here gets no such instruction
  ([limits.md](limits.md)).
- `/resume` lists the copy among the folder's sessions, under its prompt or first message as a
  title, or the original's title with `(fork)` after it for a copy no message has named yet.

### Commands

A message is a command when its first character is `/`, and a shell command when it is `!`. In a
chat that reports a message's plain text beside what was typed, inline code, a code block, bold,
italic and strikethrough are read through, so a word pasted from a place that showed it as code
still acts; the relay chat reports none, so there a formatted word is plain text. The word ends at
the first space or line break, and what follows is sent as you wrote it. To send Claude a text
that starts with `/` or `!`, put any character other than a space or a line break before it:
`\/goal`, `"/goal"`, `\!ls`. A `/` followed by a space is plain text; a `!` followed by one is
still a shell command (`! ls`). In a chat that reads through formatting, a message that starts
with a command you only meant to quote runs that command: `/stop` or `/bypass on` alone in inline
code acts as the word. Inside a quote or a list
a `/` or `!` is never a command.

An argument that is a name, an id, a path or a keyword (`/tag`, `/resume`, `/open`, `/bind`,
`/help`, `/bypass`, `/plan`, `/pardner`) is read without inline code marks, so
`` /tag `CVE-0000-00000` `` tags the thread as `/tag CVE-0000-00000` does. Bold, italic and
strikethrough are not removed there, since their marks may be characters of a name. An argument that is
text for Claude (the prompt of `/fork`, and any other `/name args` command) is sent as you wrote
it, code spans included. A word typed with arguments it refuses (a tag that breaks the rule, `/diff
now`, `/bypass maybe`) answers with its own line of the list and the rule it broke, instead of the
whole list; a word that this instance does not offer still gets the whole list.

| Word | At the top level | Inside a session's thread |
|---|---|---|
| `/guide` | Explains in a few lines how pardner works | Same |
| `/bind` | Lists the folders you can bind | Refused |
| `/bind <folder>` | Binds the channel to a folder under `ALLOWED_ROOT` | Refused |
| `/bypass on` / `off` | Refused | Switches that session's bypass |
| `/plan` / `/plan off` | Refused | Switches that session to plan mode and back |
| `/status` | The channel's directory and its threads that hold a session | That session's details |
| `/stop` | Stops every running session of the channel | Stops that session |
| `/memory` | Refused | The memory files that session loaded, with their sizes |
| `/skills` | Refused | The skills that session can use, with what each does |
| `/terminal` | Refused | Moves that session to a terminal, a running turn with it, and gives the command to run there |
| `/fork [prompt]` | Refused | Copies that session into a new thread of the channel, which starts on the prompt or waits for your first message there |
| `/help [text]` | Lists pardner's own words | Lists them and the session's commands |
| `/open` | Refused | Offers the recent changed files and a search; `/open <path or words>` shares that file into the thread |
| `/diff` | Refused | Lists the files that differ from HEAD in the session's git repository |
| `/rewind` | Refused | Lists the session's prompts, to go back to one: restores its code, its conversation or both |
| `/next` | Refused | Shows the prompt Claude Code suggests after a turn, to send or cancel |
| `/tag <name>` | Refused | Tags the thread's first message and the session in Claude Code |
| `/untag` | Refused | Takes the tag away |
| `/pin` | Refused | Pins the thread's first message |
| `/unpin` | Refused | Takes the pin away |
| `/delete-thread` | Refused | Asks you to confirm, then deletes the thread |
| `/clean-channel` | Asks you to confirm, then deletes the channel's threads and what sits outside them | Refused |
| `!<command>` | Refused | Asks you to confirm, runs the command in the session's folder, and Claude answers its output |
| `/resume` | Lists the sessions you can resume | Refused |
| `/resume <id or name>` | Resumes that session in a new thread | Refused |
| `/pardner` | Shows the version, the latest one and the update state | Same |
| `/pardner update` / `restart` | Offers an update, or restarts pardner | Refused |
| `/clear` (or `/reset`, `/new`) | Opens a new session (harmless: nothing to clear yet) | Refused: `One thread is one session: send a new message in the channel to start a new one.` |
| `/login`, `/logout` | Answered with how to do it on the host | Same |
| any other `/name [args]` | Opens a session; runs `/name args` if the agent offers it, else sends the text as written. A command [limits.md](limits.md) lists as not offered is answered and opens no session | Runs `/name args` if the session offers it, else suggests the commands it could mean |
| `/` alone | Opens a session, then sends `/` as written | Shows every command |
| a message | Opens a session and sends the message; the reply grows in the thread | Continues that session |

A message you send while a turn runs goes to Claude Code at once, which takes it into the running
turn or runs it next.

A word that depends on what the agent can do exists when the agent declares that capability, and
the word's meaning is the agent's mapping. In this release the agent is the Claude Code module:
`/bypass on` sets its `bypassPermissions` mode, `/plan` sets its plan mode, and the words `/effort`
and `/advisor` are its commands, sent as `/effort` and `/advisor`. An agent without a mode that
skips permission requests refuses `/bypass`, one without a plan mode refuses `/plan`, and a
command the agent does not list is not offered.

#### Answers and limits of the words

What a word does is the core's and the agent's; how its answer looks is the chat's. A word that
needs a feature the chat lacks (sharing a file, a list with a control per row, tagging, pinning,
deleting a thread, cleaning a channel) is not offered on that chat: the relay chat has none of
those features yet ([limits.md](limits.md)).

- `/bind`: lists `ALLOWED_ROOT` itself (shown as `.`) and the folders up to two levels below it,
  never inside a git repository, that Claude Code trusts. At most 20 are shown, in path order;
  when there are more, the higher levels fill the list first. Refused inside a thread.
- `/bind <folder>`: binds the channel to a folder under `ALLOWED_ROOT`, given relative to it
  (`/bind my-project`); an absolute path inside it works too. A typed path may go deeper than the
  two levels the list shows (`/bind clients/acme/api`). A new channel does nothing else until
  bound. The answer names the folder each existing thread keeps working in, when it differs from
  the new one. Refused inside a thread.
- `/bypass on` / `off`: switches that session to `bypassPermissions` and back, kept in
  `state.json` per thread: an idle close and a restart of pardner keep it, `/resume` starts a
  session with it off. Refused at the top level, since bypass belongs to one session.
- `/plan` / `/plan off`: `/plan` switches that session to Claude Code's plan mode, where it
  plans first and asks you to approve the plan before it acts; `/plan off` returns to the mode
  the thread would otherwise have. Refused at the top level.
- `/status`: at the top level, the channel's directory and the threads that hold a session; in a
  thread, that session's directory, session id, the command that continues it in the terminal,
  its title when Claude Code has one, its mode, then the footer's values one per line.
- `/stop`: stops the running sessions of the channel at the top level, or that session in a
  thread, with their background tasks, and denies their pending approvals. A stop ends the turn,
  not a goal set with `/goal`. It also drops the messages of the stopped sessions that have not
  reached the agent: those still in the daemon's queue (a `!command` waiting for the running
  turn, a message waiting for the agent's process to start). A message already sent to the agent
  is the agent's.
- `/memory`, `/skills`: list what that session loaded, read only: the memory files with their
  sizes, as the terminal's `/context` gives them, and the skills it can use, as `/skills` does.
  Refused at the top level.
- `/terminal`: moves the session to a terminal and gives the command to run there (see
  [Continuing a session in the terminal](#continuing-a-session-in-the-terminal)).
- `/fork [prompt]`: copies the session into a new thread (see
  [Copying a session into a new thread](#copying-a-session-into-a-new-thread)).
- `/help [text]`: says what makes a message a command, then lists pardner's own words; inside a
  thread it also lists every command that session offers now, and with a text only the lines whose
  name or description contains it.
- `/open`, `/diff`, `/rewind`, `/next`: the terminal's file picker, `/diff`, `/rewind` and the
  suggested next prompt, inside a session's thread, offered when the chat can show them.
- `/tag <name>`, `/untag`, `/pin`, `/unpin`, `/delete-thread`, `/clean-channel`: act on the
  thread's first message or on the channel's threads, and are offered when the chat supports
  them. `/delete-thread` and `/clean-channel` ask before they delete.
- `!<command>`: the terminal's `!<command>`. It asks for confirmation with the whole command,
  then runs it with Bash in the session's folder, with the environment Claude Code would give it,
  and Claude answers its output. Refused at the top level, and when `PARDNER_SHELL` is `off`.
- `/resume`: lists the sessions of the channel's directory that no thread holds, terminal and
  chat alike, and `/resume <id or name>` resumes one, by the first 8 characters of its id or longer
  start, or by its name, in a new thread. One session never runs in two threads at once: a
  session open in another thread is refused with a link to that thread. Refused inside a thread.
- `/pardner`: shows the version that runs, the latest npm published and when npm was last
  asked; `update` and `restart` are allowed at the top level only (see
  [Updating pardner](#updating-pardner)).
- `/login`, `/logout`: never sent to Claude Code, and no session starts. The answer says to log in
  or out on the host: on that machine, run `claude`, then `/login` or `/logout`. The login is
  never done from the chat.
- any other `/name [args]`, and `/` alone: a name the session lists runs as `/name args`; any
  other word is not sent as a command: inside a thread the answer offers up to 5 commands it
  could mean, and at the top level the text opens a session as written.

A command of Claude Code is typed `/compact`, as in the terminal. A `/word` that is not a command the session offers is sent as a normal prompt, so
`/important: …` reaches Claude as written. `/resume` is the daemon's own word, since Claude Code's `/resume`
is not offered to an SDK session.

A reply in a thread whose session no longer resumes (its transcript was deleted) is answered
`This thread's session no longer exists: Claude Code deleted it or cannot find it. Send a new
message in the channel to start one.` A reply in a thread that holds no session gets ``This
thread holds no session. In the channel, send a new message to start one, or `/resume` to
continue an earlier one.``, except a word, which acts as if typed at the top level.

## Updating pardner

pardner can be updated from the chat or from a terminal. Both install a version npm publishes
with `npm install -g pardner@<version>`, and neither updates anything by itself: an update
happens when you ask for it.

### From the chat

pardner asks your npm (`npm view`, so your registry, proxy and credentials apply) for the latest
version when it starts and every 6 hours. `/pardner` names the version that runs, the latest one
and the time of the check.

`/pardner update`, typed in a channel, offers the update: `Update pardner <installed> →
<latest>`, with the wait for running turns and the other instances that restart with this one. Once
you accept, it installs exactly the version the offer shows, even if a newer one came out since,
and then:

1. The offer reads `Installing pardner <latest>…`. Sessions already running go on. A message
   that needs a new Claude Code process (a new thread, a session to reconnect, `/status`, the usage
   probe) is answered `pardner is updating, stopping or restarting; unless it is stopping, send this again in a moment.`
   for the install's few seconds, and nothing changes. Every other daemon on
   the machine answers the same while the install runs (it asks the update lock, below), and
   refuses `/pardner restart` with `An update of pardner is already under way.`; so does a
   daemon while `pardner update` runs in a terminal.
2. pardner reads the copy's `package.json` again. When it holds the version asked, the offer
   reads `Installed pardner <latest>. Restarting once running turns finish.`
3. The other loaded instances on the same copy get the restart (see below), then this daemon
   stops starting turns and lets the running ones finish, up to 29 minutes, as
   [Restarts and shutdown](#restarts-and-shutdown) describes. The service starts the new copy.
   From the start of the install to its exit this daemon starts no Claude Code process, and the
   instances restarted with it are draining, so a session does not run the new package under the
   old code. An instance whose restart did not go through keeps running the old code over the new
   package; the offer then adds one sentence for it, ``Instance `<name>` did
   not restart: <reason>. `pardner service restart --instance <name>` in a terminal restarts
   it.`` (``The default instance did not restart: <reason>. `pardner service restart` in a
   terminal restarts it.`` for the default one).

Once the new daemon is connected it rewrites the offer in place when the chat can edit a message:
`Updated to pardner <latest>.` when the version that runs is the one asked, and `pardner
restarted on <installed>, not on <asked>: the update did not take.` when it is not.

`/pardner restart` restarts the same way without installing, and its `Restarting pardner once
running turns finish.` becomes `pardner restarted at <HH:MM>.` when the daemon is back. A restart
asked from a terminal, a `SIGTERM` from the service manager and the other instances an update
restarts leave nothing to rewrite. `/pardner update` and `/pardner restart` typed inside a
thread are refused (`/pardner update works in the channel, not inside a thread.`); `/pardner`
alone answers there.

### Which copy updates

Only the copy that `npm install -g` would replace: the package folder `$(npm root -g)/pardner`,
reached by its real path, not through a link, at a version npm publishes. A clone run from its
checkout, a copy installed with `npm link`, a build installed into another prefix (the
[development copy](#a-development-copy-beside-the-release)) and an unpublished version are never
updated from the chat or by `pardner update`. For them `/pardner` says so and why
(`This copy updates outside the chat: <reason>.`).

From the chat, the daemon must also run as a service (`pardner service install`, Part 4): it stops to
update, and only a service starts it again. pardner asks the system's service manager which
process the service of this instance runs and updates only when it is its own; a daemon started in
a terminal answers ``pardner is not running as a service. `pardner service install` in a terminal
makes it one; then it can update and restart from the chat.`` and stops nothing. Services installed
before the update existed qualify as they are.

Every loaded instance whose service runs that same copy is restarted, each after its own running
turns finish (up to 29 minutes), since all of them run the package folder the install replaces. The
offer names them (`Instance <name> runs the same copy and restarts too.`). An instance on another
copy is not touched.

### When npm fails

Nothing changes and the old version keeps running. The offer becomes the sentence of the failure
(`/pardner update` makes a new one):

| What happened | What it says |
|---|---|
| npm could not reach the registry | ``The update failed: npm could not reach the registry. pardner keeps running <installed>; `/pardner update` tries again.`` |
| npm may not write to the prefix | `The update failed: npm may not write to <folder>. pardner keeps running <installed>. npm's message is in the log, <log>.` |
| npm ended with another status | `The update failed: npm ended with status <code>. pardner keeps running <installed>. npm's message is in the log, <log>.` |
| npm ended well but the copy holds another version, or none that can be read | pardner does not restart and names the command that puts back the version that runs, `npm install -g pardner@<installed>` |

npm's own message goes to the log (`~/Library/Logs/pardner/pardner.log` for the default
instance), never to the chat. The machine runs one update at a time (a lock in
`~/.config/pardner_update`): a second request on the same daemon gets `An update to <version> is
already under way.`; a request while another instance or the terminal
holds the lock gets `An update of pardner is already under way.` (the version is not known), and
`pardner update` in a terminal during an update from the chat ends with `pardner update: an update of pardner
is already under way on this machine.` Daemons read the lock without holding it, and a take that
meets that reading tries again for about 200 ms before it reports an update under way. A killed npm can leave a half-written copy
(measured 2026-10-17, npm 11.17.0: a SIGKILL during the unpack left the new folder without a
`package.json`); the next `npm install -g pardner@<version>` repairs it.

### A stop during an update

A `SIGTERM` that comes while npm installs waits for it like a turn: the install ends, the other
instances get their restart, and the daemon exits with the new copy in place. A `SIGINT`, a
failure of the daemon, or a drain that reaches its 29 minutes, sends npm `SIGTERM`: npm finishes
the step it is in and puts the old folder back (npm 11.17.0, 2026-10-17: exit status 1, the copy as
before), and the shutdown goes on once npm has ended, for at most 2 minutes (a failure's stop,
which otherwise ends the process 30 seconds after the failure, waits that long too). The log then holds
the failure of the install. A `SIGKILL` of npm would leave a half-written copy, which is why the
daemon does not send one. `pardner service stop` and `pardner service uninstall` refuse with
status 1 while the instance's daemon runs and an update holds the machine's lock, whichever instance
or terminal runs the update. For a hung install this daemon runs, `pardner service restart` ends it
when the drain reaches its limit. A logout cannot be refused, and an update that starts just after the
command read the lock is not seen: `launchctl bootout` makes launchd kill the daemon `ExitTimeOut`
(60 seconds) later, and an install that takes longer than that is cut off the same way and can leave
a half-written copy; the next `npm install -g pardner@<version>` repairs it.

### From a terminal

```bash
pardner update --check
pardner update
pardner update --yes
```

`--check` prints `pardner <installed> · latest <latest>` and changes nothing. `update` checks that
the running copy is the one `npm install -g` replaces, prints what changes and which instances
restart, asks `Update? [y/N]` (without a terminal it refuses unless `--yes`), installs, reads the
copy's `package.json` again, and sends the restart to every running service of that copy, each
after its running turns finish. It needs no service: with none running the copy, it ends with
`No service runs this copy, so nothing was restarted.` once installed. It takes no `--instance`,
since it is about a copy. It exits with 0 when it updated or had nothing to do and with 1 when it
failed or could not tell.

To update by hand, `npm install -g pardner@latest` then `pardner service restart` for each
instance on the copy works as before.

## Uninstalling

Remove each instance's service first, then the package, then the files pardner left. Run the
commands with the Node pardner was installed with (`nvm exec 26 -- …` if you followed
[A Node of its own](#a-node-of-its-own)).

1. For each instance `pardner service list` shows, stop and remove its service. The uninstall
   ends turns still running after 60 seconds:

   ```bash
   pardner service uninstall                    # the default instance
   pardner service uninstall --instance <name>  # each named one
   ```

2. Remove the package, and a development copy if you installed one in a prefix of its own:

   ```bash
   npm uninstall -g pardner
   rm -rf ~/.local/share/pardner-dev           # only for a copy installed there
   ```

3. Delete what pardner kept on the Mac:

   | Path | What it holds |
   |---|---|
   | `~/.config/pardner/`, `~/.config/pardner-<name>/` | each instance's `.env`, `state.json` and the bot's keys |
   | `~/.config/pardner_identities/` | the empty folders of the chat identity locks |
   | `~/Library/Logs/pardner/` | the services' logs |
   
   ```bash
   rm -rf ~/.config/pardner ~/.config/pardner-* ~/.config/pardner_identities
   rm -rf ~/Library/Logs/pardner
   ```

4. On the relay's side, remove each instance's bot (its device) with the tool the relay gives
   you: deleting the files above does not tell the relay.

What stays is not pardner's: Claude Code's login, settings, sessions and trusted folders
(`~/.claude`, `~/.claude.json`, and any folder you named in `CLAUDE_CONFIG_DIR` for an instance,
which you remove with `rm -rf` once you have run `/logout` in it), and the Full Disk Access entry
of the Node executable in System Settings, if you gave it one.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Claude Code is not logged in on the host` | Claude Code on the machine is logged out: run `claude`, then `/login` |
| `This thread's session no longer exists: Claude Code deleted it or cannot find it. Send a new message in the channel to start one.` | The stored session id can no longer be resumed (its transcript was deleted); send a new message in the channel to start one |
| ``This thread holds no session. In the channel, send a new message to start one, or `/resume` to continue an earlier one.`` | The thread holds no session (a word's own thread, or one with no entry in `state.json`); send a new message in the channel to start one, send `/resume` there to continue a session Claude Code still has, or type a word, which works as if typed there |
| ``This thread already holds a session: send `/resume` again in the channel to pick another.`` | A `/resume <id or name>` or a choice in the `/resume` list was sent to a thread that already has a session; a new `/resume` in the channel gives a thread of its own |
| `This session is already open in another thread: <link>.` | A `/resume <id or name>` or a choice in the `/resume` list named a session already open in some other thread; follow the link and send the message there instead |
| `Claude Code has not been trusted in ...`, after a message or a `/bind` | Open `claude` in that folder (the repository root) in the terminal, accept the trust dialog, and send the message again. For a worktree whose folder was moved by hand, run `git worktree repair` in it |
| The terminal shows the trust dialog in a folder you already use from the chat, or the chat asks for approvals the folder's allow rules cover | The folder is outside a repository and only a parent folder is trusted, which Claude Code does not count for the `permissions.allow` rules and `additionalDirectories` of the folder's `.claude/settings.json`. Accept the dialog in that folder: it lists them |
| `The directory ... no longer exists` | The thread's directory was moved or deleted: restore it to keep using this thread, or, in the channel, bind another folder with `/bind <path>` and send a new message to start a session there |
| `macOS does not let pardner read ...` | The directory is in a folder macOS protects: see Part 4, "Folders macOS protects" |
| `pardner needs Node 26.5.1 or later and this is Node ...` in the log, or on the terminal | The Node that runs pardner is older than 26.5.1; the process ends with status 1. Install a newer Node, beside yours if you want ([A Node of its own](#a-node-of-its-own)), and run `pardner` again. The LaunchAgent names the Node executable in its plist: change it there too |
| `ALLOWED_ROOT must be an absolute path, or one starting with ~/; it is "..."` | `ALLOWED_ROOT` in `.env` is a relative path, which would be read from the folder the process starts in. Write the whole path, or start it with `~/` |
| `another pardner is running` in the log | A second daemon of the same instance tried to start; one daemon runs per instance |
| `another pardner instance is connected to this chat identity (lock on ...)` in the log | The daemon ended at start because another daemon of this user, of any instance, holds the lock of the same chat identity (for the relay chat, the same bot device). Give each instance a pairing of its own: [One daemon per chat identity](#one-daemon-per-chat-identity) |
| `RELAY_OWNER is not the one the bot was paired with: move the instance's .env away, then run setup again` in the log (the same for `RELAY_KEY`) | The `.env` no longer matches the pairing the bot holds. Move the instance's `.env` away and run `pardner setup` again |
| `the relay must be recreated: it was put back from an older copy or is at fault, and the bot dials it no more` in the log | The relay holds a state older than the one the bot has seen, or a fault: the bot never dials it again. Recreate the relay, move the instance's `.env` away and run setup again ([relay-provider.md](relay-provider.md)) |
| `RELAY_ADDRESS: write the address as host:port, for example 127.0.0.1:4433.` in the log | `RELAY_ADDRESS` in `.env` is not `host:port` with a port from 1 to 65535 |
| The daemon is down and you need a session's id, which `/status` shows | The id is the name of the session's file, in the folder under `~/.claude/projects/` (or under the instance's `CLAUDE_CONFIG_DIR`) named after the project's path. Continue it in the terminal as in [Continuing a session in the terminal](#continuing-a-session-in-the-terminal) |

## Reference

Detail that the install sequence links to, kept out of its way.

### The config directory and `state.json`

| File | Written by | Holds |
|---|---|---|
| `.env` | you | the relay's values and the settings of Part 2 |
| `state.json` | pardner | the names of the agent and the chat that wrote it; for each channel, its directory; for each of its threads, the folder it was opened in, its Claude Code session id, its bypass choice, the `/effort` level, the status of its root message, the ids and kinds of the replies and requests a crash repair needs, and the text the root message had before pardner replaced it with the session's title (`root_prompt`, the only message content in the file), and for a thread `/fork` opened, the session it copies and when (`fork_of`; for a copy made with no prompt, `ran` and `named` while false: whether a turn has started in it and whether its first message has named it), and for a rewind no message has followed yet, the prompt it cut at and the agent's token for it (`pending_cut`: two ids), and the terminals you chose **Send here** for (`terminals_allowed`: one id of a process and its start time each, replaced at the next answer, cleared when the thread's session id changes); at the top of the file, `update_notice` and `restart_notice`. The fields one by one and how they are written are in [State and the single-instance lock](architecture.md#state-and-the-single-instance-lock) |

`state.json` looks like this; you never need to edit it:

```json
{"version": 3, "agent": "claude", "chat": "relay", "channels": {"chan-1": {"directory": "/home/dev/code/project", "threads": {"thread-1": {"directory": "/home/dev/code/project", "session_id": "...", "bypass": false, "effort": null, "open_replies": [], "requests": [], "request_kinds": {}, "status": null, "ended": null}}}}}
```

`state.json` belongs to the agent and the chat named in it, since a session id and a thread's name
mean nothing to another. A file of version 1 or 2, or one with no version, was written by an older version
before the relay chat: pardner does not start and the message says to move the file aside. It never
converts, deletes or rewrites such a file. If
the chat or the agent running is not the one the file names, pardner does not start and the
message names both pairs. When the chat changed, move the file aside and bind the channels again;
when only the agent changed, choose the agent the file names, or move the file aside.

pardner keeps `state.json` clean on its own: when it starts and every 6 hours. It forgets only
what an answer from the chat makes certain: a channel the chat says is gone, with its threads; a
thread whose first message is gone; a thread with no session opened more than a day ago. Anything
it cannot tell for certain stays (a rate limit or a server error removes nothing), and so does a
thread or a channel with a session open at that moment. Each thread the cleanup prunes gets a log
line with its ids and the reason. The rules are in
[Cleaning `state.json`](architecture.md#cleaning-statejson).

### Restarts and shutdown

On `SIGTERM` pardner stops starting turns and lets everything already running finish: the
turns, the background commands and agents, which end with the Claude Code process, and the turn in
which Claude reports each one. Then it exits, and `KeepAlive` starts it again. Meanwhile a new
message gets `pardner is updating, stopping or restarting; unless it is stopping, send this again in a moment.`, a queued one ends with
the same request. Under that sentence the refusal lists each thread the restart still waits for,
with a link to it and what holds it there (a turn, an approval or a question waiting for you,
background tasks), so you know where to answer or send `/stop`; `/status` typed in a channel
lists that channel's threads the same way and counts those of other channels without naming
them, since its answer is a post every member of the channel reads. An approval or a question Claude asks meanwhile stays open and can be answered, so
a session that restarts the daemon can still finish its turn. The daemon's `/words` keep working:
`/stop` ends a long turn so the restart goes on. A thread left with only background tasks says so
when the chat can show an activity line (`Stop or restart waits for 1 shell · /stop ends it now`), since
pardner cannot tell whether a task such as a dev server ever ends; `/stop` there stops
them and the restart goes on. A restart posts nothing in a thread that has nothing running, bypass on or not, since
bypass outlives it. The signal does not say who sent it, and a session that sends it
has a turn running at that moment: for every session with a turn running when the signal arrives,
pardner waits for the turn but not for a background task the session starts after the
signal, such as a loop waiting for the new process, which could only end once this one has exited.
The shutdown ends those tasks. After 29 minutes pardner stops waiting and ends what still
runs, whose replies say that it stopped. Sending the signal a second time stops without waiting.
`SIGINT` (Ctrl-C in a terminal) stops without waiting too, because the terminal sends it to the
Claude Code processes as well. Once it has stopped waiting, the shutdown itself goes on for as long as it completes steps (the connection, each session, the chat). If 30 seconds pass with no step
completing, for instance on a start of Claude Code that never answers, the daemon ends the process
with exit status 1 and `KeepAlive` starts a new one. The next start's repair ends the replies the
stop left open; the note that lists the messages that were not sent is not written.

How long a turn can take to finish depends on who sends the signal. `launchctl kill TERM` only
sends it, so a restart waits up to those 29 minutes. `launchctl bootout` and `launchctl
kickstart -k` stop the job themselves and kill it `ExitTimeOut` seconds later; on macOS 27.0
launchd caps `ExitTimeOut` at 60 (row "ExitTimeOut cap" of [Measured platform behaviour](architecture.md#measured-platform-behaviour)). A turn still running
then ends with its reply cut short.

`launchctl kill TERM` returns at once, so a Claude Code session running from the chat can restart
the daemon that hosts it and still finish its turn. `launchctl kickstart -k` waits until the old
instance has exited, which from such a session means waiting on its own turn, until launchd
kills the daemon and that turn with it after `ExitTimeOut`.

### What a session takes from Claude Code

The models a new thread offers are the ones Claude Code lists, older versions included. To offer
fewer, set Claude Code's `modelPicker` with `replaceBuiltInOptions: true` in
`~/.claude/settings.json` (Claude Code reads it only from user or managed settings); it changes
the terminal's `/model` picker the same way. Rows naming an alias (`opus`, `sonnet`, `haiku`)
follow the newest version of that model.

When Claude Code is logged out, a message in the chat replies with a note asking you to run `claude`
and `/login` on the machine; the login is never done from the chat. `/login` and `/logout` typed in
the chat get the same pointer to the machine and are never sent to Claude Code.

If you turn on Claude Code's Bash sandbox, do it in your own settings, where it applies to the
terminal and to the chat alike. Its auto-allow mode runs sandboxed Bash commands without asking,
so they would not reach the chat for approval.

The MCP servers you set up in Claude Code are available to a session started from the chat. A
server that needs you to sign in is signed in on the machine: run `claude mcp login <name>`, or
`/mcp` in the terminal. Computer use, and the commands Claude Code keeps for its interactive
terminal, are not available from the chat: [limits.md](limits.md) lists what differs from the
terminal and whose limit each is. Commands, scripts and command-line tools run from the chat as
they do in the terminal.

Claude Code's [Chrome integration](https://code.claude.com/docs/en/chrome) follows your choice in
Claude Code. When `/chrome` shows **Enabled by default: Yes** in the terminal, a session started
from the chat has the browser tools too, and Claude opens its tabs in the Chrome running on the
machine, with your sign-ins. Nothing about it is set in pardner: turn it on or off with
`/chrome` in the terminal, and a thread follows the change from its next start or resume. The
permissions are Claude Code's own: when it asks before a browser action, the request reaches
the chat as an approval request, and the sites Claude may act on are the ones the
extension allows. Chrome has to be open, with the extension signed in to the account Claude Code
uses.

### How trust applies to git

A worktree is covered by its main checkout while git registers it there: after moving a
worktree's folder by hand, run `git worktree repair` in it. The footer and `/status` show the
branch and the uncommitted lines, `/open` lists the changed files and `/diff` their diffs, only where git may run: in
a repository you trusted in Claude Code. A trusted folder does not stand for a repository inside
it. A bound folder that is not a repository itself and holds one a level or two below it shows
them for that repository once you open `claude` in it and accept the trust dialog. Without that
trust the footer says `git: not trusted` in place of the branch and the lines, and `/status` shows
`Git: not trusted` and names the repository with the line that asks for the trust. Nothing is posted
in the thread for it. This also covers a folder that becomes a repository mid-session (after `git init`) when
Claude Code trusted it only through a parent folder: a folder trusted at its own path becomes a trusted
repository and shows its branch at once. Once you open `claude` in the folder and accept the trust dialog,
the next footer shows the branch again with no restart. `/open` lists no changed files there, `/diff` is refused, and
its search reads that repository from disk, the files its `.gitignore` names included.

The answer to `/bind`, and `/status` inside a thread, name the repositories one or two levels
below the folder that have no trust of their own yet, at most ten, each with the line to run in
the terminal: `cd <repository> && claude`, with `CLAUDE_CONFIG_DIR` before `claude` for an
instance with its own login. Accepting the dialog there gives the trust, and the next `/status`
no longer names that repository. Read a repository's `.claude/` settings and hooks before you
accept: they run without asking once it is trusted. A bound folder inside a repository you
trusted names none.

### Upgrading from one session per channel

A channel bound by a version that held one session per channel keeps its directory, loses its old
session pointer and bypass switch, and gets this message once, posted top-level, not as a reply:

> pardner now runs one Claude Code session per thread. Send a new message in the channel
> to start a session; reply in its thread to continue it. The session this channel had is still
> in the folder: /resume brings it into a thread. Bypass is now set per session: send /bypass on
> inside a thread.
