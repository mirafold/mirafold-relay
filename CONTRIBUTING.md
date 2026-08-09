# Contributing to Mirafold Relay

## Sign your commits (DCO)

This project uses the [Developer Certificate of Origin](https://developercertificate.org/)
(DCO) rather than a CLA: a one-line statement, per commit, that you have the
right to contribute the code under the project's MIT license. Add it with

```
git commit -s
```

which appends `Signed-off-by: Your Name <you@example.com>` to the commit
message. PRs with unsigned commits can't be merged.

## Before you open a PR

- Node ≥ 20.12, npm. `npm test` must pass — the suite pins the connection
  caps and the refusal codes, so a contract change fails loudly by design
  and should be deliberate, never incidental.
- The relay stays deliberately dumb: an end-to-end-blind forwarder that
  never parses frame plaintext and persists nothing. PRs that make it
  smarter about user content will be declined on principle — that
  blindness is the product's security story, not an implementation detail.

Security issues: don't open a public issue — see [SECURITY.md](SECURITY.md).
