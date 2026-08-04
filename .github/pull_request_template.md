## What changed

<!-- One or two lines, in the reader's terms. The reader is you in six weeks. -->

## Why

<!-- The problem, not the patch. Link the issue if there is one. -->

## How to verify

<!-- Exact commands, or the URL plus the click path to reach the change. -->

```bash
npm ci
npx tsc --noEmit
npm run build
```

## Checks

- [ ] Typecheck and build pass locally, not only in CI
- [ ] Commits are authored as the Vercel account email — otherwise the deploy
      sits at `BLOCKED` with no build logs at all (see `CONTRIBUTING.md`)
- [ ] No keys, tokens or mnemonics in the diff, including inside example code

## Claims

- [ ] Nothing here asserts traction we do not have: no customer logos, no
      testimonials, no uptime or performance numbers we have not measured, no
      total that is not counted from something real
- [ ] Sample and placeholder data is labelled as sample **on screen**, not only
      in a code comment

## UI changes (delete this section if there are none)

- [ ] Real loading, empty and error states — not only the happy path
- [ ] Every changing figure carries `.tnum`, so columns do not jitter as they update
- [ ] Status is a coloured dot **and** a text label; never colour alone
- [ ] Record lists are tables with sortable headers carrying `aria-sort`
- [ ] Buttons name their action ("Create endpoint", not "Submit")
- [ ] Keyboard reachable, with a visible focus ring
