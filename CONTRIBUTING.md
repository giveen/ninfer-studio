# Contributing to Ninfier Studio

Thanks for your interest in contributing! This project welcomes issues, pull
requests, and discussion.

## Getting started

1. Fork the repo and clone your fork.
2. Install dependencies: `pnpm install` (Node >= 22, pnpm workspace).
3. Run the app locally: see [README.md](README.md) for the dev/build scripts
   (`pnpm dev`, `pnpm desktop:run`, etc.).
4. Create a branch for your change: `git checkout -b my-feature`.

## Making a change

- Keep pull requests focused — one logical change per PR is easier to review
  than a large mixed one. Squash agent/AI working commits before opening the
  PR — `Agent auto-commit: patched|edited …` messages are blocked by CI (see
  `node scripts/check-commit-hygiene.mjs`): one subject per commit,
  `<type>(<scope>): <what>`, short (≤72 chars preferred, e.g. `fix(coder): …`).
- Match the existing code style in the file/module you're touching.
- Add or update tests where it makes sense for the change.
- Update documentation (README, DESIGN.md, etc.) if your change affects
  behavior described there.

## AI-assisted contributions

Use of AI coding tools (Claude, Copilot, ChatGPT, etc.) is welcome. Please:

- Review and understand any AI-generated code before submitting it — you're
  responsible for your PR regardless of how it was written.
- Disclose AI usage in your pull request (there's a checkbox for this in the
  PR template).
- Make sure AI-generated code follows the same quality bar as the rest of the
  codebase — no unnecessary abstractions, no unused code, no fabricated APIs.

## Submitting a pull request

1. Push your branch and open a PR against `main`.
2. Fill out the PR template, including the AI-usage checkbox.
3. Link any related issues.
4. Be responsive to review feedback — small follow-up commits are fine.

## Reporting bugs / requesting features

Please use the issue templates when opening a new issue — they help us
triage faster.

## Security issues

Do not open a public issue for security vulnerabilities. See
[SECURITY.md](SECURITY.md) for the reporting process.

## License

By contributing, you agree that your contributions will be licensed under the
project's [MIT License](LICENSE).
