---
name: groceries
description: >-
  Weekly groceries — household onboarding, meal planning from real recipes, ad-hoc items,
  purchase habits, filling the grocery store cart (never checkout). Use when the user wants to
  plan meals, add groceries, review buying habits, or check the grocery setup.
argument-hint: "[onboarding | plan | add <items> | habits | setup]"
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
| `habits` | `modes/habits.md` |
| `setup` | `modes/setup.md` |

Before any mode: read `profile.yml` (if valid) and the active provider file
`providers/{store.provider}.yml`.

Menu (render in the user's language):

```
/groceries onboarding   build or update your household profile
/groceries plan         plan this week's meals and fill the cart
/groceries add <items>  add everyday items (toilet paper, bread…)
/groceries habits       see and edit what you buy regularly
/groceries setup        check the setup and store login
```
