# Instructions for agents

This file gives the rules for an agent that works in this repository.

## Write in Simplified Technical English

Write all documentation, all code comments, and all text on the screen in
ASD-STE100 Simplified Technical English. This rule applies to `README.md`, to
this file, to the comments in the shell scripts, to the comments in the
JavaScript, and to the text of the dashboard page.

These are the rules that apply most often:

- Write short sentences. Use a maximum of 20 words in an instruction. Use a
  maximum of 25 words in a description.
- Give one instruction in one sentence.
- Use the active voice. Write "the dashboard starts the runner", and not "the
  runner is started by the dashboard".
- Use the present tense.
- Start an instruction with the verb.
- Use one word for one meaning. Do not use a different word for the same thing.
- Use the articles `a` and `the`.
- Do not use more than three nouns together.
- Write a maximum of six sentences in a paragraph.
- Do not use contractions. Write "do not", and not "don't".
- Write "must" for a requirement. Do not write "should" or "could".
- Explain the reason for a decision. Write "Thus", "Because", or "If you do
  not" to give the result.

Do not use a dash or a semicolon to join two thoughts. Make two sentences.

## Test the dashboard in a browser

Do not approve a change to the dashboard page from the source alone. Start the
shell and test the page in a browser:

```bash
./dev.sh          # the dashboard at http://<tailscale-ip>:5124/dashboard
./dev.sh check    # the end-to-end tests
```

Measure the result. Read `scrollHeight`, `clientHeight`, and the computed
styles. Do not decide from a screenshot alone. A layout fault can have a cause
that you cannot see, and a guess costs more time than a measurement.

Playwright is in the npx cache, and not in this repository. This repository has
no `package.json` and no `node_modules`.

## Protect the production instance

The scripts that make changes need an instance name. Give the name in
`T3CODE_INSTANCE`. The production instance also needs your approval.

Do not stop the production dashboard to test a change. Start a second instance
on a different port. `lib/guard.sh` refuses the production instance name, the
production ports, and the production worktree.

## Keep the two proxy backends separate

The dashboard proxies two backends. The deploy build is one backend. The dev
runner is the other backend. Each backend has its own data directory and its
own credentials.

If you add a command that speaks to T3 Code, give it the data directory of the
correct backend with `--base-dir`. A credential from one backend gives an HTTP
401 on the other backend.

## Files

| File | Function |
| --- | --- |
| `dev.sh` | Runs the dashboard shell with the stub. |
| `check.sh` | Tests one instance. |
| `install.sh` | Installs one instance. |
| `lib/guard.sh` | Protects the production instance. |
| `src/t3code-dashboard.mjs` | The dashboard, the proxy, and the page. |
| `src/dev-stub-t3.mjs` | The substitute for T3 Code, for `./dev.sh`. |
| `systemd/*.in` | The templates for the units. |
