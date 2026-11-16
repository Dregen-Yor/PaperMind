# GitHub CLI Guide

These rules apply to coding agents participating in projects with multiple contributors, parallel implementation, and code review. The default main branch is `main` and the default remote is `origin`; confirm the project's actual configuration before proceeding. Honor existing user authorization and project conventions. Do not automatically interpret an implementation task as authorization to commit, push, merge, or delete; do not request confirmation again for actions already explicitly authorized.

Use English for all written content in the workflows covered by these guidelines, including commit subjects, bodies and footers, PR titles and descriptions, issues, reviews, comments, and reports. Keep technical identifiers in their original form.

Common commands below are templates, not instructions to execute every operation. Replace uppercase placeholders such as `TASK_BRANCH`, `FILE_PATH`, `PR_NUMBER`, and `OWNER/REPO` with verified values, quote paths where needed, and choose only the commands appropriate to the task and existing authorization. `origin` and `main` must be adjusted if the repository uses different names.

## GitHub CLI (gh)

Use `git` for local history and remote synchronization, and prefer `gh` for GitHub PRs, Issues, reviews, and Actions when available. Follow the Branch, Commit, and Worktree rules in [Git Practices](git-practices.md) and the rules in [PR Review and Delivery](pr-preview.md); the CLI does not grant additional authorization.

### Repository and Authentication

- Before GitHub operations for a task, check `gh auth status` and confirm the active account, remote repository, source branch, target branch, and any fork relationship. Recheck when the context or credentials change. Successful SSH Git access does not establish gh API authentication.
- Resolve the intended repository from the actual Git remotes. Use `--repo OWNER/REPO` when the current directory is ambiguous or the operation targets another repository; never infer the repository solely from a branch name or PR number.
- Keep tokens and credentials out of tracked files, PR descriptions, and command output. Use existing gh authentication instead of embedding tokens in commands.
- Carry forward explicit user authorization. Installing or authenticating gh does not authorize commits, pushes, PR publication, review submissions, merges, deletions, or changes to repository rules. Do not ask again for actions already authorized.

Verify authentication and the repository without displaying tokens:

```bash
gh auth status
gh api user --jq .login
git remote -v
gh repo view --json nameWithOwner,url,defaultBranchRef
```

`gh repo view` checks gh's selected repository; compare it with the intended remote. On authentication or permission errors, investigate the specific error; do not print tokens or launch a new login flow unnecessarily.

### PR Delivery and Feedback

- After implementation, local validation, self-review, and authorized commit/push, find any existing PR for the task branch before creating one. Confirm its repository, head, base, and state; update the same open PR for the same deliverable.
- Create PRs with explicit `--base` and `--head`. Prepare multiline descriptions in a temporary file and pass `--body-file`; follow the PR title and content rules in [PR Review and Delivery](pr-preview.md). Use the real PR URL or number returned by GitHub for subsequent operations.
- Inspect actual changes with `gh pr diff`. Read discussion, review decisions, inline review comments, and checks as needed; `gh pr view --comments` alone is not a complete review record. Use `gh api` for missing details, including pagination where necessary.
- Query CI with `gh pr checks`. For failing GitHub Actions jobs, identify the relevant run and use `gh run view RUN_ID --log-failed` to investigate before changing code. For external checks, follow their reported details; do not assume all checks are Actions jobs.
- Address verified feedback and failures on the original task branch, validate the fix, and push only within authorization. Refresh the PR description and request renewed review when substantive changes require it.
- Prefer supported `--json` fields and `--jq` for programmatic decisions. Check command exit status and distinguish network/authentication failures from repository state; failed queries do not establish that a PR or check is absent.

Find the task's existing PR, including closed or merged ones, before creating another:

```bash
gh pr list --repo OWNER/REPO --head TASK_BRANCH --state all \
  --json number,url,state,headRefName,baseRefName
```

After an authorized push, create or update the PR using a prepared description file. These are alternatives depending on whether a PR already exists:

```bash
gh pr create --repo OWNER/REPO --base main --head TASK_BRANCH \
  --title 'docs(workflow): add agent delivery command examples' \
  --body-file /tmp/task-pr-description.md

# Existing PR: update its description instead of creating a duplicate

gh pr edit PR_NUMBER --repo OWNER/REPO --body-file /tmp/task-pr-description.md
```

Read the published diff, discussion, submitted reviews, and inline review comments:

```bash
gh pr diff PR_NUMBER --repo OWNER/REPO
gh pr view PR_NUMBER --repo OWNER/REPO --comments
gh pr view PR_NUMBER --repo OWNER/REPO --json reviews,reviewDecision
gh api --paginate repos/OWNER/REPO/pulls/PR_NUMBER/comments
```

Review submissions are external writes requiring authorization. For an authorized review, use `gh pr review PR_NUMBER --repo OWNER/REPO --request-changes --body-file /tmp/task-review.md` or the appropriate `--comment` / `--approve` action, based on the actual findings and reviewer eligibility. To request an authorized review, use `gh pr edit PR_NUMBER --repo OWNER/REPO --add-reviewer REVIEWER_LOGIN`.

Investigate checks and the run associated with the current PR head:

```bash
gh pr checks PR_NUMBER --repo OWNER/REPO
gh pr view PR_NUMBER --repo OWNER/REPO --json headRefOid
gh run list --repo OWNER/REPO --branch TASK_BRANCH --commit HEAD_SHA \
  --json databaseId,headSha,event,status,conclusion,url
gh run view RUN_ID --repo OWNER/REPO --log-failed
```

Replace `HEAD_SHA` with the queried head SHA and select the relevant run rather than assuming the most recent run is correct. PR workflows may report a synthetic merge SHA; confirm the run event, linked check, and PR revision when this filter yields no result. A successful log query does not mean the job passed. Use `gh pr checks PR_NUMBER --repo OWNER/REPO --watch --interval 10` only when a bounded wait is useful; keep waits interruptible and continue communicating during long runs.

### Merge and Verification

- Before merging, refresh the PR state and confirm its current head commit, target branch, mergeability, required reviews, blocking feedback, and checks. Verify results belong to the latest head and satisfy the latest-target validation required by the PR rules.
- Distinguish successful, failed, pending, skipped, absent, and unavailable checks. Absence of CI is not evidence of passing validation; report the gap and satisfy the project's actual requirements. Recheck after new commits or relevant target-branch changes.
- Merge only with user authorization and the project's agreed merge method. When using `gh pr merge`, pass `--match-head-commit` with the reviewed head SHA to avoid merging a different head. Do not bypass checks or reviews with `--admin`, or enable auto-merge, without specific authorization.
- After a merge command, query GitHub to confirm the resulting state and report the PR URL and actual outcome. A queued or scheduled merge is not a completed merge. Do not add branch deletion flags unless cleanup is authorized and the Branch/Worktree conditions are met.
- Agents sharing a gh login share one GitHub identity. Internal cross-agent review does not satisfy an independent-account approval requirement, and PR authors cannot approve their own PRs. Report unmet review requirements instead of simulating approval.
- gh reads and acts on existing GitHub configuration; it does not supply missing tests or enforce AGENTS.md on the server. Respect branch protection and rulesets, and do not alter them to make a task pass without explicit authorization.

Refresh state immediately before an authorized merge:

```bash
gh pr view PR_NUMBER --repo OWNER/REPO \
  --json url,state,isDraft,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup
gh pr checks PR_NUMBER --repo OWNER/REPO

# Example only when squash is the agreed method and the head was verified

gh pr merge PR_NUMBER --repo OWNER/REPO --squash --match-head-commit HEAD_SHA

# Confirm completion instead of assuming the merge command completed it

gh pr view PR_NUMBER --repo OWNER/REPO --json url,state,mergedAt,mergeCommit
```

`HEAD_SHA` must be the exact revision inspected and validated. Choose `--merge` or `--rebase` instead only if that is the agreed method. Merge queues and branch rules can defer completion; inspect the returned state before reporting success. Refresh local remote-tracking refs with `git fetch origin` afterward. Update local main with `git switch main` followed by `git merge --ff-only origin/main` only in its owning worktree, when its working state is safe; stop on divergence rather than resetting it.
