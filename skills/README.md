# skills

Prompt packages that ship with hncode. Each skill is one directory containing a
**required** `SKILL.md`:

```
skills/
  frontend-design/
    SKILL.md
  review-pr/
    SKILL.md
```

`SKILL.md` is Markdown. An optional YAML front-matter block supplies the display name
and the description shown in `/skills`; the body is what gets injected into the
conversation when the skill is activated.

```markdown
---
name: frontend-design
description: Design front-ends with a consistent spacing and colour system
---

Always use a 4px spacing scale…
```

## Installing one

```
/skills                # lists installed skills + everything in this folder
/skills install <name> # downloads skills/<name>/SKILL.md as ~/.hncode/skills/<name>.md
/skills remove <name>  # deletes the local copy
```

The download is flattened on purpose: a skill is a single Markdown fragment, and
`~/.hncode/skills/<name>.md` is the layout the loader already understands.

## Contributing

1. Fork the repo and add `skills/<your-skill>/SKILL.md`.
2. Keep the directory name equal to the skill name — that is the name users type.
3. Add a `description` in the front-matter so `/skills` can explain what it does.
4. Open a PR.

Notes:

- The directory name is validated on install: a name containing `/`, `\` or a leading
  `.` is rejected, so keep it to plain words (`sql-review`, not `team/sql-review`).
- Anything other than `SKILL.md` in the directory is ignored — only that file is
  downloaded.
- These files are **not** published to npm (see the `files` field in `package.json`);
  they are fetched from this repository on demand.
