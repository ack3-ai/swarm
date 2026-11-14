# Audit scope

## In scope

- `src/Vault.sol`
- `src/libraries/Accounting.sol`

## Out of scope

- `lib/` (third-party dependencies)
- `test/`, `script/` and mocks

## Boundary notes

- `Vault` relies on the price feed in `src/oracle/`, which is out of scope. Report
  how `Vault` can be harmed by a stale or manipulated price, not bugs inside the feed.
- Known issue, do not report: deposits below 1 wei of shares round to zero.
