# Contributing to Neburyx

Thank you for helping. This file says what a change needs and how to sign it off. To report a
vulnerability, do not open an issue: follow [SECURITY.md](SECURITY.md).

Neburyx is licensed under Apache-2.0 (see [LICENSE](LICENSE)). A contribution is accepted under the
same licence.

## Sign off every commit (DCO)

Neburyx uses the Developer Certificate of Origin (DCO). It applies to contributions made by pull
request. There is no agreement to sign and no contributor licence agreement. Instead, every commit of
a pull request carries a line like this at the end of its message:

```text
Signed-off-by: Your Name <you@example.com>
```

The line says that you agree to the certificate below. Git writes it for you with `-s`, using the
`user.name` and `user.email` you have set:

```bash
git commit -s -m "Describe the change"
```

If a commit has no sign-off yet, add it to the last commit:

```bash
git commit --amend -s --no-edit
```

or to every commit of your branch since it left the base branch:

```bash
git rebase --signoff origin/main
```

After either, update your branch with `git push --force-with-lease`.

### How it is checked

The command `pnpm check:dco <base> <head>` lists every commit in `<base>..<head>` that has no
`Signed-off-by` line, and fails if there is one. A merge commit is skipped, and the commits it brings
in are checked. The pull-request job `dco` in `.github/workflows/ci.yml` runs it for the pull request.
You can run it yourself before you push, for example `pnpm check:dco origin/main HEAD`.

The check looks for the line, with a name and an email address, in the last paragraph of the message
(where `git commit -s` puts it). It does not verify who you are: the certificate is the promise you
make, and the line is the record of it.

### The certificate

```text
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

## What a change holds

- Build, type-check, lint and test as the Development section of [README.md](README.md) says, and add
  tests with the code, failure paths first.
- Write the code to [docs/coding-guidelines.md](docs/coding-guidelines.md).
- Keep a change small and focused: one concern per commit, with a plain-language message.
- Use synthetic data only. Never add data, code, screenshots or documents from an employer or a
  customer, a secret, or a `.docx` file.
- Add a dependency only if its licence is compatible with Apache-2.0, and say why it is needed.
