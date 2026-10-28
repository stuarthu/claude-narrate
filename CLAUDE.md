# claude-narrate

- Read `CONSTRAINTS.md` before you change anything. Never weaken a rule there to make a
  change pass. If a rule blocks you, say so and stop.
- `SPEC.md` is the spec; `tasks/plan.md` is the task list. The requirements document
  (`~/claude-skill-requirements.md`) is the source of truth for every number.
- Plain English in every comment, doc and README string. Short sentences. Explain a
  technical term the first time it appears.
- Plain ESM `.mjs`, no build step, no type annotations.
- Never put a literal NUL byte in a source file.
- Model-written text never reaches a shell. Spawn with an argv array.
