export type CompletionShell = "bash" | "zsh" | "fish";

const ROOT_COMMANDS = [
  "init",
  "list",
  "switch",
  "onboard",
  "status",
  "web",
  "task",
  "phase",
  "config",
  "discover",
  "worktree",
  "completion",
  "help",
  "--help",
  "-h",
];

const TASK_SUBCOMMANDS = ["list", "start", "retry", "logs", "reset"];
const PHASE_SUBCOMMANDS = ["active", "run"];
const CONFIG_SUBCOMMANDS = ["show", "mode", "assignee", "usage"];
const WEB_SUBCOMMANDS = ["start", "stop", "serve"];
const WORKTREE_SUBCOMMANDS = ["list", "prune"];
const ASSIGNEES = ["CODEX_CLI", "CLAUDE_CLI", "GEMINI_CLI", "MOCK_CLI"];
const COMPLETION_SHELLS: CompletionShell[] = ["bash", "zsh", "fish"];

function joinWords(values: string[]): string {
  return values.join(" ");
}

function buildBashCompletion(): string {
  return `# IxADO bash completion\n_ixado_completion() {\n  local cur\n  cur=\"${"${COMP_WORDS[COMP_CWORD]}"}\"\n\n  if [[ ${"${COMP_CWORD}"} -eq 1 ]]; then\n    COMPREPLY=( $(compgen -W \"${joinWords(ROOT_COMMANDS)}\" -- \"${"${cur}"}\") )\n    return\n  fi\n\n  case \"${"${COMP_WORDS[1]}"}\" in\n    task)\n      if [[ ${"${COMP_CWORD}"} -eq 2 ]]; then\n        COMPREPLY=( $(compgen -W \"${joinWords(TASK_SUBCOMMANDS)}\" -- \"${"${cur}"}\") )\n      fi\n      ;;\n    phase)\n      if [[ ${"${COMP_CWORD}"} -eq 2 ]]; then\n        COMPREPLY=( $(compgen -W \"${joinWords(PHASE_SUBCOMMANDS)}\" -- \"${"${cur}"}\") )\n      elif [[ ${"${COMP_CWORD}"} -eq 3 && \"${"${COMP_WORDS[2]}"}\" == \"run\" ]]; then\n        COMPREPLY=( $(compgen -W \"auto manual\" -- \"${"${cur}"}\") )\n      fi\n      ;;\n    config)\n      if [[ ${"${COMP_CWORD}"} -eq 2 ]]; then\n        COMPREPLY=( $(compgen -W \"${joinWords(CONFIG_SUBCOMMANDS)}\" -- \"${"${cur}"}\") )\n      elif [[ ${"${COMP_CWORD}"} -eq 3 && \"${"${COMP_WORDS[2]}"}\" == \"mode\" ]]; then\n        COMPREPLY=( $(compgen -W \"auto manual\" -- \"${"${cur}"}\") )\n      elif [[ ${"${COMP_CWORD}"} -eq 3 && \"${"${COMP_WORDS[2]}"}\" == \"assignee\" ]]; then\n        COMPREPLY=( $(compgen -W \"${joinWords(ASSIGNEES)}\" -- \"${"${cur}"}\") )\n      elif [[ ${"${COMP_CWORD}"} -eq 3 && \"${"${COMP_WORDS[2]}"}\" == \"usage\" ]]; then\n        COMPREPLY=( $(compgen -W \"on off\" -- \"${"${cur}"}\") )\n      fi\n      ;;\n    web)\n      if [[ ${"${COMP_CWORD}"} -eq 2 ]]; then\n        COMPREPLY=( $(compgen -W \"${joinWords(WEB_SUBCOMMANDS)}\" -- \"${"${cur}"}\") )\n      fi\n      ;;\n    completion)\n      if [[ ${"${COMP_CWORD}"} -eq 2 ]]; then\n        COMPREPLY=( $(compgen -W \"${joinWords(COMPLETION_SHELLS)}\" -- \"${"${cur}"}\") )\n      fi\n      ;;\n    worktree)\n      if [[ ${"${COMP_CWORD}"} -eq 2 ]]; then\n        COMPREPLY=( $(compgen -W \"${joinWords(WORKTREE_SUBCOMMANDS)}\" -- \"${"${cur}"}\") )\n      fi\n      ;;\n  esac\n}\n\ncomplete -F _ixado_completion ixado\n`;
}

function buildZshCompletion(): string {
  return `#compdef ixado\n\n_ixado() {\n  local -a commands\n  commands=(\n    'init:Register current directory as project'\n    'list:List registered projects'\n    'switch:Switch active project context'\n    'onboard:Run interactive onboarding'\n    'status:Show project status'\n    'web:Web control center commands'\n    'task:Task commands'\n    'phase:Phase commands'\n    'config:Configuration commands'\n    'discover:Discover TODO/FIXME candidates'\n    'worktree:Manage git worktrees'\n    'completion:Generate shell completion script'\n    'help:Show help'\n  )\n\n  local context state line\n  _arguments -C \\\n    '1:command:->command' \\\n    '2:subcommand:->subcommand' \\\n    '3:argument:->argument'\n\n  case $state in\n    command)\n      _describe 'command' commands\n      ;;\n    subcommand)\n      case $line[1] in\n        task) _values 'task subcommand' ${joinWords(TASK_SUBCOMMANDS)} ;;\n        phase) _values 'phase subcommand' ${joinWords(PHASE_SUBCOMMANDS)} ;;\n        config) _values 'config subcommand' ${joinWords(CONFIG_SUBCOMMANDS)} ;;\n        web) _values 'web subcommand' ${joinWords(WEB_SUBCOMMANDS)} ;;\n        worktree) _values 'worktree subcommand' ${joinWords(WORKTREE_SUBCOMMANDS)} ;;\n        completion) _values 'shell' ${joinWords(COMPLETION_SHELLS)} ;;\n      esac\n      ;;\n    argument)\n      case $line[1]:$line[2] in\n        config:mode) _values 'mode' auto manual ;;\n        config:assignee) _values 'assignee' ${joinWords(ASSIGNEES)} ;;\n        config:usage) _values 'toggle' on off ;;\n        phase:run) _values 'mode' auto manual ;;\n      esac\n      ;;\n  esac\n}\n\n_ixado \"$@\"\n`;
}

function buildFishCompletion(): string {
  return `# IxADO fish completion\ncomplete -c ixado -f\n\n# top-level commands\n${ROOT_COMMANDS.filter(
    (command) => !command.startsWith("-"),
  )
    .map(
      (command) =>
        `complete -c ixado -n '__fish_use_subcommand' -a '${command}'`,
    )
    .join(
      "\n",
    )}\n\n# nested subcommands\n${TASK_SUBCOMMANDS.map((sub) => `complete -c ixado -n '__fish_seen_subcommand_from task' -a '${sub}'`).join("\n")}\n${PHASE_SUBCOMMANDS.map((sub) => `complete -c ixado -n '__fish_seen_subcommand_from phase' -a '${sub}'`).join("\n")}\n${CONFIG_SUBCOMMANDS.map((sub) => `complete -c ixado -n '__fish_seen_subcommand_from config' -a '${sub}'`).join("\n")}\n${WEB_SUBCOMMANDS.map((sub) => `complete -c ixado -n '__fish_seen_subcommand_from web' -a '${sub}'`).join("\n")}\n${WORKTREE_SUBCOMMANDS.map((sub) => `complete -c ixado -n '__fish_seen_subcommand_from worktree' -a '${sub}'`).join("\n")}\n${COMPLETION_SHELLS.map((shell) => `complete -c ixado -n '__fish_seen_subcommand_from completion' -a '${shell}'`).join("\n")}\n\n# argument values\ncomplete -c ixado -n '__fish_seen_subcommand_from config; and __fish_seen_subcommand_from mode' -a 'auto manual'\ncomplete -c ixado -n '__fish_seen_subcommand_from config; and __fish_seen_subcommand_from assignee' -a '${joinWords(ASSIGNEES)}'\ncomplete -c ixado -n '__fish_seen_subcommand_from config; and __fish_seen_subcommand_from usage' -a 'on off'\ncomplete -c ixado -n '__fish_seen_subcommand_from phase; and __fish_seen_subcommand_from run' -a 'auto manual'\n`;
}

export function generateCompletionScript(shell: CompletionShell): string {
  if (shell === "bash") {
    return buildBashCompletion();
  }

  if (shell === "zsh") {
    return buildZshCompletion();
  }

  return buildFishCompletion();
}

export function parseCompletionShell(
  rawShell: string | undefined,
): CompletionShell {
  const shell = rawShell?.trim().toLowerCase();
  if (!shell || !COMPLETION_SHELLS.includes(shell as CompletionShell)) {
    throw new Error("Usage: ixado completion <bash|zsh|fish>");
  }

  return shell as CompletionShell;
}
