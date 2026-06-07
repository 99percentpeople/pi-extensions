# Git Workflow Skill

Teaches the agent how to follow a structured git workflow with commits, branches, and pull requests.

## When to Use

Use this skill when the user asks to:
- Commit changes
- Create a branch
- Work on a feature
- Prepare a pull request
- Review git history

## Instructions

### Commit Workflow

1. **Check status**: Always run `git status` first
2. **Review changes**: Run `git diff` to see what changed
3. **Stage changes**: Use `git add` for specific files or `git add .` for all
4. **Write commit message**: Follow conventional commits format
5. **Push changes**: Push to the appropriate branch

### Commit Message Format

Use conventional commits format:

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, missing semi-colons, etc.)
- `refactor`: Code refactoring
- `perf`: Performance improvements
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

**Examples:**
```
feat(auth): add JWT token refresh
fix(api): handle null response from user service
docs(readme): update installation instructions
refactor(utils): extract validation logic
```

### Branch Naming

Use descriptive branch names:

```
feature/description
bugfix/description
hotfix/description
docs/description
```

**Examples:**
```
feature/user-authentication
bugfix/login-redirect
hotfix/security-patch
docs/api-reference
```

### Pull Request Workflow

1. **Create branch**: `git checkout -b feature/description`
2. **Make changes**: Implement the feature
3. **Commit**: Follow commit workflow above
4. **Push**: `git push origin feature/description`
5. **Create PR**: Use `gh pr create` or GitHub UI
6. **Review**: Address any review comments
7. **Merge**: Merge after approval

### Git Best Practices

- **Commit often**: Small, focused commits are better than large ones
- **Write clear messages**: Explain what and why, not how
- **Keep history clean**: Use `git rebase` to clean up before merging
- **Don't commit secrets**: Use `.gitignore` for sensitive files
- **Pull before push**: Always pull latest changes before pushing

### Common Commands

```bash
# Check status
git status

# View changes
git diff
git diff --staged

# Stage changes
git add <file>
git add .

# Commit
git commit -m "type(scope): description"

# Push
git push origin <branch>

# Pull
git pull origin <branch>

# Create branch
git checkout -b <branch-name>

# Switch branch
git checkout <branch-name>

# View history
git log --oneline
git log --graph --oneline --all

# Stash changes
git stash
git stash pop

# Undo changes
git checkout -- <file>
git reset HEAD <file>
```

### Conflict Resolution

When conflicts occur:

1. **Identify conflicts**: Run `git status`
2. **Edit files**: Resolve conflicts manually
3. **Stage resolved**: `git add <resolved-files>`
4. **Continue**: `git rebase --continue` or `git merge --continue`

### Safety Rules

- **Never force push to main/master**
- **Never rewrite published history** (unless team agrees)
- **Always pull before push**
- **Use `--force-with-lease`** if force push is needed
- **Create backup branches** before risky operations
