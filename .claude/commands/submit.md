---
name: submit
description: Execute the official submission process (branch, commit, push, PR, monitor, merge)
---
Execute the official submission process defined in AGENTS.md.

Follow these steps precisely:
1. **Branching**:
   - Check current branch. If on `main`, create a new branch using `git checkout -b <type>/<description>`. Use Conventional Commit types (feat, fix, docs, refactor, chore, test).
2. **Committing**:
   - Run `git status` and `git diff` to analyze changes.
   - Stage relevant files.
   - Create a commit using a Conventional Commit message.
3. **Pushing**:
   - Push the branch to origin using `git push -u origin <branch-name>`.
4. **Pull Request**:
   - Use `gh pr create` to create a PR.
   - The PR body must include a Summary and a Test plan.
5. **Monitoring**:
   - Use `gh pr checks --watch` to monitor the CI pipeline.
   - If checks fail, fix the issues on the branch, commit, and push again.
6. **Merging**:
   - Once checks pass, merge the PR using `gh pr merge --squash --delete-branch`.
7. **Cleanup**:
   - Return to `main` and pull the latest changes:
     ```bash
     git checkout main
     git pull origin main
     ```
   - In a git worktree `main` is checked out in the main checkout, so `git checkout main` fails (`gh pr merge` prints the same error after merging). Run both against the main checkout instead:
     ```bash
     MAIN_DIR="$(git worktree list --porcelain | sed -n '1s/^worktree //p')"
     git -C "$MAIN_DIR" checkout main
     git -C "$MAIN_DIR" pull origin main
     ```
   - When you worked in a worktree, remove it afterwards (each one holds 1–2 GB of `node_modules` and `.next`). Plain `git worktree remove` refuses if anything is uncommitted; if it does, stop and tell the user rather than forcing it:
     ```bash
     WT_DIR="$(git rev-parse --show-toplevel)"
     git -C "$MAIN_DIR" worktree remove "$WT_DIR"
     git -C "$MAIN_DIR" worktree prune
     ```

Always report progress to the user at each step.
