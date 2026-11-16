# PR Review and Delivery

These rules apply to coding agents participating in projects with multiple contributors, parallel implementation, and code review. The default main branch is `main` and the default remote is `origin`; confirm the project's actual configuration before proceeding. Honor existing user authorization and project conventions. Do not automatically interpret an implementation task as authorization to commit, push, merge, or delete; do not request confirmation again for actions already explicitly authorized.

Use English for all written content in the workflows covered by these guidelines, including commit subjects, bodies and footers, PR titles and descriptions, issues, reviews, comments, and reports. Keep technical identifiers in their original form.

This document covers pull request preparation, review, and integration. Read [Git Practices](git-practices.md) for task, branch, commit, worktree, and hook requirements, and the [GitHub CLI Guide](gh-guide.md) for GitHub commands.

Common commands below are templates, not instructions to execute every operation. Replace uppercase placeholders such as `TASK_BRANCH`, `FILE_PATH`, `PR_NUMBER`, and `OWNER/REPO` with verified values, quote paths where needed, and choose only the commands appropriate to the task and existing authorization. `origin` and `main` must be adjusted if the repository uses different names.

## PR

- Each PR must represent one logically complete milestone deliverable that can be independently reviewed and integrated. It may contain multiple atomic commits. Do not bundle unrelated tasks merely because they belong to the same phase.
- Open a PR ready for review after the complete deliverable is finished and self-reviewed. Use a Draft PR when early discussion is needed. Confirm the source branch, target branch, and dependencies before creation.
- Use `<type>(<scope>): <summary>` for the title. Summarize the entire deliverable; the title need not match any individual commit subject.
- Use concise paragraphs to explain the problem and goal, key implementation, and final behavior. Use short lists when helpful; fixed sections or checklists are not required.
- Record validation actually performed and its results. Identify unverified items, incompatible changes, migration requirements, and known limitations or risks. Do not enumerate every file or commit, narrate the development process, or make unsupported claims about outcomes.
- Review requirements, the actual diff, and validation evidence rather than relying solely on the implementing agent's summary. Verify and address feedback; explain the reasoning when a suggestion is not adopted.
- Update the title and description when implementation scope changes. Request the relevant review again when substantive changes are added after approval.
- Continue committing and pushing to the original branch for the same task, updating the existing PR. Do not create a new PR for every push.
- Before merging, satisfy acceptance criteria, required CI checks, and review requirements; address blocking feedback and obtain valid verification results for the combination with the latest target branch. Only an authorized contributor may merge, using the project's agreed method.
- Accept and merge independent tasks separately; do not wait for all tasks to finish. When only part of the work is needed, organize or cherry-pick the required commits into a new delivery branch, check dependencies, and validate again without omitting supporting changes.

Before requesting review, inspect the branch deliverable rather than only the last commit:

```bash
git fetch origin
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
git diff origin/main...HEAD
```

Use the actual PR base if it differs from `main`. For a PR already on GitHub, `gh pr diff PR_NUMBER --repo OWNER/REPO` shows its published changes. The [GitHub CLI Guide](gh-guide.md) gives the commands for creation, feedback, and merge.
