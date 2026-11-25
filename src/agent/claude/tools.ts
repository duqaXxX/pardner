/**
 * The tools Claude Code's terminal shows in words or in a preview of its own, which the core
 * draws from `ToolVocabulary`. Each table below keeps the capture it comes from.
 */
import type { ToolVocabulary } from "../seam.ts";

/**
 * The tools Claude Code offers, by name: the built-in ones its `init` records list in
 * `test/fixtures/sdk/` (Claude Code 2.1.286 to 2.1.330), the ones a session offers only in some
 * modes (`Agent`, `AskUserQuestion`, `ExitPlanMode`, `TodoWrite`), the names the core's
 * renderer test banned before the vocabulary left the core, and the names of earlier releases
 * (`Grep`, `Glob`, `LS`, `MultiEdit`, `BashOutput`, `KillShell`, `NotebookRead`), so that none
 * of them is drawn by the core either. `test/agent/claude/tool-names.test.ts` holds every
 * non-MCP name of those records to be listed here.
 */
export const TOOL_NAMES: readonly string[] = Object.freeze([
  "Agent",
  "AskUserQuestion",
  "Bash",
  "BashOutput",
  "CronCreate",
  "CronDelete",
  "CronList",
  "DesignSync",
  "Edit",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Glob",
  "Grep",
  "KillShell",
  "LS",
  "ListAgents",
  "ListMcpResourcesTool",
  "LSP",
  "Monitor",
  "MultiEdit",
  "NotebookEdit",
  "NotebookRead",
  "PushNotification",
  "Read",
  "ReadMcpResourceDirTool",
  "ReadMcpResourceTool",
  "RemoteTrigger",
  "ReportFindings",
  "ScheduleWakeup",
  "SendMessage",
  "SendToProject",
  "SendToProjectContext",
  "Skill",
  "Task",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskStop",
  "TaskUpdate",
  "TodoWrite",
  "ToolSearch",
  "WebFetch",
  "WebSearch",
  "Workflow",
  "Write",
]);

export const TOOLS: ToolVocabulary = Object.freeze({
  // How the terminal folds finished calls of these tools. Captured from the terminal on Claude
  // Code 2.1.283 (2026-09-27), where Bash also does the searching (the CLI has no Grep or Glob
  // tool): `echo hi` read `Ran 1 shell command`, `ls` `Listed 1 directory`, a grep `Searched for
  // 1 pattern`. That classification of the command is undocumented, so every Bash call reads as a
  // shell command.
  words: Object.freeze<ToolVocabulary["words"]>({
    Bash: ["Ran {n} shell command", "Ran {n} shell commands"],
    Read: ["Read {n} file", "Read {n} files"],
  }),
  // The terminal names an edit `Update`, and a Write over an existing file keeps `Write`.
  previews: Object.freeze({ Edit: "Update", Write: "Write" }),
  askers: Object.freeze(["AskUserQuestion"]),
  launchers: Object.freeze(["Agent"]),
  // A command that exits with an error was seen counted in `ran 4 shell commands` (captured on
  // Claude Code 2.1.296, 2026-10-13). No other tool's failure was captured.
  failsCounted: Object.freeze(["Bash"]),
  // A command's running line reads its description (`Sleeping 20 seconds then printing
  // marker`), with the command itself under it.
  described: Object.freeze({ Bash: "description" }),
  // The input key that names a file; the transcript records it absolute (measured on SDK 0.3.330,
  // 2026-11-24). NotebookEdit is deferred, so a ToolSearch call precedes it.
  files: Object.freeze({
    Read: "file_path",
    Edit: "file_path",
    Write: "file_path",
    NotebookEdit: "notebook_path",
  }),
  // A running command's line in the terminal reads `$ <command> (5s)` (captured on Claude Code
  // 2.1.301, 2026-10-16).
  commanded: Object.freeze({ Bash: "command" }),
  // The terminal draws no line for a call that continues an agent already started, and writes
  // `Resuming agent` under the agent (captured on Claude Code 2.1.301, 2026-10-16).
  continuers: Object.freeze({ SendMessage: "to" }),
  // The tool that asks the owner to approve a plan, and the two keys its input holds (measured on
  // SDK 0.3.303, 2026-10-20).
  plan: Object.freeze({
    tool: "ExitPlanMode",
    keys: Object.freeze(["plan", "planFilePath"]),
    text: "plan",
  }),
});
