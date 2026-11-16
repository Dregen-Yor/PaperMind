# Git Practices

These rules apply to coding agents participating in projects with multiple contributors, parallel implementation, and code review. The default main branch is `main` and the default remote is `origin`; confirm the project's actual configuration before proceeding. Honor existing user authorization and project conventions. Do not automatically interpret an implementation task as authorization to commit, push, merge, or delete; do not request confirmation again for actions already explicitly authorized.

Use English for all written content in the workflows covered by these guidelines, including commit subjects, bodies and footers, PR titles and descriptions, issues, reviews, comments, and reports. Keep technical identifiers in their original form.

This document covers task setup, branches, commits, worktrees, and hooks. Read [PR Review and Delivery](pr-preview.md) for pull request requirements and the [GitHub CLI Guide](gh-guide.md) for GitHub commands.

## Starting a Task

- Before making changes, inspect the current directory, branch, working tree status, and existing worktrees. Establish the task scope, acceptance criteria, dependencies, and person or agent responsible for writing changes.
- Preserve changes belonging to others or other tasks. Do not overwrite, revert, stage, or commit them without authorization.
- Recheck the actual state when resuming a task. Do not act solely on previous context.
- Reuse the current task's existing branch and working directory. Do not create new ones for each conversation turn or based on the number of agents.

Common commands below are templates, not instructions to execute every operation. Replace uppercase placeholders such as `TASK_BRANCH`, `FILE_PATH`, `PR_NUMBER`, and `OWNER/REPO` with verified values, quote paths where needed, and choose only the commands appropriate to the task and existing authorization. `origin` and `main` must be adjusted if the repository uses different names.

Inspect the task context before writing or resuming:

```bash
pwd
git branch --show-current
git status --short --branch
git worktree list
git remote -v
git diff --stat
git diff --cached --stat
```

Read relevant existing changes with `git diff -- FILE_PATH` and `git diff --cached -- FILE_PATH`. Use `git ls-files --others --exclude-standard` to identify untracked files; diffs do not show their contents. Do not print credential-bearing remote URLs into shared logs.

## Branch

- Make all changes on task branches, including small changes. Do not develop directly on the main branch; integrate changes into it through PRs.
- Create a branch after the task is defined and before the first modification. For independent tasks, run `git fetch origin` and start from the updated `origin/main`; fetching does not automatically update the local main branch.
- Each branch must represent one clear, verifiable, independently acceptable deliverable. Related implementation, tests, configuration, and documentation may be delivered together. Do not mix unrelated requirements or split work mechanically by file count.
- Base work on another task branch only when there is an explicit dependency on an unmerged task. Record the dependency, merge order, and responsibility for synchronization. After the dependency branch is merged or its history is rewritten, update the baseline and validate again.
- Establish implementation, review, and write-handoff rules. Avoid multiple contributors modifying, staging, or committing in the same working directory simultaneously without coordination.
- Never force-push the main branch. Do not rebase, reset, or force-push shared branches or branches with downstream dependencies without coordination. Follow project conventions when organizing the history of an individual task branch.
- Delete a branch only after the task has ended, contributors have stopped writing, work has been preserved, and dependencies have been handled. Obtain the appropriate authorization before deleting an abandoned task's branch. Do not automatically delete branches merely because they have been inactive.
- Start new tasks from the latest main branch. Do not reuse feature branches whose tasks have ended.

For an independent task using the current directory, first confirm it can be used exclusively and that switching will not carry unrelated changes into the new task:

```bash
git fetch origin
git log -5 --oneline origin/main
git switch -c TASK_BRANCH origin/main
```

For an existing task, inspect its worktree and reuse it; do not repeat branch creation. Use `git branch -vv` to inspect tracking and `git log --oneline origin/main..HEAD` to inspect task commits. `git diff origin/main...HEAD` compares the task against its merge base; after a target update, it does not by itself validate integration with the latest target.

When an updated target must be integrated, fetch first and follow the project's history policy. For a merge-based task branch, `git merge origin/main` integrates the target; resolve conflicts and rerun relevant validation. Do not silently substitute a rebase or reset on a shared branch.

After authorized completion and worktree cleanup, local deletion uses `git branch -d TASK_BRANCH`; remote deletion uses `git push origin --delete TASK_BRANCH`. Inspect `git log --oneline origin/main..TASK_BRANCH` first. Squash merges may leave commits that Git does not classify as merged; verify the PR and preserved result instead of automatically escalating to `-D`.

### Branch Naming

Follow the project's existing naming convention. If none is specified, use:

```text
<type>/<short-description>
```

Base types:

| type | Meaning |
| --- | --- |
| `feat` | New functionality |
| `fix` | Bug fix |
| `refactor` | Code refactoring |
| `perf` | Performance improvement |
| `test` | Test-related changes |
| `docs` | Documentation updates |
| `chore` | Project maintenance |
| `ci` | CI/CD changes |
| `exp` | Exploratory experiments |

- Use extended types such as `hotfix`, `build`, `release`, or `spike` only when established by the project.
- Use lowercase English words and digits, with words separated by `-`. Prefer 2–5 words and a “module + goal” structure.
- Reuse project module names and terminology. Common abbreviations such as `api`, `rag`, and `llm` are allowed.
- Describe the task goal clearly. Avoid `update`, `changes`, and `misc`. Do not use developer names, agent names, or temporary identifiers.

## Commit

### Commit Messages

Follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) and project conventions:

```text
<type>(<scope>): <summary>

<body>

<footer>
```

- **type**: Reuse the base branch type vocabulary, selecting the type according to the actual nature of this commit. It need not match the branch type. Extended branch types do not automatically apply to commits and require a separate convention.
- **scope**: Use the project's existing lowercase English module names, consistently using the same name for the same module. This field is optional; omit the parentheses when omitting it.
- **summary**: Use English, retaining technical identifiers in their original form. Concisely describe the actual change to behavior, objects, or results using action-oriented wording. Avoid vague summaries or wording that depends on chat context.
- **body**: Explain the reason for the change, key approach, tradeoffs, impact, and limitations as needed. Do not mechanically restate the diff.
- **footer**: Record related issues or tasks, breaking changes, and contribution metadata according to the specification and project conventions. Distinguish referencing from closing issues. Do not fabricate authorship, reviews, or sign-offs.
- Both body and footer are optional. Use only a subject line for simple changes; do not generate empty-value prose merely to fill a template.
- Mark incompatible changes with `!` or `BREAKING CHANGE:` and explain the affected consumers and necessary migration steps.
- Write commit messages based on the actual staged diff. Do not describe plans as completed work, exaggerate scope, or fabricate validation results.

### Atomicity and Commit Scope

- Each commit must express one complete change intent, with a single purpose, independently understandable reasoning, and a reasonably self-contained rollback scope.
- Commit necessary implementation, regression tests, configuration, and documentation together. Do not mix in unrelated fixes, repository-wide formatting, or refactoring.
- Each commit must be valid on top of its preceding commits without relying on uncommitted changes. Commit after validation appropriate to the change; do not wait for the entire branch task to finish.
- Commits need not work in isolation from preceding history. Do not split commits mechanically by file count.
- Control staging with explicit file paths or `git add -p`. Add new files explicitly.
- Before committing, run `git diff --cached` to inspect the actual commit contents and use `git status` to check for omitted required files or accidentally included changes belonging to others. Plain `git diff` does not replace inspection of staged changes.
- When partially staging changes, ensure validation results did not depend on unstaged or untracked changes.

Stage and inspect a commit in this order; `git add -p` is an alternative to whole-file staging, not a required second staging step:

```bash
# Inspect unstaged modifications and untracked files first

git diff -- FILE_PATH
git ls-files --others --exclude-standard

# Stage only the intended files, or select hunks interactively

git add -- FILE_PATH
# Alternative for partial staging: git add -p -- FILE_PATH

# Inspect the actual proposed commit, including staged new files

git diff --cached --stat
git diff --cached
git diff --cached --check
git status --short

# After appropriate validation and with commit authorization

git commit -m 'docs(workflow): add agent delivery command examples'
git show --stat --oneline HEAD
```

The commit subject above is an example; write the real subject from the staged diff. `git diff` shows unstaged tracked changes; `git diff --cached` shows staged changes; `git diff HEAD` combines both for tracked files. To remove an accidentally staged path while retaining its working copy, use `git restore --staged -- FILE_PATH` when HEAD exists. Never use `git restore -- FILE_PATH` as an unstaging substitute: it discards unstaged edits.

For an authorized first push, use `git push -u origin TASK_BRANCH`; later pushes can use `git push origin TASK_BRANCH`. Check `git status --short --branch` and `git log -1 --oneline` to confirm the branch and commit before pushing. A local commit does not publish the change.

## Worktree

- Reuse the same working directory throughout a single task. Read-only analysis and review do not require a separate worktree.
- Work directly on a task branch when the task can exclusively use the current directory and no other working state needs to be preserved. Use a separate worktree for concurrent editing or when an existing working state must be preserved.
- Prefer reusing an existing worktree belonging to the current task. Not creating an additional worktree does not permit development directly on the main branch.
- Identify the task, branch, and contributor responsible for writing in each working directory. Inspect the working state before and after handoffs; avoid concurrent writes without coordination.
- Follow the Branch rules for the starting baseline. A new worktree does not automatically include uncommitted changes from the original directory. If the task depends on them, first establish how they will be preserved and transferred.
- Initialize dependencies and local configuration as required by the project. Worktrees do not automatically isolate ports, databases, or external services; coordinate resource use across parallel tasks.
- Deliver work through commits and PRs on task branches, not by manually copying entire working directories.
- After the task has ended, contributors have stopped writing, work has been preserved, and dependencies have been handled, use `git worktree remove` to clean up the working directory and delete the branch separately. Do not force cleanup by default. Follow the applicable authorization when cleaning up abandoned tasks.

For a new independent task that requires a separate worktree, choose an unused path and branch after inspecting `git worktree list`:

```bash
git fetch origin
git worktree add -b TASK_BRANCH WORKTREE_PATH origin/main
git -C WORKTREE_PATH status --short --branch
git -C WORKTREE_PATH branch --show-current
```

For an existing task branch not checked out elsewhere, use `git worktree add WORKTREE_PATH TASK_BRANCH`; otherwise work in its existing worktree. Prepare dependencies using the project's actual setup instructions and coordinate ports before running servers. Recheck `git -C WORKTREE_PATH diff` and `git -C WORKTREE_PATH diff --cached` at handoff.

After cleanup is authorized and writers and services have stopped:

```bash
git -C WORKTREE_PATH status --short --branch
git -C WORKTREE_PATH ls-files --others --exclude-standard
git -C WORKTREE_PATH ls-files --others --ignored --exclude-standard
# Preserve any needed untracked/ignored files before removal

git worktree remove WORKTREE_PATH
git worktree list
```

Run removal from another directory. `git worktree remove` does not delete the branch; handle branch deletion separately under the Branch rules. Do not use `--force` to bypass unpreserved changes or a busy worktree.

## Hook

Run the following general checks according to the project's shared configuration:

- **pre-commit**: Check the actual staged contents for sensitive information, oversized files, and unresolved merge conflicts. Sensitive information includes credentials such as API keys, tokens, and private keys. File size limits and exceptions are defined by the project. Conflict checks include unmerged entries and leftover conflict markers.
- **commit-msg**: Check the Conventional Commits format and the project's rules for type, scope, and summary.

Run linting, type checks, tests, and builds through the project's existing scripts. Do not assume `npm run check` exists or invent file size thresholds or check commands.

Useful pre-commit inspection commands:

```bash
git diff --cached --name-status
git diff --cached --check
git ls-files --unmerged
git diff --cached
# Exact staged blob size in bytes for a candidate added/modified file

git cat-file -s ':FILE_PATH'
```

`git diff --cached --check` detects whitespace errors and introduced conflict markers; `git ls-files --unmerged` must be empty before committing. Inspect staged contents for credentials and use the project's configured secret scanner when one exists. Compare staged blob sizes against the project's actual limits; `--stat` and `--numstat` are not file-size checks. For unusual or binary files, use appropriate inspection tools rather than assuming a text diff covers their contents.

Discover hook configuration with `git config --get core.hooksPath` and `git rev-parse --git-path hooks`; no configured value does not prove hooks are installed or enforced. Read the project's hook setup and commit-message validator before using them. Do not use `--no-verify` to bypass failures without explicit authorization.

Read `package.json` before selecting validation commands. In this project, the existing scripts include `npm test` and `npm run build`; choose checks appropriate to the actual change, record their outcomes, and do not run publishing scripts as validation. Hook checks do not replace functional validation, and installing gh does not add CI or hooks automatically.
