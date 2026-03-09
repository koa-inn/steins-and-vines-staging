---
name: weekly-docs-validation
description: "Weekly documentation validation and update for the Steins & Vines codebase"
schedule: "0 6 * * 1"
---

You are performing a weekly documentation validation and update for the Steins & Vines project.

## Objective

Audit all project documentation against the current codebase and produce a report of what is outdated, missing, or inaccurate. Fix any straightforward issues directly. Flag everything else for manual review.

## Workspace

The project is a static HTML + vanilla JS (ES5) frontend deployed on GitHub Pages, with an Express middleware backend in the `zoho-middleware/` subdirectory deployed on Railway. It integrates with Zoho Books/Inventory/Bookings, Global Payments, and Redis.

## Steps

### 1. Inventory Current Documentation

Read these documentation files if they exist:

- `README.md` (project root)
- `docs/API.md`
- `docs/DEPLOYMENT.md`
- `docs/ARCHITECTURE.md`
- `zoho-middleware/.env.example`
- `TESTING.md`
- `style_guide.md`

### 2. Audit Against Codebase

For each documentation file, check for drift:

**README.md:**
- Compare the project structure tree against actual files and directories using `ls` and `find`.
- Verify listed npm scripts still exist in both `package.json` files (root and `zoho-middleware/`).
- Check that the tech stack description matches current `package.json` dependencies.

**API.md:**
- List all route files in `zoho-middleware/routes/` and compare against documented endpoints.
- For each route file, grep for `router.get`, `router.post`, `router.put`, `router.delete` and verify every endpoint is documented.
- Check that documented rate limits match the values in `zoho-middleware/server.js`.

**DEPLOYMENT.md:**
- Verify deployment steps still match the repository structure (two-repo model: staging + production).
- Check that environment variable references are still valid against `.env.example`.

**ARCHITECTURE.md:**
- Verify the described architecture matches the current codebase structure.
- Check that referenced files and modules still exist at the documented paths.

**.env.example:**
- Grep all `process.env.` references across the entire `zoho-middleware/` directory.
- Compare against variables listed in `.env.example`.
- Flag any new env vars that are not documented.

**TESTING.md:**
- Check that described test commands still work by reading `package.json` scripts.
- Verify coverage thresholds documented in TESTING.md match the values in `jest.config.js` (root) and `zoho-middleware/jest.config.js`.
- Check that campaign progress is accurate against actual test files.

### 3. Apply Fixes

For straightforward issues, make the fixes directly:
- New files or directories to add to the README project structure tree
- New environment variables to add to `.env.example`
- New endpoints to add to `API.md`
- Updated dependency versions in the tech stack section

For complex issues (architectural changes, major restructuring, unclear intent), document them in the report but do NOT modify the files.

### 4. Produce Report

Create or overwrite `docs-validation-report.md` in the project root with:

- Date of validation run
- Summary of findings (what was checked, what passed, what failed)
- List of auto-fixed items with before/after descriptions
- List of items requiring manual attention with specific details
- Any new GitHub Issue recommendations formatted as:
  `| Title | Labels | Priority | Description |`

### 5. Success Criteria

- All documentation files checked against current codebase state
- Straightforward fixes applied directly with clear descriptions
- Report produced with pass/fail status for each documentation file
- Zero false positives — verify every finding by reading the actual source file before flagging it
