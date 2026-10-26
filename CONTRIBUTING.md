# Contributing

Use Node.js 22.13+ and Python 3. Clone the repository and install the connector's pinned dependencies:

```bash
npm --prefix connector ci
npm test
npm --prefix connector run lint
npm start
```

Open http://127.0.0.1:18766. Make changes on a descriptive `feat/`, `fix/`, `docs/` or `chore/` branch and use Conventional Commit messages. Keep changes focused and add meaningful regression tests for calculation and import changes. Use synthetic readings in tests and examples; never include real bills, meter IDs, passwords, exports or screenshots of household information.

Edit calculation sources in `core/`, then run `node scripts/build-core.mjs` to update the generated copies in `dist/`. HTML, CSS and UI JavaScript in `dist/` are source files and are committed. Update the data guide when the import workflow changes. Connector TypeScript, tests and documentation use Prettier via `npm --prefix connector run format`.

Before a pull request, run the full tests and connector lint, then exercise affected browser flows. Check both a desktop and narrow mobile viewport for UI changes. CSV imports should keep genuine zeros, reject conflicting duplicates and ambiguous DST times, and report missing data accurately.

## Hosting your own copy

Any static host can serve `dist/`. For GitHub Pages:

1. Fork or push the repository to your account.
2. In Settings → Pages, choose GitHub Actions as the build source.
3. Push to `main` or run the Publish website workflow. It runs verification before deploying `dist/`.
4. For a custom domain, set it in Pages before adding a DNS CNAME pointing to `<your-account>.github.io`. Update `dist/CNAME`, canonical URLs, README links and guide repository links to your own addresses. Enable enforced HTTPS once GitHub provisions the certificate.
5. If using a project URL without a custom domain, remove `dist/CNAME` and update the canonical URLs. Local relative asset links also work under a repository subpath.

See [GitHub's custom-domain instructions](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).

Browser data does not transfer between website addresses. Export a private JSON backup from the old address and import it at the new one. The public deployment contains software and synthetic examples only.

## Reporting problems

Open an issue with the browser/Node version, the expected behavior and a small synthetic reproduction. Do not attach household exports or credentials. For a security issue, use the repository's private vulnerability reporting facility when available.
