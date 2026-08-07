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

## Make a machine current

`install.sh` is the one command for a new machine and for an update. It renders
the units again, it installs the dashboard, and it builds the source only when
the build is not current.

```bash
git pull
T3CODE_INSTANCE=production ./install.sh
```

Each path has one blast radius. Keep it that way.

| Command | It restarts |
| --- | --- |
| `refresh-dashboard.sh` | the dashboard |
| `units.sh` | the dashboard |
| `install.sh` | the dashboard, and T3 Code only after a build |

Do not add a step to a path that changes a different group of parts. A user who
runs `units.sh` must not lose the sessions in the console.

The units must give the directory of `mise` in the PATH, when the machine has
`mise`. The npm shim calls `mise reshim` after a global install. Without `mise`
on the path, the call fails with code 127. The deploy job then fails, and each
update of a provider CLI in the console fails. Test a change to a unit PATH
with the real environment:

```bash
env -i HOME=$HOME PATH="<the PATH of the unit>" npm uninstall -g no-such-package
```

The exit code must be 0.

The buttons in the dashboard follow the same rule. The jobs are `main`,
`merge-deploy`, `merge-dev`, `promote`, `build`, and `deploy`. Each job moves
one thing. Do not make a job that chains them, and do not add a merge to a job
that builds.

## Protect the production instance

The scripts that make changes need an instance name. Give the name in
`T3CODE_INSTANCE`. The production instance also needs your approval.

Do not stop the production dashboard to test a change. Start a second instance
on a different port. `lib/guard.sh` refuses the production instance name, the
production ports, and the production worktree.

Always give a temporary directory in `T3CODE_HOME` and in `T3CODE_STATE_DIR`
for a test instance. `T3CODE_HOME` has a default of `~/.t3`, which is the data
directory of production. A test instance with that default makes a proxy
session against the production server. T3 Code then revokes the session of the
production dashboard, and the console gives an HTTP 403 to each user.

```bash
T3CODE_DASH_PORT=5126 \
T3CODE_HOME="$(mktemp -d)" \
T3CODE_STATE_DIR="$(mktemp -d)" \
T3CODE_UNIT= \
node src/t3code-dashboard.mjs
```

Do not run `install.sh` for the production instance to test a change. That
command stops T3 Code and each session in it.

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
