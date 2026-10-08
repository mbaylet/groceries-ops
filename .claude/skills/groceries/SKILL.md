---
name: groceries
description: >-
  Weekly groceries — household onboarding, meal planning from real recipes, ad-hoc items,
  purchase habits, filling the grocery store cart (never checkout). Use when the user wants to
  plan meals, add groceries, review buying habits, or check the grocery setup.
argument-hint: "[onboarding | plan | add <items> | note <item> | habits | setup]"
user-invocable: true
---

# groceries — router

Project root: walk up from this file to the directory containing `AGENTS.md` and `modes/`.
Resolve every path below against it. Follow `AGENTS.md` (hard rules, language rule) in every mode.

| Input | Read |
|---|---|
| (empty) | show the menu below |
| `onboarding` | `modes/onboarding.md` |
| `plan` | `modes/_cart.md` + `modes/plan.md` |
| `add` or a free-text list of items | `modes/_cart.md` + `modes/add.md` |
| `note <items>` | `modes/note.md` |
| `habits` | `modes/habits.md` |
| `setup` | `modes/setup.md` |

**Profile comes first.** Before any mode other than `onboarding`, run
`node scripts/doctor.ts --json --offline`. If `onboardingNeeded` is true, say in one line that the
profile must be created first and run `modes/onboarding.md` instead of the requested mode — no store
login, search or cart action happens before the profile exists. Resume the requested mode afterwards.

Before any mode: read `profile.yml` (if valid) and the active provider file
`providers/{store.provider}.yml`.

Menu (render in the user's language):

```
/groceries onboarding   build or update your household profile
/groceries plan         plan this week's meals and fill the cart
/groceries add <items>  add everyday items (toilet paper, bread…)
/groceries note <items> park something for the next cart (no product to choose now)
/groceries habits       see and edit what you buy regularly
/groceries setup        check the setup and store login
```
