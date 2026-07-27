# Security Policy

## Reporting a vulnerability

Email **security@mirafold.com**. Please don't open a public issue for
anything you believe is exploitable — email first, and we'll coordinate
disclosure timing with you.

You'll get an acknowledgment within 7 days. There is no bug bounty; fixes
credit the reporter in release notes unless you'd rather not be named.

## Supported versions

The deployed hosted instance and the latest tagged release only.

## What's most worth your attention

The relay is end-to-end blind by design: every frame it forwards is
AES-256-GCM ciphertext, and the relay never holds a key. Reports that break
that property — anything that lets the relay (or someone positioned at it)
read, forge, or replay session plaintext — are the highest-value reports.
Metadata exposure (IPs, pairing identifiers, timing, byte counts) is a real
surface too, and reports about it are welcome. What the relay logs is the
exhaustive list in the README's logging section — aggregate connection
counts, durations, and byte totals; never client IPs, never pairing ids,
never payloads (a test pins this). A report that shows an IP, a pairing id,
or frame content reaching the logs — or any metadata leaving the process by
a path the README doesn't list — counts as a bug.
