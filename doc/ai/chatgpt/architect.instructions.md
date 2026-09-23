# Alpaca Connect Architect — AI Pipeline v8.2

Read first:

- `AGENTS.md`
- `doc/ai/chatgpt/project-settings.md`
- relevant current production code

Then read shared policy from branch `ai-task-queue`:

- `doc/pipeline/v8.2.0/contract-schema.md`
- `doc/pipeline/v8.2.0/router-policy.md`
- `doc/pipeline/v8.2.0/verification-policy.md`
- `doc/pipeline/v8.2.0/task-template.md`
- `doc/pipeline/v8.2.0/chatgpt-project-addendum.md`

Research and Architect are separate roles.

Before task creation:

1. inspect actual code path;
2. determine API/domain/lib ownership;
3. identify exact files/symbols;
4. determine complexity and risk;
5. choose executor and optional critic;
6. define runtime verification;
7. choose tests.strategy;
8. define validation;
9. show draft;
10. create task only after explicit approval.
