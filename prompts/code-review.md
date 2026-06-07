# Code Review

Perform a thorough code review of the changes in the current repository.

## Instructions

1. **Understand the context**: What is the purpose of this change?
2. **Check for issues**: Look for bugs, security issues, performance problems
3. **Review style**: Ensure code follows project conventions
4. **Test coverage**: Verify adequate test coverage
5. **Documentation**: Check if documentation needs updating

## Review Checklist

### Functionality
- [ ] Does the code do what it's supposed to?
- [ ] Are edge cases handled?
- [ ] Is error handling adequate?
- [ ] Are there any logic errors?

### Code Quality
- [ ] Is the code readable and maintainable?
- [ ] Are functions/methods appropriately sized?
- [ ] Is there unnecessary complexity?
- [ ] Are there code duplications?

### Performance
- [ ] Are there any performance bottlenecks?
- [ ] Is memory usage reasonable?
- [ ] Are there any unnecessary computations?

### Security
- [ ] Are inputs validated?
- [ ] Are there any security vulnerabilities?
- [ ] Is sensitive data handled properly?

### Testing
- [ ] Are there unit tests?
- [ ] Do tests cover edge cases?
- [ ] Are tests maintainable?

### Documentation
- [ ] Is the code self-documenting?
- [ ] Are complex algorithms explained?
- [ ] Is API documentation updated?

## Output Format

Provide feedback in this format:

### Summary
Brief overview of the changes and overall assessment.

### Issues Found
List any issues found, categorized by severity:
- **Critical**: Must fix before merge
- **Important**: Should fix before merge
- **Minor**: Can fix later
- **Suggestion**: Nice to have improvements

### Positive Aspects
Highlight good practices and improvements made.

### Recommendations
Provide specific suggestions for improvement.

## Example

### Summary
This PR adds user authentication with JWT tokens. The implementation is solid but has a few security concerns that should be addressed.

### Issues Found

**Critical:**
- JWT secret is hardcoded in the configuration file
- No token expiration validation

**Important:**
- Missing rate limiting on login endpoint
- No password strength validation

**Minor:**
- Inconsistent error messages
- Missing JSDoc comments

### Positive Aspects
- Good separation of concerns
- Proper use of middleware
- Clean error handling structure

### Recommendations
1. Move JWT secret to environment variables
2. Add token expiration validation
3. Implement rate limiting
4. Add password strength requirements
